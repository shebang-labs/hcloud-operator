/**
 * The assembled client. Small, but it is the wiring the whole operator depends
 * on: a missing endpoint group here is a runtime crash on the first reconcile
 * of that kind.
 */

import { describe, expect, it } from 'vitest';
import { createHetznerCloud } from '../../src/hcloud/index.js';
import { createMetrics } from '../../src/observability/metrics.js';

describe('createHetznerCloud', () => {
    const hcloud = createHetznerCloud({
        token: 'token',
        baseUrl: 'https://api.hetzner.cloud/v1',
        requestsPerHour: 1_200,
        metrics: createMetrics(),
    });

    it('exposes every endpoint group the adapters use', () => {
        for (const group of [
            'servers',
            'sshKeys',
            'volumes',
            'networks',
            'firewalls',
            'loadBalancers',
            'floatingIps',
            'primaryIps',
            'placementGroups',
            'certificates',
            'images',
            'catalog',
        ] as const) {
            expect(hcloud[group], group).toBeDefined();
        }
    });

    it('shares one rate limiter across every group, sized from the config', () => {
        // Per-group limiters would let eleven controllers spend eleven budgets.
        expect(hcloud.rateLimiter).toBeDefined();
        expect(hcloud.rateLimiter.available).toBe(20); // 1200/hour is 20/minute.
    });
});
