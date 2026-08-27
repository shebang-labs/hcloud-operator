/**
 * Reading a Secret is the one place a private key passes through the operator.
 * It is decoded, handed to Hetzner, and never stored — so the tests here are
 * about the decoding being right and a missing key being an answer rather than
 * a crash.
 */

import { ApiException, type CoreV1Api } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';
import { createSecretReader } from '../../src/kube/secrets.js';

function fakeCore(secret?: { data?: Record<string, string> }) {
    const reads: Array<{ name: string; namespace: string }> = [];
    const api = {
        async readNamespacedSecret(args: { name: string; namespace: string }) {
            reads.push(args);
            if (!secret) {
                throw new ApiException(404, 'not found', '', {});
            }
            return secret;
        },
    } as unknown as CoreV1Api;
    return { api, reads };
}

const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64');

describe('createSecretReader', () => {
    it('decodes the base64 the API server returns', async () => {
        const { api } = fakeCore({ data: { 'tls.key': encode('-----BEGIN PRIVATE KEY-----') } });

        const value = await createSecretReader(api).read('default', {
            name: 'tls',
            key: 'tls.key',
        });

        expect(value).toBe('-----BEGIN PRIVATE KEY-----');
    });

    it('handles multi-line PEM material without mangling it', async () => {
        const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
        const { api } = fakeCore({ data: { 'tls.crt': encode(pem) } });

        expect(await createSecretReader(api).read('default', { name: 'tls', key: 'tls.crt' })).toBe(
            pem,
        );
    });

    it('returns null for a missing Secret', async () => {
        const { api } = fakeCore(undefined);

        expect(
            await createSecretReader(api).read('default', { name: 'gone', key: 'k' }),
        ).toBeNull();
    });

    it('returns null for a Secret that lacks the key', async () => {
        const { api } = fakeCore({ data: { 'tls.crt': encode('chain') } });

        expect(
            await createSecretReader(api).read('default', { name: 'tls', key: 'tls.key' }),
        ).toBeNull();
    });

    it('returns null for a Secret with no data at all', async () => {
        const { api } = fakeCore({});

        expect(await createSecretReader(api).read('default', { name: 'tls', key: 'k' })).toBeNull();
    });

    it('reads from the referring object’s namespace by default', async () => {
        const { api, reads } = fakeCore({ data: {} });

        await createSecretReader(api).read('demo', { name: 'tls', key: 'k' });

        expect(reads[0]).toEqual({ name: 'tls', namespace: 'demo' });
    });

    it('honours an explicit namespace on the reference', async () => {
        const { api, reads } = fakeCore({ data: {} });

        await createSecretReader(api).read('default', {
            name: 'tls',
            key: 'k',
            namespace: 'shared',
        });

        expect(reads[0]?.namespace).toBe('shared');
    });

    it('lets a real API failure through rather than hiding it as "absent"', async () => {
        const api = {
            async readNamespacedSecret() {
                throw new ApiException(403, 'forbidden', '', {});
            },
        } as unknown as CoreV1Api;

        await expect(
            createSecretReader(api).read('default', { name: 'tls', key: 'k' }),
        ).rejects.toThrow();
    });
});
