/**
 * Cross-resource references.
 *
 * A `HetznerServer` needs the numeric ids of its SSH keys, networks, firewalls,
 * volumes and placement group. Those may be other custom resources in the same
 * namespace, or they may be things that already exist in the Hetzner project
 * and are not managed here at all. Both must work, and neither may require the
 * user to know a numeric id.
 *
 * A reference is therefore one of three things:
 *
 *   { name: "prod-net" }         -> the HetznerNetwork CR "prod-net"
 *   { hetznerName: "legacy" }    -> an unmanaged resource, looked up by name
 *   { id: 4711 }                 -> a raw Hetzner id, the escape hatch
 *
 * The interesting case is the first one, because it creates an ordering
 * problem: the network may not exist yet when the server is first reconciled.
 * Rather than fail, the resolver throws `DependencyNotReadyError`, which the
 * engine turns into a `DependenciesReady=False` condition and a short requeue.
 * That is what makes `kubectl apply -f examples/stack/` work in one pass no
 * matter what order the files are in.
 */

import type { Labelled } from '../hcloud/types.js';
import {
    type AnyManagedResource,
    CONDITION_READY,
    isConditionTrue,
    type ResourceDescriptor,
} from '../kube/index.js';

/** A reference to another Hetzner resource, in any of the three forms. */
export interface ResourceRef {
    /** Name of a custom resource of the target kind. */
    name?: string;
    /** Namespace of that custom resource. Defaults to the referrer's. */
    namespace?: string;
    /** Name of an unmanaged resource inside the Hetzner project. */
    hetznerName?: string;
    /** Raw Hetzner id. */
    id?: number;
}

/** Thrown when a referenced resource exists but is not usable yet. */
export class DependencyNotReadyError extends Error {
    readonly kind: string;
    readonly ref: string;

    constructor(kind: string, ref: string, detail: string) {
        super(`${kind} "${ref}" is not ready yet: ${detail}`);
        this.name = 'DependencyNotReadyError';
        this.kind = kind;
        this.ref = ref;
    }
}

/** Thrown when a referenced resource does not exist at all. */
export class DependencyMissingError extends Error {
    readonly kind: string;
    readonly ref: string;

    constructor(kind: string, ref: string) {
        super(`${kind} "${ref}" does not exist`);
        this.name = 'DependencyMissingError';
        this.kind = kind;
        this.ref = ref;
    }
}

export function isDependencyError(
    error: unknown,
): error is DependencyNotReadyError | DependencyMissingError {
    return error instanceof DependencyNotReadyError || error instanceof DependencyMissingError;
}

/** What the resolver needs to look one kind up. Both stores are read-only here. */
export interface ReferenceTarget {
    descriptor: ResourceDescriptor;
    /** Reads the custom resource, for `{ name }` references. */
    get(namespace: string, name: string): Promise<AnyManagedResource | null>;
    /** Reads the Hetzner resource, for `{ hetznerName }` and `{ id }`. */
    remote: Pick<OwnedLookup, 'get' | 'getByName'>;
}

interface OwnedLookup {
    get(id: number): Promise<Labelled | null>;
    getByName(name: string): Promise<Labelled | null>;
}

export interface ReferenceResolver {
    /** Resolves one reference to a Hetzner id. */
    resolve(kind: string, ref: ResourceRef, defaultNamespace: string): Promise<number>;
    /** Resolves a list, preserving order. */
    resolveAll(
        kind: string,
        refs: readonly ResourceRef[] | undefined,
        defaultNamespace: string,
    ): Promise<number[]>;
}

/** Renders a reference for an error message. */
export function describeRef(ref: ResourceRef): string {
    if (ref.name) {
        return ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name;
    }
    if (ref.hetznerName) {
        return ref.hetznerName;
    }
    if (ref.id !== undefined) {
        return `#${ref.id}`;
    }
    return '<empty reference>';
}

export function createReferenceResolver(
    targets: ReadonlyMap<string, ReferenceTarget>,
): ReferenceResolver {
    async function resolve(
        kind: string,
        ref: ResourceRef,
        defaultNamespace: string,
    ): Promise<number> {
        if (ref.id !== undefined) {
            // A raw Hetzner id needs no lookup, and therefore no registered
            // kind: it is already the answer.
            return ref.id;
        }

        const target = targets.get(kind);
        if (!target) {
            throw new Error(
                `No reference target registered for kind "${kind}". This is an operator bug.`,
            );
        }

        if (ref.hetznerName) {
            const remote = await target.remote.getByName(ref.hetznerName);
            if (!remote) {
                throw new DependencyMissingError(kind, ref.hetznerName);
            }
            return remote.id;
        }

        if (!ref.name) {
            throw new Error(
                `Reference to ${kind} has none of "name", "hetznerName" or "id" set. ` +
                    'The CRD schema should have rejected this.',
            );
        }

        const namespace = ref.namespace ?? defaultNamespace;
        const resource = await target.get(namespace, ref.name);
        if (!resource) {
            throw new DependencyMissingError(kind, `${namespace}/${ref.name}`);
        }

        const id = resource.status?.id;
        if (id === undefined) {
            throw new DependencyNotReadyError(
                kind,
                `${namespace}/${ref.name}`,
                'it has no Hetzner id in its status yet',
            );
        }

        if (!isConditionTrue(resource.status?.conditions, CONDITION_READY)) {
            throw new DependencyNotReadyError(
                kind,
                `${namespace}/${ref.name}`,
                resource.status?.message ?? 'its Ready condition is not True',
            );
        }

        return id;
    }

    return {
        resolve,
        async resolveAll(kind, refs, defaultNamespace) {
            if (!refs?.length) {
                return [];
            }
            // Sequential on purpose: resolving in order means the first
            // unresolvable reference is the one reported, which is far easier to
            // act on than "one of these five is missing".
            const ids: number[] = [];
            for (const ref of refs) {
                ids.push(await resolve(kind, ref, defaultNamespace));
            }
            return ids;
        },
    };
}
