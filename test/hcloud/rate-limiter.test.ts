/**
 * The rate limiter exists so eleven controllers cannot exhaust a Hetzner
 * project's 3600 requests per hour and starve everything else using the same
 * token. Its clock and sleep are injected, so these tests run instantly and
 * deterministically rather than actually waiting.
 */

import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/hcloud/rate-limiter.js';

/** A controllable clock plus a sleep that advances it. */
function fakeClock() {
    let now = 0;
    return {
        now: () => now,
        sleep: async (ms: number) => {
            now += ms;
        },
        advance: (ms: number) => {
            now += ms;
        },
    };
}

describe('RateLimiter', () => {
    it('starts full, at one minute of burst', () => {
        const limiter = new RateLimiter({ requestsPerHour: 3_600 });
        // 3600/hour is 60/minute.
        expect(limiter.available).toBe(60);
    });

    it('spends a token per acquire', async () => {
        const clock = fakeClock();
        const limiter = new RateLimiter({ requestsPerHour: 3_600, ...clock });

        await limiter.acquire();
        await limiter.acquire();

        expect(limiter.available).toBe(58);
    });

    it('refills continuously rather than in windows', async () => {
        const clock = fakeClock();
        const limiter = new RateLimiter({ requestsPerHour: 3_600, burst: 10, ...clock });

        for (let index = 0; index < 10; index += 1) {
            await limiter.acquire();
        }
        expect(limiter.available).toBe(0);

        // 3600/hour is one per second.
        clock.advance(5_000);
        expect(limiter.available).toBe(5);
    });

    it('never refills past the burst size', async () => {
        const clock = fakeClock();
        const limiter = new RateLimiter({ requestsPerHour: 3_600, burst: 10, ...clock });

        await limiter.acquire();
        clock.advance(60 * 60 * 1000);

        expect(limiter.available).toBe(10);
    });

    it('makes a caller wait when the bucket is empty', async () => {
        const clock = fakeClock();
        const limiter = new RateLimiter({ requestsPerHour: 3_600, burst: 1, ...clock });

        await limiter.acquire();
        const before = clock.now();
        await limiter.acquire();

        // Had to wait roughly a second for the next token.
        expect(clock.now() - before).toBeGreaterThanOrEqual(1_000);
    });

    it('admits waiters in the order they arrived', async () => {
        const clock = fakeClock();
        const limiter = new RateLimiter({ requestsPerHour: 3_600, burst: 1, ...clock });
        const order: number[] = [];

        await limiter.acquire();
        await Promise.all(
            [1, 2, 3].map(async (index) => {
                await limiter.acquire();
                order.push(index);
            }),
        );

        expect(order).toEqual([1, 2, 3]);
    });

    it('trusts the API when its remaining count is lower than ours', async () => {
        const clock = fakeClock();
        const limiter = new RateLimiter({ requestsPerHour: 3_600, burst: 60, ...clock });

        // Something else has been spending the same project's budget.
        limiter.observeRemaining(3);

        expect(limiter.available).toBe(3);
        expect(limiter.remainingReportedByApi).toBe(3);
    });

    it('ignores an API count that is higher than our own estimate', () => {
        const clock = fakeClock();
        const limiter = new RateLimiter({ requestsPerHour: 3_600, burst: 10, ...clock });

        limiter.observeRemaining(3_000);

        // Our own budget is the stricter one and stays in force.
        expect(limiter.available).toBe(10);
    });

    it('ignores a nonsensical header value', () => {
        const limiter = new RateLimiter({ requestsPerHour: 3_600, burst: 10 });

        limiter.observeRemaining(Number.NaN);
        limiter.observeRemaining(-5);

        expect(limiter.remainingReportedByApi).toBeUndefined();
        expect(limiter.available).toBe(10);
    });

    it('does not wedge later callers when one waiter rejects', async () => {
        const clock = fakeClock();
        const limiter = new RateLimiter({ requestsPerHour: 3_600, burst: 2, ...clock });

        await Promise.allSettled([
            limiter.acquire().then(() => {
                throw new Error('the caller failed');
            }),
            limiter.acquire(),
        ]);

        await expect(limiter.acquire()).resolves.toBeUndefined();
    });
});
