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
 *   - if the Lease says another replica holds it, we lost and stop immediately;
 *   - if a renewal merely *errors* (API server blip), we keep retrying until
 *     the last successful renewal is a full lease duration old — that is the
 *     moment another replica is allowed to take over, and before it nobody can
 *     have. Stopping earlier would restart the operator on every hiccup.
 *
 * `resourceVersion` on every write makes the acquire a compare-and-swap, so two
 * replicas racing for a free lease cannot both win.
 */

import { type CoordinationV1Api, type V1Lease, V1MicroTime } from '@kubernetes/client-node';
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

type RenewalOutcome =
    | { kind: 'renewed' }
    /** The Lease itself says we no longer hold it. */
    | { kind: 'lost' }
    /** The API call did not complete; we may well still be leader. */
    | { kind: 'failed'; error: unknown };

export function createLeaderElector(options: LeaderElectionOptions): LeaderElector {
    const { coordination, namespace, leaseName, identity, logger } = options;
    const leaseDurationSeconds = Math.max(1, Math.round(options.leaseDurationMs / 1000));
    const renewIntervalMs = Math.max(1_000, Math.floor(options.leaseDurationMs / 3));
    const retryIntervalMs = Math.max(1_000, Math.floor(options.leaseDurationMs / 2));
    // Shorter than the renew interval, so a blip costs one or two extra
    // attempts, not a third of the lease.
    const renewRetryMs = Math.max(1_000, Math.floor(renewIntervalMs / 2));
    const now = options.now ?? (() => new Date());
    const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    let leader = false;
    let released = false;
    /** When we last wrote the Lease successfully. The clock the loss deadline runs on. */
    let lastRenewedAt = 0;
    /** The renewal currently talking to the API server, so release() can wait for it. */
    let renewal: Promise<RenewalOutcome> | undefined;

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

    /**
     * Lease timestamps are Kubernetes MicroTime, which the API server parses
     * with exactly six fractional digits. A plain Date serializes with three
     * and is rejected with a 400 — the kind of thing no fake API server
     * notices, so the wire format has its own test.
     */
    const microTime = (date: Date): Date => new V1MicroTime(date.getTime());

    function leaseBody(existing: V1Lease | null, transitions: number): V1Lease {
        const timestamp = microTime(now());
        // acquireTime is "since when has this holder led": a renewal must not
        // move it, or `kubectl describe lease` will always show a leader that
        // took over seconds ago.
        const acquireTime =
            existing?.spec?.holderIdentity === identity && existing.spec.acquireTime
                ? existing.spec.acquireTime
                : timestamp;
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
                acquireTime,
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
                if (isConflictError(error)) {
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

    /**
     * One renewal, never rejecting: the outcome carries the error instead, so
     * release() can await the same promise without a second catch.
     */
    function startRenewal(): Promise<RenewalOutcome> {
        return tryAcquireOrRenew().then(
            (held): RenewalOutcome => (held ? { kind: 'renewed' } : { kind: 'lost' }),
            (error): RenewalOutcome => ({ kind: 'failed', error }),
        );
    }

    async function renewUntilLost(): Promise<void> {
        let waitMs = renewIntervalMs;
        while (!released) {
            await sleep(waitMs);
            if (released) {
                return;
            }

            renewal = startRenewal();
            const outcome = await renewal;
            renewal = undefined;
            if (released) {
                // release() is handing the lease back; whatever this renewal saw
                // is not a loss of leadership.
                return;
            }

            if (outcome.kind === 'renewed') {
                lastRenewedAt = now().getTime();
                waitMs = renewIntervalMs;
                continue;
            }

            if (outcome.kind === 'failed') {
                const sinceRenewalMs = now().getTime() - lastRenewedAt;
                if (sinceRenewalMs < options.leaseDurationMs) {
                    logger.warn('Failed to renew the leader lease, retrying', {
                        error: outcome.error,
                        sinceRenewalMs,
                        retryInMs: renewRetryMs,
                    });
                    waitMs = renewRetryMs;
                    continue;
                }
                logger.error('Could not renew the leader lease within its duration', {
                    error: outcome.error,
                    sinceRenewalMs,
                });
            }

            logger.warn('Lost the leader lease', { leaseName, identity });
            leader = false;
            await options.onStoppedLeading();
            return;
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
                    lastRenewedAt = now().getTime();
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
            // A renewal in flight would otherwise race the hand-back: its write
            // lands after ours and re-acquires the lease, or ours lands first
            // and the renewal 409s and is mistaken for a lost lease.
            await renewal;
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
                                renewTime: microTime(now()),
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
