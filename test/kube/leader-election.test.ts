/**
 * Leader election exists so two replicas of an operator that creates paid
 * infrastructure cannot both act on the same object. These tests drive it
 * against a small in-memory Lease API, with the clock and sleep injected so
 * they run instantly.
 */

import type { CoordinationV1Api, V1Lease } from '@kubernetes/client-node';
import { ApiException } from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';
import { createLeaderElector } from '../../src/kube/leader-election.js';
import { nullLogger } from '../../src/observability/logger.js';

/** Just enough of the Lease API to run the algorithm. */
function leaseApi(initial?: V1Lease) {
    let lease = initial;
    let version = 1;
    const writes: V1Lease[] = [];

    const api = {
        async readNamespacedLease() {
            if (!lease) {
                throw new ApiException(404, 'not found', '', {});
            }
            return lease;
        },
        async createNamespacedLease({ body }: { body: V1Lease }) {
            if (lease) {
                throw new ApiException(409, 'conflict', '', {});
            }
            version += 1;
            lease = { ...body, metadata: { ...body.metadata, resourceVersion: String(version) } };
            writes.push(lease);
            return lease;
        },
        async replaceNamespacedLease({ body }: { body: V1Lease }) {
            if (
                body.metadata?.resourceVersion &&
                body.metadata.resourceVersion !== lease?.metadata?.resourceVersion
            ) {
                throw new ApiException(409, 'conflict', '', {});
            }
            version += 1;
            lease = { ...body, metadata: { ...body.metadata, resourceVersion: String(version) } };
            writes.push(lease);
            return lease;
        },
    } as unknown as CoordinationV1Api;

    return {
        api,
        writes,
        get current() {
            return lease;
        },
        set current(value: V1Lease | undefined) {
            lease = value;
        },
    };
}

function makeElector(
    store: ReturnType<typeof leaseApi>,
    overrides: Partial<Parameters<typeof createLeaderElector>[0]> = {},
) {
    let now = new Date('2026-01-01T00:00:00Z');
    const onStartedLeading = vi.fn();
    const onStoppedLeading = vi.fn();

    const elector = createLeaderElector({
        coordination: store.api,
        namespace: 'hetzner-server-controller',
        leaseName: 'hetzner-server-controller',
        identity: 'operator-a',
        leaseDurationMs: 15_000,
        logger: nullLogger,
        onStartedLeading,
        onStoppedLeading,
        now: () => now,
        sleep: async (ms) => {
            now = new Date(now.getTime() + ms);
        },
        ...overrides,
    });

    return {
        elector,
        onStartedLeading,
        onStoppedLeading,
        advance: (ms: number) => {
            now = new Date(now.getTime() + ms);
        },
    };
}

describe('createLeaderElector', () => {
    it('creates the lease and starts leading when nobody holds it', async () => {
        const store = leaseApi();
        const { elector, onStartedLeading } = makeElector(store);

        // run() keeps renewing forever; release after the first renewal.
        onStartedLeading.mockImplementation(() => {
            void elector.release();
        });
        await elector.run();

        expect(onStartedLeading).toHaveBeenCalledOnce();
        expect(store.writes[0]?.spec?.holderIdentity).toBe('operator-a');
    });

    it('takes over a lease whose holder stopped renewing', async () => {
        const store = leaseApi({
            metadata: { name: 'hetzner-server-controller', resourceVersion: '1' },
            spec: {
                holderIdentity: 'operator-b',
                leaseDurationSeconds: 15,
                renewTime: new Date('2025-12-31T23:00:00Z'),
                leaseTransitions: 3,
            },
        });
        const { elector, onStartedLeading } = makeElector(store);
        onStartedLeading.mockImplementation(() => {
            void elector.release();
        });

        await elector.run();

        expect(onStartedLeading).toHaveBeenCalledOnce();
        // A change of holder counts as a transition.
        expect(store.current?.spec?.leaseTransitions).toBe(4);
    });

    it('waits while another replica is renewing, and never starts leading', async () => {
        const store = leaseApi({
            metadata: { name: 'hetzner-server-controller', resourceVersion: '1' },
            spec: {
                holderIdentity: 'operator-b',
                leaseDurationSeconds: 15,
                // Renewed just now, so the lease is very much alive.
                renewTime: new Date('2026-01-01T00:00:00Z'),
                leaseTransitions: 1,
            },
        });

        let now = new Date('2026-01-01T00:00:00Z');
        let attempts = 0;
        const onStartedLeading = vi.fn();

        const elector = createLeaderElector({
            coordination: store.api,
            namespace: 'hetzner-server-controller',
            leaseName: 'hetzner-server-controller',
            identity: 'operator-a',
            leaseDurationMs: 15_000,
            logger: nullLogger,
            onStartedLeading,
            onStoppedLeading: vi.fn(),
            now: () => now,
            sleep: async (ms) => {
                // The holder keeps renewing, so the lease never expires. Give up
                // after a few rounds instead of contending forever.
                attempts += 1;
                if (attempts >= 3) {
                    await elector.release();
                    return;
                }
                now = new Date(now.getTime() + ms);
                const spec = store.current?.spec;
                if (spec) {
                    spec.renewTime = now;
                }
            },
        });

        await elector.run();

        expect(onStartedLeading).not.toHaveBeenCalled();
        expect(elector.isLeader).toBe(false);
        expect(store.current?.spec?.holderIdentity).toBe('operator-b');
    });

    it('reports leadership lost when a renewal is stolen', async () => {
        const store = leaseApi();
        const { elector, onStartedLeading, onStoppedLeading } = makeElector(store);

        onStartedLeading.mockImplementation(() => {
            // Another replica grabs the lease the moment we become leader.
            store.current = {
                metadata: { name: 'hetzner-server-controller', resourceVersion: '99' },
                spec: {
                    holderIdentity: 'operator-b',
                    leaseDurationSeconds: 15,
                    renewTime: new Date('2026-01-01T00:00:10Z'),
                    leaseTransitions: 9,
                },
            };
        });

        await elector.run();

        expect(onStoppedLeading).toHaveBeenCalledOnce();
        expect(elector.isLeader).toBe(false);
    });

    it('hands the lease back on release so a standby takes over quickly', async () => {
        const store = leaseApi();
        const { elector, onStartedLeading } = makeElector(store);
        onStartedLeading.mockImplementation(() => {
            void elector.release();
        });

        await elector.run();

        expect(store.current?.spec?.holderIdentity).toBeUndefined();
    });

    it('does not touch the lease on release when it never led', async () => {
        const store = leaseApi();
        const { elector } = makeElector(store);

        await elector.release();

        expect(store.writes).toHaveLength(0);
    });
});
