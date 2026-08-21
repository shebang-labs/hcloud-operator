/**
 * One error type for everything that can go wrong against the Hetzner Cloud API,
 * plus the classification the reconcile engine acts on.
 *
 * Security note: axios attaches the full request — including the Authorization
 * header — to its error objects. We therefore never store, re-throw or log the
 * raw axios error; only this sanitized type ever leaves the client.
 */

/** Codes the Hetzner API returns that we branch on by name. */
export const HetznerErrorCode = {
    NotFound: 'not_found',
    Uniqueness: 'uniqueness_error',
    Conflict: 'conflict',
    Locked: 'locked',
    RateLimitExceeded: 'rate_limit_exceeded',
    ResourceUnavailable: 'resource_unavailable',
    ResourceLimitExceeded: 'resource_limit_exceeded',
    Protected: 'protected',
    ServerNotStopped: 'server_not_stopped',
    InvalidInput: 'invalid_input',
    Forbidden: 'forbidden',
    Unauthorized: 'unauthorized',
    NetworkError: 'network_error',
    Timeout: 'timeout',
    Unknown: 'unknown_error',
} as const;

export type HetznerErrorCodeValue = (typeof HetznerErrorCode)[keyof typeof HetznerErrorCode];

export interface HetznerApiErrorOptions {
    status: number;
    code: string;
    message: string;
    retryable: boolean;
    retryAfterMs?: number;
    /** Method and path the failure came from, for log context. Never includes headers. */
    request?: { method: string; path: string };
    details?: unknown;
}

export class HetznerApiError extends Error {
    /** HTTP status code, or 0 for network level failures. */
    readonly status: number;
    /** Machine readable Hetzner error code, e.g. "not_found", "uniqueness_error". */
    readonly code: string;
    /** Whether trying again later has a chance of succeeding. */
    readonly retryable: boolean;
    /** Suggested wait before the next attempt, when the API told us one. */
    readonly retryAfterMs?: number;
    readonly request?: { method: string; path: string };
    readonly details?: unknown;

    constructor(options: HetznerApiErrorOptions) {
        const where = options.request ? ` [${options.request.method} ${options.request.path}]` : '';
        super(`Hetzner API error (${options.status} ${options.code})${where}: ${options.message}`);
        this.name = 'HetznerApiError';
        this.status = options.status;
        this.code = options.code;
        this.retryable = options.retryable;
        this.retryAfterMs = options.retryAfterMs;
        this.request = options.request;
        this.details = options.details;
    }

    /** The resource does not exist (any more). */
    get isNotFound(): boolean {
        return this.status === 404 || this.code === HetznerErrorCode.NotFound;
    }

    /** A resource with that name already exists in the project. */
    get isUniquenessConflict(): boolean {
        return this.code === HetznerErrorCode.Uniqueness;
    }

    /** We are sending too many requests; back off and honour retryAfterMs. */
    get isRateLimited(): boolean {
        return this.status === 429 || this.code === HetznerErrorCode.RateLimitExceeded;
    }

    /**
     * The resource is busy with another action. Common and always transient:
     * Hetzner locks a server for the duration of a resize or a rebuild.
     */
    get isLocked(): boolean {
        return this.code === HetznerErrorCode.Locked || this.code === HetznerErrorCode.Conflict;
    }

    /** Delete protection is on. The user must turn it off in the spec first. */
    get isProtected(): boolean {
        return this.code === HetznerErrorCode.Protected;
    }

    /** Bad token or missing permissions: retrying only burns quota. */
    get isAuthFailure(): boolean {
        return this.status === 401 || this.status === 403;
    }
}

/**
 * An action was accepted by Hetzner but ended in `error`. Distinct from an HTTP
 * failure: the request succeeded, the *operation* did not.
 */
export class HetznerActionError extends Error {
    readonly actionId: number;
    readonly command: string;
    readonly code: string;
    readonly retryable: boolean;

    constructor(options: { actionId: number; command: string; code: string; message: string }) {
        super(`Hetzner action "${options.command}" failed (${options.code}): ${options.message}`);
        this.name = 'HetznerActionError';
        this.actionId = options.actionId;
        this.command = options.command;
        this.code = options.code;
        // A failed action is a real outcome, not a transport hiccup. Retrying is
        // only worthwhile when the cause was something transient.
        this.retryable = [
            HetznerErrorCode.Locked,
            HetznerErrorCode.Conflict,
            HetznerErrorCode.ResourceUnavailable,
        ].includes(options.code as never);
    }
}

/** An action never reached a terminal state within the configured budget. */
export class HetznerActionTimeoutError extends Error {
    readonly actionId: number;
    readonly command: string;
    readonly retryable = true;

    constructor(actionId: number, command: string, waitedMs: number) {
        super(
            `Hetzner action "${command}" (${actionId}) did not finish within ${waitedMs}ms; it may still be running`,
        );
        this.name = 'HetznerActionTimeoutError';
        this.actionId = actionId;
        this.command = command;
    }
}

/** True when the error is worth another attempt. Understands all three types. */
export function isRetryable(error: unknown): boolean {
    if (error instanceof HetznerApiError) {
        return error.retryable;
    }
    if (error instanceof HetznerActionError || error instanceof HetznerActionTimeoutError) {
        return error.retryable;
    }
    // An unknown failure is assumed transient: the work queue's exponential
    // backoff bounds the cost of being wrong, and giving up silently is worse.
    return true;
}

/** Reads a server-suggested wait time from an error, if it has one. */
export function retryAfterOf(error: unknown): number | undefined {
    const value = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
