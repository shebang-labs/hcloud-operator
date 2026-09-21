/**
 * Admission validation.
 *
 * The point of the webhook is to turn a typo into a rejection at apply time,
 * with the valid alternatives in the message — instead of a condition on an
 * object nobody is watching. The one behaviour that matters more than that is
 * the failure mode: if Hetzner is unreachable, the webhook must get out of the
 * way rather than block every apply in the cluster.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { AdmissionRequest } from '../../src/admission/review.js';
import { createValidator, type Validator } from '../../src/admission/validator.js';
import { createActionTracker } from '../../src/hcloud/actions.js';
import { HetznerApiError } from '../../src/hcloud/errors.js';
import { assembleHetznerCloud, type HetznerCloud } from '../../src/hcloud/index.js';
import { RateLimiter } from '../../src/hcloud/rate-limiter.js';
import { nullLogger } from '../../src/observability/logger.js';
import { buildKinds } from '../../src/resources/index.js';
import { FakeHetznerApi } from '../support/fake-hcloud.js';

let api: FakeHetznerApi;
let hcloud: HetznerCloud;
let validator: Validator;

beforeEach(() => {
    api = new FakeHetznerApi();
    hcloud = assembleHetznerCloud({
        http: api,
        rateLimiter: new RateLimiter({ requestsPerHour: 3_600 }),
        actions: createActionTracker({ http: api, sleep: async () => undefined }),
    });
    const kinds = buildKinds({ hcloud, secrets: { read: async () => null } });
    validator = createValidator({
        adapters: new Map(kinds.map((kind) => [kind.descriptor.kind, kind.adapter])),
        catalog: hcloud.catalog,
        logger: nullLogger,
    });
});

function request(kind: string, spec: unknown, overrides: Partial<AdmissionRequest> = {}) {
    return {
        uid: 'review-1',
        kind: { group: 'hcloud.shebanglabs.io', version: 'v1alpha1', kind },
        namespace: 'default',
        name: 'example',
        operation: 'CREATE' as const,
        object: { metadata: { name: 'example', namespace: 'default' }, spec },
        ...overrides,
    };
}

const validServer = { serverType: 'cpx21', image: 'ubuntu-24.04', location: 'nbg1' };

describe('createValidator', () => {
    it('allows a valid spec', async () => {
        const response = await validator.review(request('HetznerServer', validServer));

        expect(response).toEqual({ uid: 'review-1', allowed: true });
    });

    it('echoes the review uid back, which the API server matches on', async () => {
        const response = await validator.review(
            request('HetznerServer', validServer, { uid: 'abc-999' }),
        );

        expect(response.uid).toBe('abc-999');
    });

    it('runs the adapter’s own validate, so the two can never disagree', async () => {
        const response = await validator.review(
            request('HetznerServer', { image: 'ubuntu-24.04', location: 'nbg1' }),
        );

        expect(response.allowed).toBe(false);
        expect(response.status?.message).toMatch(/spec.serverType is required/);
        expect(response.status?.code).toBe(422);
    });

    it('checks every entry of serverTypes, naming the one that is wrong', async () => {
        // A fallback entry is only reached when Hetzner is out of capacity, so
        // a typo there stays invisible until the one moment it has to work.
        const response = await validator.review(
            request('HetznerServer', {
                image: 'ubuntu-24.04',
                location: 'nbg1',
                serverTypes: ['cpx21', 'cpx99'],
            }),
        );

        expect(response.allowed).toBe(false);
        expect(response.status?.message).toMatch(/spec.serverTypes\[1\] "cpx99" does not exist/);
    });

    it('accepts a serverTypes list Hetzner has every entry of', async () => {
        const response = await validator.review(
            request('HetznerServer', {
                image: 'ubuntu-24.04',
                location: 'nbg1',
                serverTypes: ['cpx21', 'cx22'],
            }),
        );

        expect(response.allowed).toBe(true);
    });

    it('rejects a server type Hetzner does not have, and lists the ones it does', async () => {
        const response = await validator.review(
            request('HetznerServer', { ...validServer, serverType: 'cpx99' }),
        );

        expect(response.allowed).toBe(false);
        expect(response.status?.message).toMatch(/spec.serverType "cpx99" does not exist/);
        // Listing the alternatives is the point: otherwise the user has to go
        // and look them up in the Hetzner console.
        expect(response.status?.message).toMatch(/cpx21/);
    });

    it.each([
        [{ ...validServer, location: 'atlantis' }, /spec.location "atlantis"/],
        [
            { serverType: 'cpx21', image: 'ubuntu-24.04', datacenter: 'atlantis-dc1' },
            /spec.datacenter "atlantis-dc1"/,
        ],
        [{ ...validServer, image: 'temple-os' }, /spec.image "temple-os"/],
        [{ ...validServer, iso: 'not-an-iso' }, /spec.iso "not-an-iso"/],
    ])('rejects %o', async (spec, expected) => {
        const response = await validator.review(request('HetznerServer', spec));

        expect(response.allowed).toBe(false);
        expect(response.status?.message).toMatch(expected);
    });

    it('does not check a numeric image against the system catalog', async () => {
        // A number is a snapshot id, which the system image list does not carry.
        const response = await validator.review(
            request('HetznerServer', { ...validServer, image: '4711' }),
        );

        expect(response.allowed).toBe(true);
    });

    it('reports every catalog problem at once, not one per apply', async () => {
        const response = await validator.review(
            request('HetznerServer', {
                serverType: 'cpx99',
                image: 'temple-os',
                location: 'atlantis',
            }),
        );

        expect(response.status?.message).toMatch(/serverType/);
        expect(response.status?.message).toMatch(/image/);
        expect(response.status?.message).toMatch(/location/);
    });

    it('validates the other kinds too', async () => {
        const response = await validator.review(
            request('HetznerVolume', { size: 5, location: 'nbg1' }),
        );

        expect(response.allowed).toBe(false);
        expect(response.status?.message).toMatch(/at least 10/);
    });

    it('allows a kind it does not serve', async () => {
        const response = await validator.review(request('SomeoneElsesKind', { anything: true }));

        expect(response.allowed).toBe(true);
    });

    it('allows a request with no object, such as a delete', async () => {
        const response = await validator.review({
            uid: 'review-1',
            kind: { kind: 'HetznerServer' },
            operation: 'DELETE',
            object: null,
        });

        expect(response.allowed).toBe(true);
    });

    describe('on UPDATE', () => {
        // Hetzner retires server types and images from its catalog. An object
        // created with one must stay editable, or the only way to fix it is
        // to delete and recreate the server.
        const retired = { ...validServer, serverType: 'cx11' };

        function update(spec: unknown, oldSpec: unknown) {
            return request('HetznerServer', spec, {
                operation: 'UPDATE',
                oldObject: { spec: oldSpec },
            });
        }

        it('does not re-check a catalog field the update leaves alone', async () => {
            const response = await validator.review(update(retired, retired));

            expect(response).toEqual({ uid: 'review-1', allowed: true });
        });

        it('lets another field change next to a retired value', async () => {
            const response = await validator.review(
                update({ ...retired, location: 'fsn1' }, retired),
            );

            expect(response.allowed).toBe(true);
        });

        it('still checks a field whose value the update changes', async () => {
            const response = await validator.review(
                update({ ...validServer, serverType: 'cpx99' }, validServer),
            );

            expect(response.allowed).toBe(false);
            expect(response.status?.message).toMatch(/spec.serverType "cpx99" does not exist/);
        });

        it('does not re-check an unchanged serverTypes list', async () => {
            // Two parses of the same YAML are never the same array reference,
            // so comparing by identity would re-check the list on every edit
            // and make an object read-only once Hetzner retires an entry.
            const withList = { ...validServer, serverType: undefined, serverTypes: ['cx11'] };

            const response = await validator.review(
                update({ ...withList, serverTypes: ['cx11'] }, withList),
            );

            expect(response.allowed).toBe(true);
        });

        it('checks a catalog field the update adds', async () => {
            const response = await validator.review(
                update({ ...validServer, iso: 'not-an-iso' }, validServer),
            );

            expect(response.allowed).toBe(false);
            expect(response.status?.message).toMatch(/spec.iso "not-an-iso"/);
        });

        it('does not consult the catalog at all when no checked field changed', async () => {
            await validator.review(update({ ...retired, name: 'renamed' }, retired));

            expect(api.countRequests('GET /server_types')).toBe(0);
            expect(api.countRequests('GET /locations')).toBe(0);
        });

        it('still runs the adapter’s pure validation on every update', async () => {
            const response = await validator.review(
                update({ image: 'ubuntu-24.04', location: 'nbg1' }, retired),
            );

            expect(response.allowed).toBe(false);
            expect(response.status?.message).toMatch(/spec.serverType is required/);
        });

        it('checks everything when there is no old object to compare with', async () => {
            const response = await validator.review(
                request('HetznerServer', retired, { operation: 'UPDATE' }),
            );

            expect(response.allowed).toBe(false);
        });
    });

    it('checks every catalog field on CREATE, even one that was fine yesterday', async () => {
        const response = await validator.review(
            request('HetznerServer', { ...validServer, serverType: 'cx11' }),
        );

        expect(response.allowed).toBe(false);
    });

    it('gets out of the way when Hetzner is unreachable', async () => {
        api.failNext({
            match: 'GET /server_types',
            error: new HetznerApiError({
                status: 0,
                code: 'network_error',
                message: 'connect ETIMEDOUT',
                retryable: true,
            }),
            times: 10,
        });

        const response = await validator.review(request('HetznerServer', validServer));

        // Blocking every apply in the cluster because a third party is down
        // would be far worse than letting a typo through to a condition.
        expect(response.allowed).toBe(true);
        expect(response.warnings?.[0]).toMatch(/could not reach the Hetzner Cloud API/);
    });

    it('still rejects a structurally invalid spec while Hetzner is down', async () => {
        api.failNext({
            match: 'GET /server_types',
            error: new HetznerApiError({
                status: 0,
                code: 'network_error',
                message: 'down',
                retryable: true,
            }),
            times: 10,
        });

        const response = await validator.review(
            request('HetznerServer', { image: 'ubuntu-24.04' }),
        );

        // The adapter's validate() needs no network, so it still applies.
        expect(response.allowed).toBe(false);
    });
});
