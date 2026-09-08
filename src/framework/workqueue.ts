/**
 * A rate-limited work queue — the piece that makes a controller well behaved.
 *
 * Real controllers never call reconcile() directly from a watch event. They put
 * a *key* ("namespace/name") into a queue, and workers take keys out of it. That
 * gives four properties for free:
 *
 *   - de-duplication: ten events for the same object collapse into one
 *     reconcile, because the same key is only queued once;
 *   - serialization: one object is never reconciled by two workers at the same
 *     time (which is what stops two servers being created for one resource);
 *   - retries with exponential backoff, so a broken object does not hammer the
 *     Hetzner API in a hot loop — and no retry at all for failures that cannot
 *     fix themselves (a bad spec, a missing permission), which only the next
 *     spec change or periodic resync can resolve;
 *   - a bounded number of parallel reconciles.
 */

import { retryAfterOf } from '../hcloud/errors.js';
import type { Logger } from '../observability/logger.js';

export interface QueueResult {
    /** Reconcile the same key again after this delay. */
    requeueAfterMs?: number;
}

export type WorkHandler = (key: string) => Promise<QueueResult>;

export interface WorkQueueOptions {
    handler: WorkHandler;
    logger: Logger;
    /** Identifies the queue in logs and metrics. */
    name: string;
    /** Maximum reconciles running at the same time. */
    concurrency?: number;
    /** Delay of the first retry. Doubles with every consecutive failure. */
    baseDelayMs?: number;
    /** Upper bound of the retry delay. */
    maxDelayMs?: number;
    /**
     * Decides whether a failed reconcile is worth a backed-off retry. Without
     * it every error is retried, which is the safe default for a queue that
     * knows nothing about its errors; the controller passes the Hetzner
     * classification so permanent failures stop burning API quota.
     */
    isRetryable?: (error: unknown) => boolean;
}

interface ScheduledItem {
    timer: NodeJS.Timeout;
    dueAt: number;
}

export class WorkQueue {
    private readonly handler: WorkHandler;
    private readonly logger: Logger;
    private readonly concurrency: number;
    private readonly baseDelayMs: number;
    private readonly maxDelayMs: number;
    private readonly isRetryable: (error: unknown) => boolean;

    readonly name: string;

    /** Keys ready to be processed, in FIFO order. */
    private readonly ready: string[] = [];
    private readonly readySet = new Set<string>();
    /** Keys waiting for a timer (retry backoff or requeueAfter). */
    private readonly scheduled = new Map<string, ScheduledItem>();
    /** Keys currently being reconciled. */
    private readonly running = new Set<string>();
    /** Keys that got a new event while they were running. */
    private readonly dirty = new Set<string>();
    /** Consecutive failure counter per key, drives the backoff. */
    private readonly failures = new Map<string, number>();
    private readonly inFlight = new Set<Promise<void>>();

    private stopped = false;

    constructor(options: WorkQueueOptions) {
        this.handler = options.handler;
        this.logger = options.logger;
        this.name = options.name;
        this.concurrency = Math.max(1, options.concurrency ?? 2);
        this.baseDelayMs = Math.max(1, options.baseDelayMs ?? 2_000);
        this.maxDelayMs = Math.max(this.baseDelayMs, options.maxDelayMs ?? 5 * 60 * 1000);
        this.isRetryable = options.isRetryable ?? (() => true);
    }

    /** Adds a key, optionally after a delay. Adding a queued key is a no-op. */
    add(key: string, delayMs = 0): void {
        if (this.stopped) {
            return;
        }

        if (this.running.has(key)) {
            // Reconcile it again as soon as the current run finishes: the object
            // changed while we were working with an older version of it.
            this.dirty.add(key);
            return;
        }

        if (this.readySet.has(key)) {
            // Already queued, and about to run: that run supersedes any delayed
            // one, so a timer here would only fire a redundant reconcile later.
            return;
        }

        if (delayMs > 0) {
            const dueAt = Date.now() + delayMs;
            const existing = this.scheduled.get(key);
            if (existing && existing.dueAt <= dueAt) {
                return; // An earlier run is already planned.
            }
            if (existing) {
                clearTimeout(existing.timer);
            }
            const timer = setTimeout(() => {
                this.scheduled.delete(key);
                this.add(key, 0);
            }, delayMs);
            // Do not keep the process alive just for a pending retry.
            timer.unref?.();
            this.scheduled.set(key, { timer, dueAt });
            return;
        }

        const existing = this.scheduled.get(key);
        if (existing) {
            clearTimeout(existing.timer);
            this.scheduled.delete(key);
        }

        this.ready.push(key);
        this.readySet.add(key);
        this.pump();
    }

    /** Resets the failure counter of a key (used after a successful reconcile). */
    forget(key: string): void {
        this.failures.delete(key);
    }

    /** Number of keys waiting to be processed. */
    get pending(): number {
        return this.ready.length + this.scheduled.size;
    }

    /** Number of reconciles currently running. */
    get active(): number {
        return this.running.size;
    }

    /** Everything the queue is tracking. What the metrics gauge reports. */
    get depth(): number {
        return this.pending + this.active;
    }

    /** Stops accepting work, cancels timers and waits for running reconciles. */
    async stop(): Promise<void> {
        this.stopped = true;
        for (const item of this.scheduled.values()) {
            clearTimeout(item.timer);
        }
        this.scheduled.clear();
        this.ready.length = 0;
        this.readySet.clear();
        await Promise.allSettled([...this.inFlight]);
    }

    private pump(): void {
        while (!this.stopped && this.running.size < this.concurrency && this.ready.length > 0) {
            const key = this.ready.shift();
            if (key === undefined) {
                return;
            }
            this.readySet.delete(key);
            this.run(key);
        }
    }

    private run(key: string): void {
        this.running.add(key);

        const promise = (async () => {
            let nextDelayMs: number | undefined;
            try {
                nextDelayMs = await this.process(key);
            } finally {
                // Leave the "running" set exactly once, and before scheduling the
                // follow-up run: add() would otherwise only mark the key dirty and
                // the retry would silently never happen.
                //
                // It must not be repeated in a later .finally() either. The set is
                // keyed by name, so a late delete would remove the entry of the
                // *next* run of the same key - and then two reconciles of one
                // object could run in parallel and create two Hetzner resources.
                this.running.delete(key);
            }
            if (nextDelayMs !== undefined) {
                this.add(key, nextDelayMs);
            }
        })().finally(() => {
            this.inFlight.delete(promise);
            this.pump();
        });

        this.inFlight.add(promise);
    }

    /**
     * Runs the handler for one key. Never throws: it returns the delay after
     * which the key should be processed again, or undefined for "nothing to do".
     *
     * A failure the predicate calls permanent gets no retry and no backoff
     * state: the handler has already written it into the object's status, and
     * only a spec change (a watch event) or the periodic resync can move it on.
     */
    private async process(key: string): Promise<number | undefined> {
        try {
            const result = await this.handler(key);
            this.failures.delete(key);

            if (this.dirty.delete(key)) {
                // The object changed while we were reconciling it: run again now.
                return 0;
            }
            return result.requeueAfterMs !== undefined
                ? Math.max(0, result.requeueAfterMs)
                : undefined;
        } catch (error) {
            // One broken object must never take the operator down: we log and
            // keep processing every other key, whatever happens to this one.
            const changed = this.dirty.delete(key);

            if (!this.isRetryable(error)) {
                this.failures.delete(key);
                this.logger.error('Reconciliation failed permanently, not retrying', {
                    queue: this.name,
                    resource: key,
                    error,
                });
                // The object changed while we were failing on its old spec;
                // the new one may well be fine, so look at it right away.
                return changed ? 0 : undefined;
            }

            const attempt = (this.failures.get(key) ?? 0) + 1;
            this.failures.set(key, attempt);
            const delayMs = this.retryDelay(attempt, error);

            this.logger.error('Reconciliation failed', {
                queue: this.name,
                resource: key,
                attempt,
                retryInMs: delayMs,
                error,
            });

            return delayMs;
        }
    }

    /** Exponential backoff with jitter, never below a server-requested delay. */
    private retryDelay(attempt: number, error: unknown): number {
        const exponential = Math.min(
            this.maxDelayMs,
            this.baseDelayMs * 2 ** Math.min(attempt - 1, 30),
        );
        // +/-10% jitter so many failing objects do not retry in lockstep.
        const jittered = Math.round(exponential * (0.9 + Math.random() * 0.2));
        return Math.max(jittered, retryAfterOf(error) ?? 0);
    }
}

export { retryAfterOf };
