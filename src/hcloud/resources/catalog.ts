/**
 * The read-only half of the Hetzner Cloud API: server types, locations,
 * datacenters, ISOs, images and prices.
 *
 * None of these are managed by the operator — they are Hetzner's catalog. They
 * exist here so the admission webhook can reject `serverType: cpx99` at
 * `kubectl apply` time, with the list of valid values in the error message,
 * instead of letting the object sit in a retry loop nobody looks at.
 *
 * The catalog changes on the order of months, so it is cached in memory with a
 * generous TTL rather than fetched per validation.
 */

import type { HttpClient } from '../http.js';
import type { Datacenter, Image, Iso, Location, ServerType } from '../types.js';

export interface CatalogApi {
    serverTypes(): Promise<ServerType[]>;
    locations(): Promise<Location[]>;
    datacenters(): Promise<Datacenter[]>;
    isos(): Promise<Iso[]>;
    /** Hetzner's own system images, i.e. the valid values for `spec.image`. */
    systemImages(): Promise<Image[]>;
    /** Current prices, exposed for cost reporting in status. */
    pricing(): Promise<unknown>;
    /** Drops every cached entry. Used by tests and by a periodic refresh. */
    invalidate(): void;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;

export interface CatalogOptions {
    http: HttpClient;
    ttlMs?: number;
    now?: () => number;
}

export function createCatalogApi(options: CatalogOptions): CatalogApi {
    const { http } = options;
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const now = options.now ?? (() => Date.now());
    const cache = new Map<string, { expiresAt: number; value: Promise<unknown> }>();

    function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
        const entry = cache.get(key);
        if (entry && entry.expiresAt > now()) {
            return entry.value as Promise<T>;
        }
        const value = load().catch((error) => {
            // Never cache a failure: the next validation should try again
            // rather than reject valid input for an hour.
            cache.delete(key);
            throw error;
        });
        cache.set(key, { expiresAt: now() + ttlMs, value });
        return value;
    }

    return {
        serverTypes: () =>
            cached('server_types', () => http.list<ServerType>('/server_types', 'server_types')),
        locations: () => cached('locations', () => http.list<Location>('/locations', 'locations')),
        datacenters: () =>
            cached('datacenters', () => http.list<Datacenter>('/datacenters', 'datacenters')),
        isos: () => cached('isos', () => http.list<Iso>('/isos', 'isos')),
        systemImages: () =>
            cached('system_images', () =>
                http.list<Image>('/images', 'images', { params: { type: 'system' } }),
            ),
        pricing: () => cached('pricing', () => http.get<unknown>('/pricing')),
        invalidate: () => cache.clear(),
    };
}
