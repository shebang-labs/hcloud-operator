/**
 * Lease-based leader election.
 *
 * Without it, two replicas of an operator that *creates paid infrastructure*
 * both act on the same object. Ownership labels make that mostly survivable —
 * the loser adopts what the winner created — but "mostly" is not a property to
 * rely on when the failure mode is a duplicate server on the invoice.
 *
 * This is the standard Kubernetes algorithm, implemented directly against the
 * `coordination.k8s.io/v1` Lease API:
 *
 *   - to acquire, write the Lease with our identity, but only if it is unowned
 *     or its holder has not renewed within `leaseDurationSeconds`;
 *   - to keep leadership, renew every third of the lease duration;
 *   - if a renewal fails, we assume we lost the lease and stop immediately.
 *
 * `resourceVersion` on every write makes the acquire a compare-and-swap, so two
 * replicas racing for a free lease cannot both win.
 */

import type { CoordinationV1Api, V1Lease } from '@kubernetes/client-node';
import type { Logger } from '../observability/logger.js';
import { isConflictError, isNotFoundError } from './store.js';

export interface LeaderElectionOptions {
    coordination: CoordinationV1Api;
    namespace: string;
    leaseName: string;
    /** Unique per replica; the Pod name in a Deployment. */
    identity: string;
    leaseDurationMs: number;
    logger: Logger;
    /** Called once when this replica becomes leader. */
    onStartedLeading: () => Promise<void> | void;
    /** Called if leadership is subsequently lost. */
    onStoppedLeading: () => Promise<void> | void;
    now?: () => Date;
    sleep?: (ms: number) => Promise<void>;
}

export interface LeaderElector {
    /** Contends for the lease until acquired or `release()` is called. */
    run(): Promise<void>;
    release(): Promise<void>;
    readonly isLeader: boolean;
}

export function createLeaderElector(options: LeaderElectionOptions): LeaderElector {
    const { coordination, namespace, leaseName, identity, logger } = options;
    const leaseDurationSeconds = Math.max(1, Math.round(options.leaseDurationMs / 1000));
    const renewIntervalMs = Math.max(1_000, Math.floor(options.leaseDurationMs / 3));
    const retryIntervalMs = Math.max(1_000, Math.floor(options.leaseDurationMs / 2));
    const now = options.now ?? (() => new Date());
    const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    let leader = false;
    let released = false;

    async function readLease(): Promise<V1Lease | null> {
        try {
            return await coordination.readNamespacedLease({ name: leaseName, namespace });
        } catch (error) {
            if (isNotFoundError(error)) {
                return null;
            }
            throw error;
        }
    }

    /** True when nobody holds the lease, or the holder let it expire. */
    function isAvailable(lease: V1Lease): boolean {
        const holder = lease.spec?.holderIdentity;
        if (!holder || holder === identity) {
            return true;
        }
        const renewedAt = lease.spec?.renewTime ?? lease.spec?.acquireTime;
        if (!renewedAt) {
            return true;
        }
        const duration = (lease.spec?.leaseDurationSeconds ?? leaseDurationSeconds) * 1000;
        return now().getTime() - new Date(renewedAt).getTime() > duration;
    }

    function leaseBody(existing: V1Lease | null, transitions: number): V1Lease {
        const timestamp = now();
        return {
            metadata: {
                name: leaseName,
                namespace,
                ...(existing?.metadata?.resourceVersion
                    ? { resourceVersion: existing.metadata.resourceVersion }
                    : {}),
            },
            spec: {
                holderIdentity: identity,
                leaseDurationSeconds,
                acquireTime: timestamp,
                renewTime: timestamp,
                leaseTransitions: transitions,
            },
        };
    }

    /** One attempt. Returns true when we hold the lease afterwards. */
    async function tryAcquireOrRenew(): Promise<boolean> {
        const existing = await readLease();

        if (!existing) {
            try {
                await coordination.createNamespacedLease({
                    namespace,
                    body: leaseBody(null, 0),
                });
                return true;
            } catch (error) {
                // Another replica created it in the same instant. Not an error:
                // we simply lost this round.
                if (isConflictError(error) || (error as { code?: number }).code === 409) {
                    return false;
                }
                throw error;
            }
        }

        const holder = existing.spec?.holderIdentity;
        if (holder !== identity && !isAvailable(existing)) {
            return false;
        }

        const transitions = existing.spec?.leaseTransitions ?? 0;
        try {
            await coordination.replaceNamespacedLease({
                name: leaseName,
                namespace,
                body: leaseBody(existing, holder === identity ? transitions : transitions + 1),
            });
            return true;
        } catch (error) {
            if (isConflictError(error)) {
                // Somebody else wrote the lease between our read and our write.
                return false;
            }
            throw error;
        }
    }

    async function renewUntilLost(): Promise<void> {
        while (!released) {
            await sleep(renewIntervalMs);
            if (released) {
                return;
            }
            let stillLeader = false;
            try {
                stillLeader = await tryAcquireOrRenew();
            } catch (error) {
                logger.error('Failed to renew the leader lease', { error });
            }
            if (!stillLeader) {
                logger.warn('Lost the leader lease', { leaseName, identity });
                leader = false;
                await options.onStoppedLeading();
                return;
            }
        }
    }

    return {
        get isLeader() {
            return leader;
        },

        async run() {
            logger.info('Contending for the leader lease', { leaseName, namespace, identity });

            while (!released) {
                let acquired = false;
                try {
                    acquired = await tryAcquireOrRenew();
                } catch (error) {
                    logger.error('Leader election attempt failed', { error });
                }

                if (acquired) {
                    leader = true;
                    logger.info('Acquired the leader lease', { leaseName, identity });
                    await options.onStartedLeading();
                    await renewUntilLost();
                    return;
                }

                await sleep(retryIntervalMs);
            }
        },

        async release() {
            released = true;
            if (!leader) {
                return;
            }
            leader = false;
            // Hand the lease back so the next replica takes over in seconds
            // rather than after the full lease duration.
            try {
                const existing = await readLease();
                if (existing?.spec?.holderIdentity === identity) {
                    await coordination.replaceNamespacedLease({
                        name: leaseName,
                        namespace,
                        body: {
                            metadata: {
                                name: leaseName,
                                namespace,
                                ...(existing.metadata?.resourceVersion
                                    ? { resourceVersion: existing.metadata.resourceVersion }
                                    : {}),
                            },
                            spec: {
                                ...existing.spec,
                                holderIdentity: undefined,
                                renewTime: now(),
                            },
                        },
                    });
                    logger.info('Released the leader lease', { leaseName, identity });
                }
            } catch (error) {
                // Best effort: the lease expires on its own within
                // leaseDurationSeconds anyway.
                logger.warn('Could not release the leader lease cleanly', { error });
            }
        },
    };
}
