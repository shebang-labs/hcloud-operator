/**
 * The registry is what turns eleven adapters into an operator. These checks
 * catch the mistakes that are otherwise invisible until a cluster rejects the
 * manifests: a duplicated plural, a short name that collides, or a kind that
 * exists in code but has no CRD.
 */

import { describe, expect, it } from 'vitest';
import { createActionTracker } from '../../src/hcloud/actions.js';
import { assembleHetznerCloud } from '../../src/hcloud/index.js';
import { RateLimiter } from '../../src/hcloud/rate-limiter.js';
import { GROUP } from '../../src/kube/api.js';
import { buildKinds } from '../../src/resources/index.js';
import { FakeHetznerApi } from '../support/fake-hcloud.js';

function kinds() {
    const api = new FakeHetznerApi();
    const hcloud = assembleHetznerCloud({
        http: api,
        rateLimiter: new RateLimiter({ requestsPerHour: 3_600 }),
        actions: createActionTracker({ http: api, sleep: async () => undefined }),
    });
    return buildKinds({ hcloud, secrets: { read: async () => null } });
}

describe('buildKinds', () => {
    it('registers every Hetzner resource the operator manages', () => {
        expect(
            kinds()
                .map((kind) => kind.descriptor.kind)
                .sort(),
        ).toEqual([
            'HetznerCertificate',
            'HetznerFirewall',
            'HetznerFloatingIP',
            'HetznerImage',
            'HetznerLoadBalancer',
            'HetznerNetwork',
            'HetznerPlacementGroup',
            'HetznerPrimaryIP',
            'HetznerSSHKey',
            'HetznerServer',
            'HetznerVolume',
        ]);
    });

    it('gives every kind a unique plural and short name', () => {
        const registered = kinds();
        const plurals = registered.map((kind) => kind.descriptor.plural);
        const shortNames = registered.map((kind) => kind.descriptor.shortName);

        expect(new Set(plurals).size).toBe(plurals.length);
        expect(new Set(shortNames).size).toBe(shortNames.length);
    });

    it('uses lower-case plurals, as the Kubernetes API requires', () => {
        for (const kind of kinds()) {
            expect(kind.descriptor.plural).toBe(kind.descriptor.plural.toLowerCase());
            expect(kind.descriptor.plural).toMatch(/^[a-z]+$/);
        }
    });

    it('leaves the group and version to the shared defaults', () => {
        // A kind that pinned its own group would silently escape the CRDs and
        // the RBAC rules, both of which are written against one group.
        for (const kind of kinds()) {
            expect(kind.descriptor.group ?? GROUP).toBe(GROUP);
        }
    });
});
