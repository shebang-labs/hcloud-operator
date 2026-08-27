/**
 * Everything the operator does against the Kubernetes API for its custom
 * resources: read one object, list them, write status, and add or remove the
 * finalizer.
 *
 * Generic over the kind, so all eleven controllers share one implementation and
 * the reconcile engine only ever talks to the `ResourceStore` interface — which
 * is what lets every engine test run against an in-memory fake.
 */

import {
    ApiException,
    type CustomObjectsApi,
    PatchStrategy,
    setHeaderOptions,
} from '@kubernetes/client-node';
import {
    type CommonSpec,
    type CommonStatus,
    FINALIZER,
    GROUP,
    type ManagedResource,
    type ResourceDescriptor,
    VERSION,
} from './api.js';

export interface ResourceStore<T extends ManagedResource<CommonSpec, CommonStatus>> {
    /** Reads the current object from the API server. Returns null on 404. */
    get(namespace: string, name: string): Promise<T | null>;
    /** Lists objects, either cluster wide or in one namespace. */
    list(namespace?: string): Promise<T[]>;
    /** Merge-patches the /status subresource. Returns null if the object is gone. */
    patchStatus(namespace: string, name: string, status: T['status']): Promise<T | null>;
    /** Adds our finalizer if it is missing. Returns true when it patched. */
    addFinalizer(resource: T): Promise<boolean>;
    /** Removes our finalizer, which lets Kubernetes delete the object. */
    removeFinalizer(resource: T): Promise<boolean>;
}

/** True for "the object does not exist" style API errors. */
export function isNotFoundError(error: unknown): boolean {
    return error instanceof ApiException && error.code === 404;
}

/** True for optimistic-concurrency / conflict errors, which are safe to retry. */
export function isConflictError(error: unknown): boolean {
    return error instanceof ApiException && error.code === 409;
}

const mergePatch = setHeaderOptions('Content-Type', PatchStrategy.MergePatch);

export function createResourceStore<T extends ManagedResource<CommonSpec, CommonStatus>>(
    api: CustomObjectsApi,
    descriptor: ResourceDescriptor,
): ResourceStore<T> {
    const group = descriptor.group ?? GROUP;
    const version = descriptor.version ?? VERSION;
    const base = { group, version, plural: descriptor.plural };

    async function patchMetadata(resource: T, finalizers: string[]): Promise<boolean> {
        const namespace = resource.metadata?.namespace;
        const name = resource.metadata?.name;
        if (!namespace || !name) {
            throw new Error('Cannot patch a resource without namespace and name');
        }

        try {
            await api.patchNamespacedCustomObject(
                {
                    ...base,
                    namespace,
                    name,
                    // resourceVersion makes this a compare-and-swap: if somebody
                    // else changed the object in the meantime the API server
                    // answers 409 and we simply reconcile again.
                    body: {
                        metadata: {
                            resourceVersion: resource.metadata?.resourceVersion,
                            finalizers,
                        },
                    },
                },
                mergePatch,
            );
            return true;
        } catch (error) {
            if (isNotFoundError(error)) {
                // Object is already gone; nothing left to do.
                return false;
            }
            throw error;
        }
    }

    return {
        async get(namespace, name) {
            try {
                return (await api.getNamespacedCustomObject({ ...base, namespace, name })) as T;
            } catch (error) {
                if (isNotFoundError(error)) {
                    return null;
                }
                throw error;
            }
        },

        async list(namespace) {
            const response = namespace
                ? await api.listNamespacedCustomObject({ ...base, namespace })
                : await api.listCustomObjectForAllNamespaces({
                      group,
                      version,
                      resourcePlural: descriptor.plural,
                  });
            return (response?.items ?? []) as T[];
        },

        async patchStatus(namespace, name, status) {
            try {
                return (await api.patchNamespacedCustomObjectStatus(
                    { ...base, namespace, name, body: { status } },
                    mergePatch,
                )) as T;
            } catch (error) {
                if (isNotFoundError(error)) {
                    // The object was deleted while we were reconciling it.
                    return null;
                }
                throw error;
            }
        },

        async addFinalizer(resource) {
            const current = resource.metadata?.finalizers ?? [];
            if (current.includes(FINALIZER)) {
                return false;
            }
            return patchMetadata(resource, [...current, FINALIZER]);
        },

        async removeFinalizer(resource) {
            const current = resource.metadata?.finalizers ?? [];
            if (!current.includes(FINALIZER)) {
                return false;
            }
            return patchMetadata(
                resource,
                current.filter((entry) => entry !== FINALIZER),
            );
        },
    };
}
