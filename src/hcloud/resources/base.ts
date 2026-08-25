/**
 * The shape every Hetzner resource endpoint shares.
 *
 * The Hetzner Cloud API is pleasantly regular: a collection lives at
 * `/<plural>`, a single object comes back under the singular key, actions live
 * at `/<plural>/<id>/actions/<name>`, and labels are filtered with
 * `label_selector`. Writing that eleven times would be eleven chances to get a
 * pagination call or a 404 branch subtly wrong, so it is written once here and
 * each resource module adds only what is genuinely its own.
 */

import type { ActionScope, ActionTracker } from '../actions.js';
import { HetznerApiError } from '../errors.js';
import type { HttpClient, QueryParams } from '../http.js';
import type { Action, Labelled } from '../types.js';

export interface ResourceEndpoint {
    /** Collection path segment, e.g. "load_balancers". */
    plural: string;
    /** Key the API wraps a single object in, e.g. "load_balancer". */
    singular: string;
    /** Prefix for the per-resource action endpoints, when the resource has any. */
    scope?: ActionScope;
}

export interface ResourceClientDependencies {
    http: HttpClient;
    actions: ActionTracker;
}

/** Common read/write operations. Every resource module exposes at least these. */
export interface BaseResourceApi<T extends Labelled> {
    /** Returns null instead of throwing when the resource is gone. */
    get(id: number): Promise<T | null>;
    /** All resources in the project, following pagination to the end. */
    list(params?: QueryParams): Promise<T[]>;
    /** Resources carrying the given Hetzner label selector, e.g. "a=b". */
    listByLabel(selector: string): Promise<T[]>;
    /** Exact-name lookup. Hetzner names are unique per project and per type. */
    getByName(name: string): Promise<T | null>;
    /** Patches the mutable common fields. Not every resource accepts `name`. */
    update(id: number, changes: { name?: string; labels?: Record<string, string> }): Promise<T>;
    /** Returns false when the resource was already gone (404). */
    delete(id: number): Promise<boolean>;
}

/** The extra hooks resource modules use to build their own operations. */
export interface ResourceInternals<T extends Labelled> {
    readonly http: HttpClient;
    readonly endpoint: ResourceEndpoint;
    /** POSTs to an action endpoint and waits for the action to finish. */
    runAction(id: number, name: string, body?: unknown): Promise<void>;
    /** POSTs to an action endpoint returning several actions, and waits for all. */
    runActions(id: number, name: string, body?: unknown): Promise<void>;
    /** Waits for an action returned by a non-action endpoint (e.g. create). */
    awaitAction(action: Action | undefined | null): Promise<void>;
    awaitActions(actions: Array<Action | undefined | null> | undefined): Promise<void>;
    /** POSTs to the collection and unwraps the singular key. */
    createRaw(body: unknown): Promise<{ resource: T; actions: Array<Action | undefined | null> }>;
}

export function createBaseResourceApi<T extends Labelled>(
    dependencies: ResourceClientDependencies,
    endpoint: ResourceEndpoint,
): BaseResourceApi<T> & ResourceInternals<T> {
    const { http, actions } = dependencies;
    const { plural, singular, scope } = endpoint;
    const collection = `/${plural}`;

    async function runAction(id: number, name: string, body?: unknown): Promise<void> {
        const response = await http.post<{ action?: Action; actions?: Action[] }>(
            `${collection}/${id}/actions/${name}`,
            body ?? {},
        );
        // Some endpoints answer with `action`, some with `actions`. Handle both
        // rather than making every caller remember which is which.
        if (response.actions?.length) {
            await actions.waitAll(response.actions, scope);
            return;
        }
        await actions.wait(response.action, scope);
    }

    return {
        http,
        endpoint,

        async get(id) {
            try {
                const response = await http.get<Record<string, T>>(`${collection}/${id}`);
                return response[singular] ?? null;
            } catch (error) {
                if (error instanceof HetznerApiError && error.isNotFound) {
                    return null;
                }
                throw error;
            }
        },

        list(params) {
            return http.list<T>(collection, plural, params ? { params } : undefined);
        },

        listByLabel(selector) {
            return http.list<T>(collection, plural, { params: { label_selector: selector } });
        },

        async getByName(name) {
            // Hetzner supports an exact `name` filter, so this stays one request
            // regardless of how many resources the project has.
            const matches = await http.list<T>(collection, plural, { params: { name } });
            return matches.find((entry) => entry.name === name) ?? null;
        },

        async update(id, changes) {
            const response = await http.put<Record<string, T>>(`${collection}/${id}`, changes);
            const updated = response[singular];
            if (!updated) {
                throw new Error(`Hetzner returned no "${singular}" when updating ${id}`);
            }
            return updated;
        },

        async delete(id) {
            try {
                // Delete is an action for some resources and a plain 204 for
                // others; wait on the action when there is one.
                const response = await http.delete<{ action?: Action } | undefined>(
                    `${collection}/${id}`,
                );
                await actions.wait(response?.action, scope);
                return true;
            } catch (error) {
                if (error instanceof HetznerApiError && error.isNotFound) {
                    // Somebody deleted it already — that is a success for us.
                    return false;
                }
                throw error;
            }
        },

        runAction,

        runActions(id, name, body) {
            return runAction(id, name, body);
        },

        awaitAction(action) {
            return actions.wait(action, scope);
        },

        awaitActions(list) {
            return actions.waitAll(list, scope);
        },

        async createRaw(body) {
            const response = await http.post<
                Record<string, unknown> & { action?: Action; actions?: Action[] }
            >(collection, body);
            const resource = response[singular] as T | undefined;
            if (!resource) {
                throw new Error(`Hetzner returned no "${singular}" when creating it`);
            }
            return {
                resource,
                actions: response.actions ?? (response.action ? [response.action] : []),
            };
        },
    };
}

/** Renders a Hetzner label selector from an exact-match label set. */
export function labelSelector(labels: Record<string, string>): string {
    return Object.entries(labels)
        .map(([key, value]) => `${key}=${value}`)
        .join(',');
}
