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
                const review = JSON.parse(raw) as AdmissionReview;
                const admissionRequest = review.request;
                if (!admissionRequest?.uid) {
                    send(400, { message: 'AdmissionReview has no request.uid' });
                    return;
                }

                const result = await validator.review(admissionRequest);
                if (!result.allowed) {
                    logger.info('Rejected an object at admission', {
                        kind: admissionRequest.kind?.kind,
                        resource: `${admissionRequest.namespace}/${admissionRequest.name}`,
                        reason: result.status?.message,
                    });
                }
                send(200, toReview(result));
            })
            .catch((error) => {
                // A webhook that returns a malformed response makes every apply
                // fail with an opaque error. Answer with a well-formed denial
                // instead, so the message reaches whoever ran kubectl.
                logger.error('Admission review failed', { error });
                send(
                    200,
                    toReview(deny('', 'the admission webhook failed to process the request')),
                );
            });
    };
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
