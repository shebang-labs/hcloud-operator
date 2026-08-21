/**
 * Error classification drives every retry decision the operator makes, so the
 * predicates are pinned down individually. Getting `retryable` wrong in either
 * direction is expensive: too eager burns the API quota, too cautious leaves a
 * resource stuck until a human notices.
 */

import { describe, expect, it } from 'vitest';
import {
    HetznerActionError,
    HetznerActionTimeoutError,
    HetznerApiError,
    HetznerErrorCode,
    isRetryable,
    retryAfterOf,
} from '../../src/hcloud/errors.js';

function apiError(overrides: Partial<ConstructorParameters<typeof HetznerApiError>[0]> = {}) {
    return new HetznerApiError({
        status: 500,
        code: 'server_error',
        message: 'boom',
        retryable: true,
        ...overrides,
    });
}

describe('HetznerApiError', () => {
    it('renders the status, code, request and message', () => {
        const error = apiError({
            status: 404,
            code: 'not_found',
            message: 'no such server',
            request: { method: 'GET', path: '/servers/1' },
        });

        expect(error.message).toBe(
            'Hetzner API error (404 not_found) [GET /servers/1]: no such server',
        );
    });

    it.each([
        [{ status: 404, code: 'other' }, 'isNotFound'],
        [{ status: 400, code: HetznerErrorCode.NotFound }, 'isNotFound'],
        [{ status: 409, code: HetznerErrorCode.Uniqueness }, 'isUniquenessConflict'],
        [{ status: 429, code: 'other' }, 'isRateLimited'],
        [{ status: 400, code: HetznerErrorCode.RateLimitExceeded }, 'isRateLimited'],
        [{ status: 409, code: HetznerErrorCode.Locked }, 'isLocked'],
        [{ status: 409, code: HetznerErrorCode.Conflict }, 'isLocked'],
        [{ status: 403, code: HetznerErrorCode.Protected }, 'isProtected'],
        [{ status: 401, code: 'unauthorized' }, 'isAuthFailure'],
        [{ status: 403, code: 'forbidden' }, 'isAuthFailure'],
    ])('classifies %o as %s', (overrides, predicate) => {
        const error = apiError(overrides);
        expect(error[predicate as 'isNotFound']).toBe(true);
    });

    it('does not claim a 500 is any of the specific cases', () => {
        const error = apiError();
        expect(error.isNotFound).toBe(false);
        expect(error.isRateLimited).toBe(false);
        expect(error.isLocked).toBe(false);
        expect(error.isProtected).toBe(false);
        expect(error.isAuthFailure).toBe(false);
    });

    it('carries retryAfterMs through when the API supplied one', () => {
        expect(apiError().retryAfterMs).toBeUndefined();
        expect(apiError({ retryAfterMs: 5_000 }).retryAfterMs).toBe(5_000);
    });
});

describe('HetznerActionError', () => {
    it('is retryable only for transient causes', () => {
        const transient = new HetznerActionError({
            actionId: 1,
            command: 'attach_volume',
            code: HetznerErrorCode.Locked,
            message: 'the server is locked',
        });
        const permanent = new HetznerActionError({
            actionId: 2,
            command: 'attach_volume',
            code: 'volume_already_attached',
            message: 'already attached',
        });

        expect(transient.retryable).toBe(true);
        expect(permanent.retryable).toBe(false);
    });

    it('names the command and the Hetzner code in its message', () => {
        const error = new HetznerActionError({
            actionId: 7,
            command: 'change_type',
            code: 'server_not_stopped',
            message: 'the server must be powered off',
        });

        expect(error.message).toContain('change_type');
        expect(error.message).toContain('server_not_stopped');
        expect(error.message).toContain('powered off');
    });
});

describe('HetznerActionTimeoutError', () => {
    it('is always retryable and says the action may still be running', () => {
        const error = new HetznerActionTimeoutError(9, 'create_server', 60_000);

        expect(error.retryable).toBe(true);
        expect(error.message).toContain('may still be running');
    });
});

describe('isRetryable', () => {
    it('follows the flag on every known error type', () => {
        expect(isRetryable(apiError({ retryable: false }))).toBe(false);
        expect(isRetryable(apiError({ retryable: true }))).toBe(true);
        expect(
            isRetryable(
                new HetznerActionError({ actionId: 1, command: 'x', code: 'nope', message: '' }),
            ),
        ).toBe(false);
        expect(isRetryable(new HetznerActionTimeoutError(1, 'x', 1))).toBe(true);
    });

    it('assumes an unknown failure is transient', () => {
        // Being wrong here costs one backoff cycle; giving up silently costs a
        // resource nobody notices is stuck.
        expect(isRetryable(new Error('who knows'))).toBe(true);
        expect(isRetryable('a string')).toBe(true);
    });
});

describe('retryAfterOf', () => {
    it('reads a positive finite delay and rejects anything else', () => {
        expect(retryAfterOf({ retryAfterMs: 1_000 })).toBe(1_000);
        expect(retryAfterOf({ retryAfterMs: 0 })).toBeUndefined();
        expect(retryAfterOf({ retryAfterMs: -1 })).toBeUndefined();
        expect(retryAfterOf({ retryAfterMs: Number.NaN })).toBeUndefined();
        expect(retryAfterOf({ retryAfterMs: 'soon' })).toBeUndefined();
        expect(retryAfterOf(null)).toBeUndefined();
        expect(retryAfterOf(new Error('plain'))).toBeUndefined();
    });
});
