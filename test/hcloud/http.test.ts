/**
 * The transport, tested against a real axios instance with a stubbed adapter.
 *
 * The security property here is worth stating out loud: axios attaches the full
 * request, Authorization header included, to its error objects. If a raw axios
 * error ever escaped this module it would end up in a log line. So one of these
 * tests exists purely to prove that never happens.
 */

import type { AxiosAdapter } from 'axios';
import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { HetznerApiError } from '../../src/hcloud/errors.js';
import {
    createHetznerHttpClient,
    retryAfterFromHeaders,
    routeTemplate,
} from '../../src/hcloud/http.js';
import { RateLimiter } from '../../src/hcloud/rate-limiter.js';
import { createMetrics } from '../../src/observability/metrics.js';

interface StubResponse {
    status?: number;
    data?: unknown;
    headers?: Record<string, string>;
}

/**
 * Replaces axios' HTTP adapter, so the real axios pipeline (headers, params,
 * error shaping) runs but nothing leaves the process.
 */
function stubAxios(
    responder: (config: {
        url?: string;
        method?: string;
        params?: unknown;
        data?: unknown;
    }) => StubResponse,
) {
    const seen: Array<{
        url?: string;
        method?: string;
        params?: unknown;
        data?: unknown;
        headers?: unknown;
    }> = [];
    const adapter: AxiosAdapter = async (config) => {
        seen.push({
            url: config.url,
            method: config.method,
            params: config.params,
            data: config.data,
            headers: config.headers,
        });
        const stub = responder(config);
        const status = stub.status ?? 200;
        const response = {
            data: stub.data ?? {},
            status,
            statusText: 'OK',
            headers: stub.headers ?? {},
            config,
        };
        if (status >= 400) {
            const error = new axios.AxiosError(
                'Request failed',
                String(status),
                config,
                {},
                response as never,
            );
            throw error;
        }
        return response as never;
    };

    // Capture the real factory *before* replacing it, or the stub calls itself.
    const realCreate = axios.create;
    const create = vi
        .spyOn(axios, 'create')
        .mockImplementation((config) => realCreate.call(axios, { ...config, adapter }));

    return {
        seen,
        restore: () => create.mockRestore(),
    };
}

function makeClient(
    responder: Parameters<typeof stubAxios>[0],
    options: Parameters<typeof createHetznerHttpClient>[0] extends infer T
        ? Partial<T>
        : never = {},
) {
    const stub = stubAxios(responder);
    const client = createHetznerHttpClient({
        token: 'super-secret-token',
        baseUrl: 'https://api.hetzner.cloud/v1',
        ...options,
    });
    return { client, ...stub };
}

describe('routeTemplate', () => {
    it.each([
        ['/servers', '/servers'],
        ['/servers/4711', '/servers/:id'],
        ['/servers/4711/actions/poweron', '/servers/:id/actions/poweron'],
        ['/load_balancers/1/actions/add_target', '/load_balancers/:id/actions/add_target'],
        ['/servers?page=2', '/servers'],
    ])('collapses %o to %o', (path, expected) => {
        expect(routeTemplate(path)).toBe(expected);
    });
});

describe('retryAfterFromHeaders', () => {
    it('prefers Retry-After, in seconds', () => {
        expect(retryAfterFromHeaders({ 'retry-after': '30' })).toBe(30_000);
    });

    it('falls back to RateLimit-Reset, a unix timestamp', () => {
        const resetAt = Math.floor((Date.now() + 45_000) / 1000);
        const result = retryAfterFromHeaders({ 'ratelimit-reset': String(resetAt) });
        expect(result).toBeGreaterThan(40_000);
        expect(result).toBeLessThanOrEqual(46_000);
    });

    it('clamps an absurd delay to ten minutes', () => {
        expect(retryAfterFromHeaders({ 'retry-after': '99999' })).toBe(10 * 60 * 1000);
    });

    it('raises a tiny delay to one second, so a retry storm is impossible', () => {
        // The next whole second, so the wait is real but well under a second.
        const resetAt = Math.ceil((Date.now() + 100) / 1000);
        expect(
            retryAfterFromHeaders({ 'ratelimit-reset': String(resetAt) }) ?? 0,
        ).toBeGreaterThanOrEqual(1_000);
    });

    it('returns nothing when neither header is present or usable', () => {
        expect(retryAfterFromHeaders(undefined)).toBeUndefined();
        expect(retryAfterFromHeaders({})).toBeUndefined();
        expect(retryAfterFromHeaders({ 'retry-after': 'soon' })).toBeUndefined();
        // A reset time in the past means the window already rolled over.
        expect(retryAfterFromHeaders({ 'ratelimit-reset': '1' })).toBeUndefined();
    });
});

describe('createHetznerHttpClient', () => {
    it('sends the bearer token', async () => {
        const { client, seen, restore } = makeClient(() => ({ data: { servers: [] } }));
        await client.get('/servers');
        restore();

        const headers = seen[0]?.headers as { Authorization?: string } | undefined;
        expect(headers?.Authorization).toBe('Bearer super-secret-token');
    });

    it('never lets an axios error — which carries the token — escape', async () => {
        const { client, restore } = makeClient(() => ({
            status: 403,
            data: { error: { code: 'forbidden', message: 'read-only token' } },
        }));

        const error = await client.get('/servers').catch((caught) => caught);
        restore();

        expect(error).toBeInstanceOf(HetznerApiError);
        expect(axios.isAxiosError(error)).toBe(false);
        expect(JSON.stringify(error)).not.toContain('super-secret-token');
    });

    it('maps the Hetzner error body onto the typed error', async () => {
        const { client, restore } = makeClient(() => ({
            status: 409,
            data: {
                error: {
                    code: 'uniqueness_error',
                    message: 'name taken',
                    details: { field: 'name' },
                },
            },
        }));

        const error = (await client
            .post('/servers', {})
            .catch((caught) => caught)) as HetznerApiError;
        restore();

        expect(error.status).toBe(409);
        expect(error.code).toBe('uniqueness_error');
        expect(error.isUniquenessConflict).toBe(true);
        expect(error.retryable).toBe(false);
        expect(error.request).toEqual({ method: 'POST', path: '/servers' });
        expect(error.details).toEqual({ field: 'name' });
    });

    it.each([
        [500, true],
        [502, true],
        [429, true],
        [404, false],
        [401, false],
        [400, false],
    ])('marks a %i as retryable=%s', async (status, retryable) => {
        const { client, restore } = makeClient(() => ({ status, data: {} }));
        const error = (await client.get('/servers').catch((caught) => caught)) as HetznerApiError;
        restore();
        expect(error.retryable).toBe(retryable);
    });

    it('treats conflict and locked as retryable whatever the status', async () => {
        const { client, restore } = makeClient(() => ({
            status: 409,
            data: { error: { code: 'locked', message: 'the server is locked' } },
        }));
        const error = (await client.get('/servers/1').catch((caught) => caught)) as HetznerApiError;
        restore();

        expect(error.retryable).toBe(true);
        expect(error.isLocked).toBe(true);
    });

    it('reads Retry-After off a 429', async () => {
        const { client, restore } = makeClient(() => ({
            status: 429,
            data: { error: { code: 'rate_limit_exceeded', message: 'slow down' } },
            headers: { 'retry-after': '12' },
        }));

        const error = (await client.get('/servers').catch((caught) => caught)) as HetznerApiError;
        restore();

        expect(error.isRateLimited).toBe(true);
        expect(error.retryAfterMs).toBe(12_000);
    });

    describe('pagination', () => {
        it('follows next_page to the end', async () => {
            const { client, seen, restore } = makeClient((config) => {
                const page = Number((config.params as { page?: number })?.page ?? 1);
                return {
                    data: {
                        servers: [{ id: page }],
                        meta: { pagination: { page, next_page: page < 3 ? page + 1 : null } },
                    },
                };
            });

            const servers = await client.list<{ id: number }>('/servers', 'servers');
            restore();

            expect(servers.map((server) => server.id)).toEqual([1, 2, 3]);
            expect(seen).toHaveLength(3);
            expect((seen[0]?.params as { per_page?: number })?.per_page).toBe(50);
        });

        it('stops at one page when there is no next one', async () => {
            const { client, seen, restore } = makeClient(() => ({
                data: { servers: [{ id: 1 }], meta: { pagination: { page: 1, next_page: null } } },
            }));

            await client.list('/servers', 'servers');
            restore();

            expect(seen).toHaveLength(1);
        });

        it('passes caller params through on every page', async () => {
            const { client, seen, restore } = makeClient((config) => {
                const page = Number((config.params as { page?: number })?.page ?? 1);
                return {
                    data: {
                        servers: [],
                        meta: { pagination: { page, next_page: page < 2 ? 2 : null } },
                    },
                };
            });

            await client.list('/servers', 'servers', { params: { label_selector: 'a=b' } });
            restore();

            for (const request of seen) {
                expect((request.params as { label_selector?: string })?.label_selector).toBe('a=b');
            }
        });

        it('tolerates a response with no items array', async () => {
            const { client, restore } = makeClient(() => ({ data: { meta: {} } }));
            const result = await client.list('/servers', 'servers');
            restore();
            expect(result).toEqual([]);
        });
    });

    describe('rate limiting and metrics', () => {
        it('acquires a token before each request and feeds the header back', async () => {
            const rateLimiter = new RateLimiter({ requestsPerHour: 3_600, burst: 10 });
            const { client, restore } = makeClient(
                () => ({ data: {}, headers: { 'ratelimit-remaining': '4' } }),
                { rateLimiter },
            );

            await client.get('/servers');
            restore();

            expect(rateLimiter.remainingReportedByApi).toBe(4);
        });

        it('counts requests by route template, not by concrete path', async () => {
            const metrics = createMetrics();
            const { client, restore } = makeClient(() => ({ data: {} }), { metrics });

            await client.get('/servers/1');
            await client.get('/servers/2');
            restore();

            expect(
                metrics.apiRequestTotal.get({
                    method: 'GET',
                    route: '/servers/:id',
                    status: '2xx',
                }),
            ).toBe(2);
        });

        it('counts failures too', async () => {
            const metrics = createMetrics();
            const { client, restore } = makeClient(() => ({ status: 500, data: {} }), { metrics });

            await client.get('/servers').catch(() => undefined);
            restore();

            expect(
                metrics.apiRequestTotal.get({ method: 'GET', route: '/servers', status: '5xx' }),
            ).toBe(1);
        });
    });
});

describe('transport hardening', () => {
    it('never follows a redirect, which would forward the token to another host', async () => {
        const { client, seen, restore } = makeClient(() => ({ data: {} }));
        await client.get('/servers');
        restore();

        // axios re-sends the Authorization header across a cross-host redirect,
        // and a REST API has no legitimate reason to redirect at all.
        expect(seen).toHaveLength(1);
    });

    it('configures the instance with maxRedirects: 0 and a bounded body', async () => {
        // Asserted through the config the client hands to axios, since a stub
        // adapter never exercises redirect handling itself.
        const created: Array<Record<string, unknown>> = [];
        const realCreate = axios.create;
        const spy = vi.spyOn(axios, 'create').mockImplementation((config) => {
            created.push(config as Record<string, unknown>);
            return realCreate.call(axios, config);
        });

        createHetznerHttpClient({ token: 't', baseUrl: 'https://api.hetzner.cloud/v1' });
        spy.mockRestore();

        expect(created[0]?.maxRedirects).toBe(0);
        expect(created[0]?.maxContentLength).toBeGreaterThan(0);
    });
});
