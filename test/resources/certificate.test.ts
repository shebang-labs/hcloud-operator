/**
 * Certificates are the only kind that reads a Kubernetes Secret, and the only
 * one whose creation can fail minutes later for reasons outside the cluster
 * (DNS not pointing at Hetzner). Both properties get their own tests: the
 * private key must never surface anywhere, and a pending or failed issuance
 * must show up as a condition rather than as a silent success.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { SecretReader } from '../../src/kube/secrets.js';
import {
    createCertificateAdapter,
    type HetznerCertificateSpec,
} from '../../src/resources/certificate.js';
import { buildResource } from '../support/fake-store.js';
import { createHarness, type Harness, type KindHarness } from '../support/harness.js';

const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----very-secret-material';

/** A Secret reader backed by a plain map. */
function secretReader(data: Record<string, string> = {}): SecretReader {
    return { read: async (_namespace, ref) => data[ref.key] ?? null };
}

function certificate(spec: Partial<HetznerCertificateSpec> = {}, options = {}) {
    return buildResource<HetznerCertificateSpec, never>('HetznerCertificate', { ...spec }, options);
}

let harness: Harness;

beforeEach(() => {
    harness = createHarness();
});

function register(secrets: SecretReader): KindHarness {
    return harness.register(createCertificateAdapter(harness.hcloud.certificates, secrets));
}

const only = () => harness.api.all('certificates')[0] as Record<string, unknown>;

describe('validation', () => {
    it('requires a secretRef for an uploaded certificate', async () => {
        const certificates = register(secretReader());
        const resource = certificate({ type: 'uploaded' });

        await certificates.once(resource);

        expect(resource.status?.message).toMatch(/secretRef.name is required/);
    });

    it('requires domainNames for a managed certificate', async () => {
        const certificates = register(secretReader());
        const resource = certificate({ type: 'managed' });

        await certificates.once(resource);

        expect(resource.status?.message).toMatch(/domainNames is required/);
    });

    it('rejects an unknown type', async () => {
        const certificates = register(secretReader());
        const resource = certificate({ type: 'self-signed' as never });

        await certificates.once(resource);

        expect(resource.status?.message).toMatch(/"uploaded" or "managed"/);
    });
});

describe('uploaded certificates', () => {
    const secrets = () =>
        secretReader({ 'tls.crt': '-----BEGIN CERTIFICATE-----chain', 'tls.key': PRIVATE_KEY });

    it('reads the PEM material from the Secret and is Ready immediately', async () => {
        const certificates = register(secrets());
        const resource = certificate({ type: 'uploaded', secretRef: { name: 'tls' } });

        await certificates.settle(resource);

        expect(harness.api.lastBody('POST /certificates')).toMatchObject({
            type: 'uploaded',
            private_key: PRIVATE_KEY,
        });
        expect(resource.status?.phase).toBe('Ready');
    });

    it('never writes the private key into status', async () => {
        const certificates = register(secrets());
        const resource = certificate({ type: 'uploaded', secretRef: { name: 'tls' } });

        await certificates.settle(resource);

        expect(JSON.stringify(resource.status)).not.toContain('very-secret-material');
    });

    it('honours custom key names in the Secret', async () => {
        const certificates = register(
            secretReader({ 'chain.pem': 'chain', 'key.pem': PRIVATE_KEY }),
        );
        const resource = certificate({
            type: 'uploaded',
            secretRef: { name: 'tls', certificateKey: 'chain.pem', privateKeyKey: 'key.pem' },
        });

        await certificates.settle(resource);

        expect(harness.api.lastBody('POST /certificates')).toMatchObject({ certificate: 'chain' });
    });

    it('says which key is missing rather than sending an empty certificate', async () => {
        const certificates = register(secretReader({ 'tls.crt': 'chain' }));
        const resource = certificate({ type: 'uploaded', secretRef: { name: 'tls' } });

        await expect(certificates.once(resource)).rejects.toThrow(/no key "tls.key"/);
        expect(harness.api.all('certificates')).toHaveLength(0);
    });

    it('does not try to converge the material, which Hetzner cannot replace', async () => {
        const certificates = register(secrets());
        const resource = certificate({ type: 'uploaded', secretRef: { name: 'tls' } });
        await certificates.settle(resource);
        harness.api.reset();

        await certificates.settle(resource);

        expect(harness.api.countRequests('POST /certificates/')).toBe(0);
    });
});

describe('managed certificates', () => {
    it('is not Ready while Hetzner is still obtaining it', async () => {
        const certificates = register(secretReader());
        const resource = certificate({ type: 'managed', domainNames: ['example.com'] });

        const result = await certificates.once(resource);

        expect(resource.status?.issuanceStatus).toBe('pending');
        expect(resource.status?.phase).toBe('Creating');
        expect(result.requeueAfterMs).toBeGreaterThan(0);
    });

    it('becomes Ready once issuance completes', async () => {
        const certificates = register(secretReader());
        const resource = certificate({ type: 'managed', domainNames: ['example.com'] });
        await certificates.once(resource);

        only().status = { issuance: 'completed', renewal: 'scheduled', error: null };
        await certificates.settle(resource);

        expect(resource.status).toMatchObject({
            phase: 'Ready',
            issuanceStatus: 'completed',
            renewalStatus: 'scheduled',
        });
        expect(resource.status?.notValidAfter).toBeTruthy();
    });

    it('surfaces a failed issuance with Hetzner’s own reason', async () => {
        const certificates = register(secretReader());
        const resource = certificate({ type: 'managed', domainNames: ['example.com'] });
        await certificates.once(resource);

        only().status = {
            issuance: 'failed',
            renewal: 'unavailable',
            error: { code: 'dns_error', message: 'the domain does not resolve here' },
        };
        await certificates.once(resource);

        // Reported before anything is retried, so the reason is not lost.
        expect(resource.status?.message).toMatch(/does not resolve here/);
        expect(resource.status?.issuanceStatus).toBe('failed');
    });

    it('asks Hetzner to retry a failed issuance, at the resync rate', async () => {
        const certificates = register(secretReader());
        const resource = certificate({ type: 'managed', domainNames: ['example.com'] });
        await certificates.once(resource);
        const id = resource.status?.id;

        only().status = {
            issuance: 'failed',
            renewal: 'unavailable',
            error: { code: 'dns_error', message: 'nope' },
        };

        // First pass reports the failure without retrying, so the reason reaches
        // the user; only the pass after that asks Hetzner to try again.
        await certificates.once(resource);
        harness.api.reset();
        only().status = {
            issuance: 'failed',
            renewal: 'unavailable',
            error: { code: 'dns_error', message: 'nope' },
        };
        await certificates.once(resource);

        expect(harness.api.countRequests(`POST /certificates/${id}/actions/retry`)).toBe(1);
    });

    it('reports a domain change it cannot apply', async () => {
        const certificates = register(secretReader());
        const resource = certificate({ type: 'managed', domainNames: ['example.com'] });
        await certificates.once(resource);
        only().status = { issuance: 'completed', renewal: 'scheduled', error: null };
        await certificates.settle(resource);

        resource.spec.domainNames = ['other.example'];
        await certificates.once(resource);

        expect(resource.status?.message).toMatch(/cannot be re-issued in place/);
    });

    it('counts the load balancers using it', async () => {
        const certificates = register(secretReader());
        const resource = certificate({ type: 'managed', domainNames: ['example.com'] });
        await certificates.once(resource);

        only().status = { issuance: 'completed', renewal: 'scheduled', error: null };
        only().used_by = [{ id: 1, type: 'load_balancer' }];
        await certificates.settle(resource);

        expect(resource.status?.usedByCount).toBe(1);
    });
});
