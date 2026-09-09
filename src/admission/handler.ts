/**
 * The webhook's request handling, separated from its TLS server.
 *
 * Kubernetes only calls a webhook over HTTPS, and a certificate is awkward to
 * conjure in a unit test. All the behaviour worth testing — routing, body
 * limits, malformed input, the shape of the response — is transport-agnostic,
 * so it lives here and `server.ts` is left as the thin TLS wrapper around it.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '../observability/logger.js';
import { type AdmissionReview, deny, toReview } from './review.js';
import type { Validator } from './validator.js';

/** Refuse a body larger than this rather than buffering it. */
export const MAX_BODY_BYTES = 1024 * 1024;

export interface HandlerOptions {
    validator: Validator;
    logger: Logger;
    maxBodyBytes?: number;
}

export type RequestHandler = (request: IncomingMessage, response: ServerResponse) => void;

export function createRequestHandler(options: HandlerOptions): RequestHandler {
    const { validator, logger } = options;
    const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;

    return (request, response) => {
        const path = (request.url ?? '/').split('?')[0];

        const send = (status: number, body: unknown): void => {
            const payload = JSON.stringify(body);
            response.writeHead(status, {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            });
            response.end(payload);
        };

        if (request.method !== 'POST' || path !== '/validate') {
            send(404, { message: 'not found' });
            return;
        }

        void readBody(request, maxBodyBytes)
            .then(async (raw) => {
                // The API server matches the response on `request.uid` and
                // discards one that does not echo it, so the uid is pinned down
                // before anything that can fail. Without a parseable body there
                // is no uid to echo and no well-formed answer is possible; a
                // plain 400 at least names the problem in the API server's log.
                const admissionRequest = parseReview(raw)?.request;
                if (!admissionRequest) {
                    send(400, { message: 'request body is not valid JSON for an AdmissionReview' });
                    return;
                }
                if (!admissionRequest.uid) {
                    send(400, { message: 'AdmissionReview has no request.uid' });
                    return;
                }

                try {
                    const result = await validator.review(admissionRequest);
                    if (!result.allowed) {
                        logger.info('Rejected an object at admission', {
                            kind: admissionRequest.kind?.kind,
                            resource: `${admissionRequest.namespace}/${admissionRequest.name}`,
                            reason: result.status?.message,
                        });
                    }
                    send(200, toReview(result));
                } catch (error) {
                    // A webhook that returns a malformed response makes every
                    // apply fail with an opaque error. Answer with a well-formed
                    // denial carrying the uid instead, so the message reaches
                    // whoever ran kubectl.
                    logger.error('Admission review failed', { error });
                    send(
                        200,
                        toReview(
                            deny(
                                admissionRequest.uid,
                                'the admission webhook failed to process the request',
                            ),
                        ),
                    );
                }
            })
            .catch((error: unknown) => {
                // The body never arrived intact (oversized, or the socket
                // failed), so there is no uid to answer with.
                logger.warn('Could not read an admission request body', { error });
                send(400, {
                    message: error instanceof Error ? error.message : 'could not read request body',
                });
            });
    };
}

/**
 * Parses the body as an AdmissionReview envelope, or returns null when it is
 * not JSON or not an object. `JSON.parse` happily returns `null` or a number,
 * which would otherwise blow up on the first property access.
 */
function parseReview(raw: string): AdmissionReview | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return null;
    }
    const review = parsed as AdmissionReview;
    return typeof review.request === 'object' && review.request !== null ? review : null;
}

/**
 * Buffers a request body, refusing anything oversized.
 *
 * On exceeding the limit it stops *storing* chunks but keeps draining the
 * socket, then rejects once the upload finishes. Destroying the connection
 * instead would be tidier for the server and useless for the client: the
 * response never arrives, and `kubectl apply` reports a transport error rather
 * than the reason.
 */
function readBody(request: IncomingMessage, limit: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;

        request.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) {
                tooLarge = true;
                chunks.length = 0;
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            if (tooLarge) {
                reject(new Error(`request body exceeds ${limit} bytes`));
                return;
            }
            resolve(Buffer.concat(chunks).toString('utf8'));
        });
        request.on('error', reject);
    });
}
