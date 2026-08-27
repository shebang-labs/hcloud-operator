/**
 * The Kubernetes API contract shared by every kind this operator owns.
 *
 * One group, one version, one finalizer scheme, one status shape. Keeping these
 * in a single file means adding a twelfth kind cannot accidentally invent a
 * second convention — and the CRDs in `charts/hetzner-server-controller/crds/` can be diffed against it.
 */

import type { KubernetesObject } from '@kubernetes/client-node';

/** API group of every CRD this operator serves. */
export const GROUP = 'hcloud.shebanglabs.io';
export const VERSION = 'v1alpha1';
export const API_VERSION = `${GROUP}/${VERSION}`;

/**
 * Finalizer key. Kubernetes will not remove an object that still carries a
 * finalizer, which is exactly how we get a chance to delete the Hetzner
 * resource before the Kubernetes object disappears.
 */
export const FINALIZER = `${GROUP}/finalizer`;

/** Hetzner-side labels that tie a cloud resource back to its Kubernetes object. */
export const OwnerLabel = {
    ManagedBy: `${GROUP}/managed-by`,
    Uid: `${GROUP}/uid`,
    Namespace: `${GROUP}/namespace`,
    Name: `${GROUP}/name`,
    Kind: `${GROUP}/kind`,
} as const;

export const MANAGED_BY_VALUE = 'hetzner-server-controller';

/** Identifies one kind: everything needed to address it over the API. */
export interface ResourceDescriptor {
    kind: string;
    /** Lower-case plural used in the REST path, e.g. "hetznerservers". */
    plural: string;
    /** Short name shown in `kubectl get`, e.g. "hsrv". */
    shortName: string;
    group?: string;
    version?: string;
}

export type Phase = 'Pending' | 'Creating' | 'Ready' | 'Updating' | 'Deleting' | 'Error';

export interface ResourceCondition {
    type: string;
    status: 'True' | 'False' | 'Unknown';
    reason: string;
    message: string;
    lastTransitionTime: string;
    observedGeneration?: number;
}

/** Status fields every kind carries. Kinds add their own on top. */
export interface CommonStatus {
    phase?: Phase;
    /** Hetzner numeric id. This is the link between both worlds. */
    id?: number;
    /** Name the resource has inside the Hetzner project. */
    hetznerName?: string;
    message?: string;
    /** metadata.generation this status was calculated from. */
    observedGeneration?: number;
    conditions?: ResourceCondition[];
}

/** What to do with the Hetzner resource when the Kubernetes object is deleted. */
export type DeletionPolicy = 'Delete' | 'Orphan';

/** Spec fields every kind carries. */
export interface CommonSpec {
    /**
     * Take over a resource that already exists in the Hetzner project instead of
     * creating one. Accepts a Hetzner name or a numeric id. This is the
     * migration path for a project that predates the operator.
     */
    adoptExisting?: string;
    /**
     * `Delete` (the default) removes the Hetzner resource along with the
     * Kubernetes object. `Orphan` leaves it running and only drops the
     * finalizer — the safety catch for production data.
     */
    deletionPolicy?: DeletionPolicy;
    /** Labels to set on the Hetzner resource, on top of the ownership labels. */
    labels?: Record<string, string>;
}

/** A custom resource of any kind this operator owns. */
export interface ManagedResource<TSpec extends CommonSpec, TStatus extends CommonStatus>
    extends KubernetesObject {
    apiVersion?: string;
    kind?: string;
    spec: TSpec;
    status?: TStatus;
}

/** Any managed resource, when the concrete spec does not matter. */
export type AnyManagedResource = ManagedResource<CommonSpec, CommonStatus>;

/** "<namespace>/<name>" — the key a controller queues instead of the object. */
export function resourceKey(resource: KubernetesObject): string {
    return `${resource.metadata?.namespace ?? 'default'}/${resource.metadata?.name ?? ''}`;
}

export function parseResourceKey(key: string): { namespace: string; name: string } {
    const separator = key.indexOf('/');
    if (separator < 0) {
        throw new Error(`Invalid resource key "${key}", expected "<namespace>/<name>"`);
    }
    return { namespace: key.slice(0, separator), name: key.slice(separator + 1) };
}

/** The REST path an informer watches for one kind. */
export function watchPath(descriptor: ResourceDescriptor, namespace?: string): string {
    const group = descriptor.group ?? GROUP;
    const version = descriptor.version ?? VERSION;
    return namespace
        ? `/apis/${group}/${version}/namespaces/${namespace}/${descriptor.plural}`
        : `/apis/${group}/${version}/${descriptor.plural}`;
}
