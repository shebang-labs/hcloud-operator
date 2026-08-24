/**
 * A token bucket shared by every controller in the process.
 *
 * Hetzner allows 3600 requests per hour per project. With eleven kinds each
 * resyncing on a timer, an operator can chew through that budget and then
 * starve everything else using the same token — including a human running
 * `hcloud server list`. So we self-limit below the real ceiling instead of
 * discovering it through 429s.
 *
 * The bucket refills continuously rather than in windows: bursts are absorbed
 * up to the bucket size, and the long-run average stays at the configured rate.
 */

export interface RateLimiterOptions {
    /** Sustained rate, in requests per hour. */
    requestsPerHour: number;
    /** How many requests may burst at once. Defaults to one minute's worth. */
    burst?: number;
    /** Injectable clock, in milliseconds. */
    now?: () => number;
    /** Injectable sleep, so tests do not wait in real time. */
    sleep?: (ms: number) => Promise<void>;
}

const ONE_HOUR_MS = 60 * 60 * 1000;

export class RateLimiter {
    private readonly refillPerMs: number;
    private readonly capacity: number;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;

    private tokens: number;
    private lastRefillAt: number;
    /** Serializes waiters so they are admitted in arrival order, not at random. */
    private queue: Promise<void> = Promise.resolve();

    /**
     * Set from the API's own `RateLimit-Remaining` header. It is the authority
     * when it is lower than our local estimate — something else may be spending
     * the same project's budget.
     */
    private reportedRemaining: number | undefined;

    constructor(options: RateLimiterOptions) {
        this.refillPerMs = options.requestsPerHour / ONE_HOUR_MS;
        this.capacity = Math.max(1, options.burst ?? Math.ceil(options.requestsPerHour / 60));
        this.now = options.now ?? (() => Date.now());
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.tokens = this.capacity;
        this.lastRefillAt = this.now();
    }

    /** Tokens available right now. Exposed for the metrics gauge and tests. */
    get available(): number {
        this.refill();
        return Math.floor(this.tokens);
    }

    /** What the API last told us is left in its window, if it told us. */
    get remainingReportedByApi(): number | undefined {
        return this.reportedRemaining;
    }

    /** Feeds the `RateLimit-Remaining` response header back into the bucket. */
    observeRemaining(remaining: number): void {
        if (!Number.isFinite(remaining) || remaining < 0) {
            return;
        }
        this.reportedRemaining = remaining;
        // Trust the server over our own estimate when it is more pessimistic.
        if (remaining < this.tokens) {
            this.tokens = remaining;
        }
    }

    /**
     * Resolves once a token is available, then spends it. Calls are admitted in
     * the order they arrive.
     */
    acquire(): Promise<void> {
        const admitted = this.queue.then(() => this.waitForToken());
        // Keep the chain alive even if a waiter rejects, so one failure does not
        // wedge every later caller.
        this.queue = admitted.then(
            () => undefined,
            () => undefined,
        );
        return admitted;
    }

    private async waitForToken(): Promise<void> {
        for (;;) {
            this.refill();
            if (this.tokens >= 1) {
                this.tokens -= 1;
                if (this.reportedRemaining !== undefined) {
                    this.reportedRemaining = Math.max(0, this.reportedRemaining - 1);
                }
                return;
            }
            const deficit = 1 - this.tokens;
            await this.sleep(Math.max(1, Math.ceil(deficit / this.refillPerMs)));
        }
    }

    private refill(): void {
        const now = this.now();
        const elapsed = now - this.lastRefillAt;
        if (elapsed <= 0) {
            return;
        }
        this.lastRefillAt = now;
        this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    }
}
