/**
 * The transport for every Hetzner Cloud API call.
 *
 * Responsibilities, and nothing else:
 *
 *   1. Authentication — one Bearer token per request, never logged.
 *   2. Rate limiting  — shared token bucket, plus feedback from the API's own
 *      `RateLimit-Remaining` header.
 *   3. Pagination     — list endpoints page at 25 by default; an unpaginated
 *      "find by owner label" breaks silently once a project grows.
 *   4. Error mapping  — every failure becomes a `HetznerApiError`, so no axios
 *      object (which carries the Authorization header) can ever escape.
 *   5. Metrics        — request counts and latency, labelled by *route template*
 *      rather than by path, so `/servers/12345` does not create a new series.
 *
 * Deliberately not here: retries. The work queue already retries with
 * exponential backoff and per-object bookkeeping; a second retry layer inside
 * the client would multiply against it and hide failures from the status.
 */

import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';
import type { OperatorMetrics } from '../observability/metrics.js';
import { HetznerApiError, HetznerErrorCode } from './errors.js';
import type { RateLimiter } from './rate-limiter.js';

/** Shape of the error body the Hetzner API returns. */
interface HetznerErrorBody {
    error?: {
        code?: string;
        message?: string;
        details?: unknown;
    };
}

interface PaginationMeta {
    meta?: {
        pagination?: {
            page?: number;
            per_page?: number;
            next_page?: number | null;
            last_page?: number | null;
            total_entries?: number | null;
        };
    };
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
    params?: QueryParams;
}

export interface HttpClient {
    get<T>(path: string, options?: RequestOptions): Promise<T>;
    post<T>(path: string, body?: unknown): Promise<T>;
    put<T>(path: string, body?: unknown): Promise<T>;
    delete<T>(path: string): Promise<T>;
    /**
     * Follows `meta.pagination` to the end and concatenates the arrays found
     * under `key`. Use this for every list endpoint.
     */
    list<T>(path: string, key: string, options?: RequestOptions): Promise<T[]>;
}

const MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 10 * 60 * 1000;
/** Hetzner's maximum page size. Fewer round trips, same result. */
const PAGE_SIZE = 50;
/** Refuse to loop forever if the API ever reports a cyclic `next_page`. */
const MAX_PAGES = 200;

function clampRetryAfter(value: number): number {
    return Math.min(Math.max(value, MIN_RETRY_AFTER_MS), MAX_RETRY_AFTER_MS);
}

/**
 * Reads the wait time from response headers. Hetzner sends `RateLimit-Reset`
 * (a unix timestamp) and, on 429, sometimes `Retry-After` (seconds).
 */
export function retryAfterFromHeaders(
    headers: Record<string, unknown> | undefined,
): number | undefined {
    if (!headers) {
        return undefined;
    }

    const retryAfter = Number(headers['retry-after']);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
        return clampRetryAfter(retryAfter * 1000);
    }

    const reset = Number(headers['ratelimit-reset']);
    if (Number.isFinite(reset) && reset > 0) {
        const waitMs = reset * 1000 - Date.now();
        if (waitMs > 0) {
            return clampRetryAfter(waitMs);
        }
    }

    return undefined;
}

/**
 * Collapses a concrete path into a low-cardinality metrics label:
 * `/servers/4711/actions/poweron` -> `/servers/:id/actions/poweron`.
 */
export function routeTemplate(path: string): string {
    return (
        path
            .split('?')[0]
            ?.split('/')
            .map((segment) => (/^\d+$/.test(segment) ? ':id' : segment))
            .join('/') ?? path
    );
}

function statusClass(status: number): string {
    if (status === 0) {
        return 'network_error';
    }
    return `${Math.floor(status / 100)}xx`;
}

export function toHetznerApiError(
    error: unknown,
    request: { method: string; path: string },
): HetznerApiError {
    if (axios.isAxiosError(error)) {
        const status = error.response?.status ?? 0;
        const body = error.response?.data as HetznerErrorBody | undefined;
        const timedOut = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';
        const code =
            body?.error?.code ??
            (status === 0
                ? timedOut
                    ? HetznerErrorCode.Timeout
                    : HetznerErrorCode.NetworkError
                : `http_${status}`);
        const message = body?.error?.message ?? error.message;
        const retryAfterMs = retryAfterFromHeaders(
            error.response?.headers as Record<string, unknown> | undefined,
        );

        // 429, 5xx and transport failures are transient. 401/403/404 and
        // validation errors are not: retrying them only burns API quota.
        // `conflict` and `locked` are the exception — Hetzner returns them while
        // another action holds the resource, and they clear on their own.
        const retryable =
            status === 0 ||
            status === 429 ||
            status >= 500 ||
            code === HetznerErrorCode.Conflict ||
            code === HetznerErrorCode.Locked;

        return new HetznerApiError({
            status,
            code,
            message,
            retryable,
            request,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            ...(body?.error?.details !== undefined ? { details: body.error.details } : {}),
        });
    }

    return new HetznerApiError({
        status: 0,
        code: HetznerErrorCode.Unknown,
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
        request,
    });
}

export interface HetznerHttpClientOptions {
    token: string;
    baseUrl: string;
    timeoutMs?: number;
    rateLimiter?: RateLimiter;
    metrics?: OperatorMetrics;
    userAgent?: string;
}

export function createHetznerHttpClient(options: HetznerHttpClientOptions): HttpClient {
    const instance: AxiosInstance = axios.create({
        baseURL: options.baseUrl,
        timeout: options.timeoutMs ?? 30_000,
        headers: {
            Authorization: `Bearer ${options.token}`,
            'Content-Type': 'application/json',
            'User-Agent': options.userAgent ?? 'hcloud-operator',
        },
        // Hetzner returns arrays as repeated keys, which is axios' default.
        // Being explicit keeps a future axios default change from breaking us.
        paramsSerializer: { indexes: null },
        // Never follow a redirect. Every request carries a bearer token that is
        // valid for the whole Hetzner project, and axios re-sends the
        // Authorization header on a cross-host redirect. A REST API has no
        // legitimate reason to redirect, so a 3xx here is either a
        // misconfiguration or an attempt to capture the token — treat it as an
        // error rather than following it.
        maxRedirects: 0,
        // Bound the response we are willing to buffer. A paginated list of 50
        // servers is a few hundred kilobytes; anything near this cap means
        // something is wrong upstream.
        maxContentLength: 32 * 1024 * 1024,
        maxBodyLength: 8 * 1024 * 1024,
    });

    const { rateLimiter, metrics } = options;

    async function request<T>(config: AxiosRequestConfig & { url: string }): Promise<T> {
        const method = (config.method ?? 'GET').toUpperCase();
        const route = routeTemplate(config.url);
        const labels = { method, route };

        await rateLimiter?.acquire();

        const startedAt = process.hrtime.bigint();
        try {
            const response = await instance.request<T>(config);
            const remaining = Number(
                (response.headers as Record<string, unknown> | undefined)?.['ratelimit-remaining'],
            );
            if (Number.isFinite(remaining)) {
                rateLimiter?.observeRemaining(remaining);
            }
            metrics?.apiRequestTotal.inc({ ...labels, status: statusClass(response.status) });
            return response.data;
        } catch (error) {
            const mapped = toHetznerApiError(error, { method, path: config.url });
            metrics?.apiRequestTotal.inc({ ...labels, status: statusClass(mapped.status) });
            throw mapped;
        } finally {
            const elapsedNs = Number(process.hrtime.bigint() - startedAt);
            metrics?.apiRequestDuration.observe(elapsedNs / 1_000_000_000, labels);
        }
    }

    return {
        get: (path, requestOptions) =>
            request({ method: 'GET', url: path, params: requestOptions?.params }),
        post: (path, body) => request({ method: 'POST', url: path, data: body ?? {} }),
        put: (path, body) => request({ method: 'PUT', url: path, data: body ?? {} }),
        delete: (path) => request({ method: 'DELETE', url: path }),

        async list<T>(path: string, key: string, requestOptions?: RequestOptions): Promise<T[]> {
            type Page = Record<string, unknown> & PaginationMeta;

            const collected: T[] = [];
            let page: number | undefined = 1;

            for (let visited = 0; page !== undefined && visited < MAX_PAGES; visited += 1) {
                const payload: Page = await request<Page>({
                    method: 'GET',
                    url: path,
                    params: { ...requestOptions?.params, page, per_page: PAGE_SIZE },
                });

                const items = payload[key];
                if (Array.isArray(items)) {
                    collected.push(...(items as T[]));
                }

                const next: number | null | undefined = payload.meta?.pagination?.next_page;
                page = typeof next === 'number' && next > 0 ? next : undefined;
            }

            return collected;
        },
    };
}
