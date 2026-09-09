/**
 * The webhook's HTTP behaviour, over plain http so no certificate is needed.
 *
 * The response shape matters more than it looks: the API server matches on
 * `response.uid`, and a malformed body makes every `kubectl apply` of a Hetzner
 * resource fail with an opaque error rather than the real reason.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequestHandler } from '../../src/admission/handler.js';
import { allow, deny } from '../../src/admission/review.js';
import type { Validator } from '../../src/admission/validator.js';
import { nullLogger } from '../../src/observability/logger.js';

let server: Server;
let url: string;

/** A validator that allows everything except a kind named "Rejected". */
const validator: Validator = {
    review: async (request) =>
        request.kind?.kind === 'Rejected'
            ? deny(request.uid, 'no thank you')
            : allow(request.uid, request.kind?.kind === 'Warned' ? ['heads up'] : []),
};

beforeEach(async () => {
    server = createServer(
        createRequestHandler({ validator, logger: nullLogger, maxBodyBytes: 512 }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
    await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
    });
});

function review(kind: string, uid = 'review-1') {
    return {
        apiVersion: 'admission.k8s.io/v1',
        kind: 'AdmissionReview',
        request: {
            uid,
            kind: { group: 'hcloud.shebanglabs.io', version: 'v1alpha1', kind },
            namespace: 'default',
            name: 'example',
            operation: 'CREATE',
            object: { spec: {} },
        },
    };
}

async function post(body: unknown, path = '/validate') {
    const response = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
}

describe('the admission request handler', () => {
    it('answers an allowed review in the AdmissionReview envelope', async () => {
        const { status, body } = await post(review('HetznerServer'));

        expect(status).toBe(200);
        expect(body).toEqual({
            apiVersion: 'admission.k8s.io/v1',
            kind: 'AdmissionReview',
            response: { uid: 'review-1', allowed: true },
        });
    });

    it('echoes the uid the API server sent, which it matches on', async () => {
        const { body } = await post(review('HetznerServer', 'abc-999'));

        expect(body.response.uid).toBe('abc-999');
    });

    it('passes warnings through', async () => {
        const { body } = await post(review('Warned'));

        expect(body.response).toMatchObject({ allowed: true, warnings: ['heads up'] });
    });

    it('answers a denial with 200 and allowed=false, not an HTTP error', async () => {
        // A non-200 is a webhook *failure*, which the failurePolicy turns into
        // a generic error. A denial has to be a successful response.
        const { status, body } = await post(review('Rejected'));

        expect(status).toBe(200);
        expect(body.response).toMatchObject({
            allowed: false,
            status: { code: 422, message: 'no thank you' },
        });
    });

    it('404s any path but /validate', async () => {
        expect((await post(review('HetznerServer'), '/')).status).toBe(404);
        expect((await post(review('HetznerServer'), '/mutate')).status).toBe(404);
    });

    it('404s a GET, which is never how the API server calls a webhook', async () => {
        const response = await fetch(`${url}/validate`);
        expect(response.status).toBe(404);
    });

    it('rejects a review with no request.uid', async () => {
        const { status } = await post({
            apiVersion: 'admission.k8s.io/v1',
            kind: 'AdmissionReview',
        });

        expect(status).toBe(400);
    });

    it('answers malformed JSON with a plain 400', async () => {
        // There is no uid to echo, and the API server drops a response whose
        // uid does not match anyway; a 400 at least names the problem.
        const { status, body } = await post('{not json');

        expect(status).toBe(400);
        expect(body.message).toMatch(/not valid JSON/);
    });

    it.each(['null', '42', '"text"'])('400s a JSON body that is not an object: %s', async (raw) => {
        const { status } = await post(raw);

        expect(status).toBe(400);
    });

    it('refuses an oversized body rather than buffering it', async () => {
        const padded = {
            ...review('HetznerServer'),
            padding: 'x'.repeat(2_000),
        };

        const { status, body } = await post(padded);

        expect(status).toBe(400);
        expect(body.message).toMatch(/exceeds 512 bytes/);
    });

    it('answers a validator that throws with a denial, not a crash', async () => {
        const crashing = createServer(
            createRequestHandler({
                validator: {
                    review: async () => {
                        throw new Error('boom');
                    },
                },
                logger: nullLogger,
            }),
        );
        await new Promise<void>((resolve) => crashing.listen(0, '127.0.0.1', resolve));
        const crashingUrl = `http://127.0.0.1:${(crashing.address() as AddressInfo).port}/validate`;

        const response = await fetch(crashingUrl, {
            method: 'POST',
            body: JSON.stringify(review('HetznerServer')),
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.response.allowed).toBe(false);
        // Without the uid the API server discards the denial and the user sees
        // an opaque error instead of this message.
        expect(body.response.uid).toBe('review-1');
        expect(body.response.status.message).toMatch(/failed to process/);

        crashing.closeAllConnections?.();
        await new Promise<void>((resolve) => crashing.close(() => resolve()));
    });
});
