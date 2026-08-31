/**
 * An in-memory `ResourceStore`, plus the builders that make a custom resource.
 *
 * The store reproduces the parts of the Kubernetes API the reconcile engine
 * depends on and nothing else: merge-patched status, finalizer lists, and
 * "reads see the last write". It also records every status patch, because most
 * engine assertions are really about what ended up in `.status`.
 */

import type {
    CommonSpec,
    CommonStatus,
    ManagedResource,
    ResourceCondition,
} from '../../src/kube/api.js';
import { FINALIZER } from '../../src/kube/api.js';
import type { ResourceStore } from '../../src/kube/store.js';

export class FakeResourceStore<T extends ManagedResource<CommonSpec, CommonStatus>>
    implements ResourceStore<T>
{
    private readonly objects = new Map<string, T>();

    /** Every status patch that was applied, in order. */
    readonly statusPatches: Array<{ key: string; status: Partial<CommonStatus> }> = [];
    /** Set to make the next patchStatus throw, simulating a lost race. */
    failNextStatusPatch?: Error;

    add(resource: T): T {
        this.objects.set(keyOf(resource), resource);
        return resource;
    }

    /** The object as it stands now, for assertions. */
    current(namespace: string, name: string): T | undefined {
        return this.objects.get(`${namespace}/${name}`);
    }

    /** Removes the object, as the API server does once finalizers are gone. */
    drop(namespace: string, name: string): void {
        this.objects.delete(`${namespace}/${name}`);
    }

    async get(namespace: string, name: string): Promise<T | null> {
        return this.objects.get(`${namespace}/${name}`) ?? null;
    }

    async list(namespace?: string): Promise<T[]> {
        return [...this.objects.values()].filter(
            (object) => !namespace || object.metadata?.namespace === namespace,
        );
    }

    async patchStatus(namespace: string, name: string, status: T['status']): Promise<T | null> {
        if (this.failNextStatusPatch) {
            const error = this.failNextStatusPatch;
            this.failNextStatusPatch = undefined as never;
            throw error;
        }

        const key = `${namespace}/${name}`;
        const object = this.objects.get(key);
        if (!object) {
            return null;
        }
        this.statusPatches.push({ key, status: (status ?? {}) as Partial<CommonStatus> });
        // A merge patch replaces whole fields, including the conditions array —
        // which is exactly what the real API server does.
        object.status = { ...(object.status ?? {}), ...(status ?? {}) } as T['status'];
        return object;
    }

    async addFinalizer(resource: T): Promise<boolean> {
        const object = this.objects.get(keyOf(resource));
        if (!object) {
            return false;
        }
        const finalizers = object.metadata?.finalizers ?? [];
        if (finalizers.includes(FINALIZER)) {
            return false;
        }
        object.metadata = { ...object.metadata, finalizers: [...finalizers, FINALIZER] };
        return true;
    }

    async removeFinalizer(resource: T): Promise<boolean> {
        const object = this.objects.get(keyOf(resource));
        if (!object) {
            return false;
        }
        const finalizers = object.metadata?.finalizers ?? [];
        if (!finalizers.includes(FINALIZER)) {
            return false;
        }
        object.metadata = {
            ...object.metadata,
            finalizers: finalizers.filter((entry) => entry !== FINALIZER),
        };
        return true;
    }

    /** The condition of a given type on an object, for assertions. */
    condition(namespace: string, name: string, type: string): ResourceCondition | undefined {
        return this.current(namespace, name)?.status?.conditions?.find(
            (condition) => condition.type === type,
        );
    }
}

function keyOf(resource: { metadata?: { namespace?: string; name?: string } }): string {
    return `${resource.metadata?.namespace ?? 'default'}/${resource.metadata?.name ?? ''}`;
}

let uidCounter = 0;

export interface BuildOptions {
    name?: string;
    namespace?: string;
    uid?: string;
    generation?: number;
    /** Start with the operator's finalizer already in place. */
    finalized?: boolean;
    deleting?: boolean;
}

/** Builds a custom resource of any kind, with sensible defaults. */
export function buildResource<TSpec extends CommonSpec, TStatus extends CommonStatus>(
    kind: string,
    spec: TSpec,
    options: BuildOptions = {},
): ManagedResource<TSpec, TStatus> {
    uidCounter += 1;
    const name = options.name ?? 'example';
    const namespace = options.namespace ?? 'default';

    return {
        apiVersion: 'hcloud.shebanglabs.io/v1alpha1',
        kind,
        metadata: {
            name,
            namespace,
            uid: options.uid ?? `uid-${uidCounter}`,
            generation: options.generation ?? 1,
            resourceVersion: '1',
            ...(options.finalized !== false ? { finalizers: [FINALIZER] } : { finalizers: [] }),
            ...(options.deleting ? { deletionTimestamp: new Date().toISOString() } : {}),
        },
        spec,
    };
}
