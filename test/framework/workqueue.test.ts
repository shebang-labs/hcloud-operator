/**
 * The work queue is what stops a controller from being merely "eventually
 * mostly right". Its four properties — de-duplication, serialization, bounded
 * concurrency and backed-off retries — are each load-bearing, so each gets a
 * test that would fail loudly if the property were lost.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkQueue } from '../../src/framework/workqueue.js';
import { nullLogger } from '../../src/observability/logger.js';

/** Resolves once every pending timer and microtask has run. */
async function drain(): Promise<void> {
    for (let index = 0; index < 30; index += 1) {
        await vi.advanceTimersByTimeAsync(0);
    }
}

describe('WorkQueue', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('collapses repeated adds of one key into a single run', async () => {
        const handled: string[] = [];
        let release = () => {};
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });

        const queue = new WorkQueue({
            name: 'test',
            logger: nullLogger,
            handler: async (key) => {
                handled.push(key);
                await blocked;
                return {};
            },
        });

        queue.add('ns/a');
        queue.add('ns/a');
        queue.add('ns/a');
        await drain();

        expect(handled).toEqual(['ns/a']);
        release();
        await drain();
        await queue.stop();
    });

    it('never runs one key twice at the same time', async () => {
        let active = 0;
        let maxActive = 0;
        let release = () => {};
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });

        const queue = new WorkQueue({
            name: 'test',
            logger: nullLogger,
            concurrency: 4,
            handler: async () => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await blocked;
                active -= 1;
                return {};
            },
        });

        queue.add('ns/a');
        await drain();
        // An add while running only marks the key dirty.
        queue.add('ns/a');
        await drain();

        expect(maxActive).toBe(1);
        release();
        await drain();
        await queue.stop();
    });

    it('re-runs a key that changed while it was being processed', async () => {
        let runs = 0;
        let release = () => {};
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });

        const queue = new WorkQueue({
            name: 'test',
            logger: nullLogger,
            handler: async () => {
                runs += 1;
                if (runs === 1) {
                    await blocked;
                }
                return {};
            },
        });

        queue.add('ns/a');
        await drain();
        queue.add('ns/a'); // dirty
        release();
        await drain();

        expect(runs).toBe(2);
        await queue.stop();
    });

    it('honours the concurrency limit across different keys', async () => {
        let active = 0;
        let maxActive = 0;
        let release = () => {};
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });

        const queue = new WorkQueue({
            name: 'test',
            logger: nullLogger,
            concurrency: 2,
            handler: async () => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await blocked;
                active -= 1;
                return {};
            },
        });

        for (const key of ['a', 'b', 'c', 'd', 'e']) {
            queue.add(`ns/${key}`);
        }
        await drain();

        expect(maxActive).toBe(2);
        release();
        await drain();
        await queue.stop();
    });

    it('retries a failing key with a growing delay', async () => {
        const attemptTimes: number[] = [];
        const queue = new WorkQueue({
            name: 'test',
            logger: nullLogger,
            baseDelayMs: 1_000,
            maxDelayMs: 60_000,
            handler: async () => {
                attemptTimes.push(Date.now());
                throw new Error('boom');
            },
        });

        queue.add('ns/a');
        await drain();
        expect(attemptTimes).toHaveLength(1);

        // The first retry lands somewhere near baseDelay (jitter is +/-10%).
        await vi.advanceTimersByTimeAsync(1_200);
        await drain();
        expect(attemptTimes).toHaveLength(2);

        // The second waits roughly twice as long, so 1.2s is not enough.
        await vi.advanceTimersByTimeAsync(1_200);
        await drain();
        expect(attemptTimes).toHaveLength(2);

        await vi.advanceTimersByTimeAsync(1_500);
        await drain();
        expect(attemptTimes).toHaveLength(3);

        await queue.stop();
    });

    it('respects a server-requested retry delay over its own backoff', async () => {
        const attempts: number[] = [];
        const queue = new WorkQueue({
            name: 'test',
            logger: nullLogger,
            baseDelayMs: 10,
            maxDelayMs: 20,
            handler: async () => {
                attempts.push(Date.now());
                throw Object.assign(new Error('rate limited'), { retryAfterMs: 30_000 });
            },
        });

        queue.add('ns/a');
        await drain();
        await vi.advanceTimersByTimeAsync(25_000);
        await drain();
        expect(attempts).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(6_000);
        await drain();
        expect(attempts).toHaveLength(2);

        await queue.stop();
    });

    it('forgets the failure count after a success', async () => {
        let shouldFail = true;
        const attempts: number[] = [];
        const queue = new WorkQueue({
            name: 'test',
            logger: nullLogger,
            baseDelayMs: 1_000,
            handler: async () => {
                attempts.push(Date.now());
                if (shouldFail) {
                    throw new Error('boom');
                }
                return {};
            },
        });

        queue.add('ns/a');
        await drain();
        shouldFail = false;
        await vi.advanceTimersByTimeAsync(1_200);
        await drain();
        expect(attempts).toHaveLength(2);

        // A later failure starts the backoff over at baseDelay, not where it left off.
        shouldFail = true;
        queue.add('ns/a');
        await drain();
        expect(attempts).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(1_200);
        await drain();
        expect(attempts).toHaveLength(4);

        await queue.stop();
    });

    it('applies a requeueAfterMs asked for by a successful run', async () => {
        let runs = 0;
        const queue = new WorkQueue({
            name: 'test',
            logger: nullLogger,
            handler: async () => {
                runs += 1;
                return runs === 1 ? { requeueAfterMs: 5_000 } : {};
            },
        });

        queue.add('ns/a');
        await drain();
        expect(runs).toBe(1);

        await vi.advanceTimersByTimeAsync(5_100);
        await drain();
        expect(runs).toBe(2);

        await queue.stop();
    });

    it('keeps the earlier of two scheduled runs for a key', async () => {
        let runs = 0;
        const queue = new WorkQueue({
            name: 'test',
            logger: nullLogger,
            handler: async () => {
                runs += 1;
                return {};
            },
        });

        queue.add('ns/a', 10_000);
        queue.add('ns/a', 1_000);
        await vi.advanceTimersByTimeAsync(1_100);
        await drain();

        expect(runs).toBe(1);
        await queue.stop();
    });

    it('reports its depth for the metrics gauge', async () => {
        const queue = new WorkQueue({
            name: 'test',
            logger: nullLogger,
            concurrency: 1,
            handler: async () => new Promise(() => {}) as Promise<{ requeueAfterMs?: number }>,
        });

        queue.add('ns/a');
        queue.add('ns/b');
        queue.add('ns/c', 60_000);
        await drain();

        // One running, one ready, one scheduled.
        expect(queue.active).toBe(1);
        expect(queue.pending).toBe(2);
        expect(queue.depth).toBe(3);
    });

    it('stops accepting work and waits for what is running', async () => {
        let finished = false;
        let release = () => {};
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });

        const queue = new WorkQueue({
            name: 'test',
            logger: nullLogger,
            handler: async () => {
                await blocked;
                finished = true;
                return {};
            },
        });

        queue.add('ns/a');
        await drain();

        const stopping = queue.stop();
        queue.add('ns/b');
        release();
        await drain();
        await stopping;

        expect(finished).toBe(true);
        expect(queue.pending).toBe(0);
    });
});

describe('failure bookkeeping', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('forgets a key, so a deleted object leaves no backoff state behind', async () => {
        const attempts: number[] = [];
        const queue = new WorkQueue({
            name: 'test',
            logger: nullLogger,
            baseDelayMs: 1_000,
            handler: async () => {
                attempts.push(Date.now());
                throw new Error('boom');
            },
        });

        // Fail twice, so the backoff has grown past baseDelay.
        queue.add('ns/a');
        await drain();
        await vi.advanceTimersByTimeAsync(1_200);
        await drain();
        expect(attempts).toHaveLength(2);

        // The object is deleted and later recreated with the same name; the
        // fresh object must start from baseDelay, not from where the old one
        // left off.
        queue.forget('ns/a');
        queue.add('ns/a');
        await drain();
        expect(attempts).toHaveLength(3);

        await vi.advanceTimersByTimeAsync(1_200);
        await drain();
        expect(attempts).toHaveLength(4);

        await queue.stop();
    });
});

describe('permanent failures', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const permanent = () => Object.assign(new Error('bad spec'), { retryable: false });
    const isRetryable = (error: unknown) => (error as { retryable?: boolean }).retryable !== false;

    it('does not schedule a retry for an error the predicate calls permanent', async () => {
        let attempts = 0;
        const queue = new WorkQueue({
            name: 'test',
            logger: nullLogger,
            baseDelayMs: 1_000,
            isRetryable,
            handler: async () => {
                attempts += 1;
                throw permanent();
            },
        });

        queue.add('ns/a');
        await drain();
        expect(attempts).toBe(1);
        expect(queue.pending).toBe(0);

        // Long past any backoff: the resync is what re-checks it, not the queue.
        await vi.advanceTimersByTimeAsync(60_000);
        await drain();
        expect(attempts).toBe(1);

        await queue.stop();
    });

    it('clears the backoff after a permanent failure, so a later transient one starts small', async () => {
        const attempts: number[] = [];
        let error: () => Error = permanent;
        const queue = new WorkQueue({
            name: 'test',
            logger: nullLogger,
            baseDelayMs: 1_000,
            isRetryable,
            handler: async () => {
                attempts.push(Date.now());
                throw error();
            },
        });

        queue.add('ns/a');
        await drain();
        expect(attempts).toHaveLength(1);

        // The resync brings the key back, and now the failure is transient.
        error = () => new Error('flaky');
        queue.add('ns/a');
        await drain();
        expect(attempts).toHaveLength(2);

        // First retry at baseDelay, not at the doubled delay of a second attempt.
        await vi.advanceTimersByTimeAsync(1_200);
        await drain();
        expect(attempts).toHaveLength(3);

        await queue.stop();
    });

    it('still reruns a permanently failing key whose object changed mid-run', async () => {
        let runs = 0;
        let release = () => {};
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const queue = new WorkQueue({
            name: 'test',
            logger: nullLogger,
            isRetryable,
            handler: async () => {
                runs += 1;
                if (runs === 1) {
                    await blocked;
                    throw permanent();
                }
                return {};
            },
        });

        queue.add('ns/a');
        await drain();
        queue.add('ns/a'); // the user fixed the spec while we were failing on the old one
        release();
        await drain();

        expect(runs).toBe(2);
        await queue.stop();
    });

    it('retries everything when no predicate is given', async () => {
        let attempts = 0;
        const queue = new WorkQueue({
            name: 'test',
            logger: nullLogger,
            baseDelayMs: 1_000,
            handler: async () => {
                attempts += 1;
                throw permanent();
            },
        });

        queue.add('ns/a');
        await drain();
        await vi.advanceTimersByTimeAsync(1_200);
        await drain();

        expect(attempts).toBe(2);
        await queue.stop();
    });
});

describe('scheduling', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('does not schedule a delayed run for a key that is already waiting to run', async () => {
        const queue = new WorkQueue({
            name: 'test',
            logger: nullLogger,
            concurrency: 1,
            handler: async () => new Promise(() => {}) as Promise<{ requeueAfterMs?: number }>,
        });

        queue.add('ns/a'); // occupies the only worker
        queue.add('ns/b'); // ready, waiting for a worker
        await drain();
        queue.add('ns/b', 60_000);

        // Still just the one ready entry: the imminent run supersedes the timer.
        expect(queue.pending).toBe(1);
    });
});
