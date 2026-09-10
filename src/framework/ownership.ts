/**
 * Ownership: how a Hetzner resource is tied back to the Kubernetes object that
 * asked for it.
 *
 * Every resource the operator creates carries labels pointing at its owner:
 *
 *   hcloud.shebanglabs.io/managed-by = hcloud-operator
 *   hcloud.shebanglabs.io/uid        = metadata.uid   <- the stable primary key
 *   hcloud.shebanglabs.io/namespace  = metadata.namespace
 *   hcloud.shebanglabs.io/name       = metadata.name
 *   hcloud.shebanglabs.io/kind       = HetznerServer
 *
 * `metadata.uid` is assigned by Kubernetes and never reused, not even when an
 * object with the same name is recreated. That makes it a perfect primary key,
 * and it is why the operator can always answer "does a resource for this object
 * already exist?" — even after crashing between creating a server and writing
 * `status.id`.
 */

import { labelSelector } from '../hcloud/resources/base.js';
import type { Labelled } from '../hcloud/types.js';
import {
    type CommonSpec,
    type CommonStatus,
    MANAGED_BY_VALUE,
    type ManagedResource,
    OwnerLabel,
} from '../kube/api.js';

/**
 * Hetzner label values must look like Kubernetes ones: at most 63 characters,
 * starting and ending alphanumeric. Kubernetes namespaces, names and UIDs
 * already satisfy this, but a user-supplied `spec.labels` value may not, so
 * anything we generate is sanitized rather than trusted.
 */
export function sanitizeLabelValue(value: string): string {
    return (
        value
            // A run of invalid characters collapses to one dash. Replacing each
            // one separately would turn a single emoji — two UTF-16 code units —
            // into "--", which reads like a typo in the Hetzner console.
            .replace(/[^a-zA-Z0-9._-]+/g, '-')
            .replace(/^[^a-zA-Z0-9]+/, '')
            .replace(/[^a-zA-Z0-9]+$/, '')
            .slice(0, 63)
            // Truncation can leave a trailing separator behind.
            .replace(/[^a-zA-Z0-9]+$/, '')
    );
}

/** The labels that mark a Hetzner resource as belonging to this object. */
export function buildOwnerLabels(
    resource: ManagedResource<CommonSpec, CommonStatus>,
    kind: string,
): Record<string, string> {
    const metadata = resource.metadata ?? {};
    return {
        [OwnerLabel.ManagedBy]: MANAGED_BY_VALUE,
        [OwnerLabel.Uid]: sanitizeLabelValue(metadata.uid ?? ''),
        [OwnerLabel.Namespace]: sanitizeLabelValue(metadata.namespace ?? ''),
        [OwnerLabel.Name]: sanitizeLabelValue(metadata.name ?? ''),
        [OwnerLabel.Kind]: sanitizeLabelValue(kind),
    };
}

/**
 * Ownership labels plus the user's `spec.labels`.
 *
 * User labels come first so an ownership key can never be overwritten by one:
 * losing the uid label would orphan a running server.
 */
export function buildLabels(
    resource: ManagedResource<CommonSpec, CommonStatus>,
    kind: string,
): Record<string, string> {
    return {
        ...(resource.spec.labels ?? {}),
        ...buildOwnerLabels(resource, kind),
    };
}

/** The Hetzner label selector that finds this object's resource. */
export function ownerSelector(uid: string): string {
    return labelSelector({ [OwnerLabel.Uid]: sanitizeLabelValue(uid) });
}

/** True when the remote resource carries this object's uid. */
export function isOwnedBy(remote: Labelled, uid: string): boolean {
    return remote.labels?.[OwnerLabel.Uid] === sanitizeLabelValue(uid);
}

/**
 * True when the resource is managed by this operator on behalf of a *different*
 * Kubernetes object. Adopting one of those would give two objects the same
 * resource, and whichever is deleted first would take it away from the other.
 */
export function isOwnedByAnother(remote: Labelled, uid: string): boolean {
    const owner = remote.labels?.[OwnerLabel.Uid];
    return Boolean(owner) && owner !== sanitizeLabelValue(uid);
}

/** True when nothing claims the resource, so it is free to adopt. */
export function isUnowned(remote: Labelled): boolean {
    return !remote.labels?.[OwnerLabel.Uid];
}

/** Hetzner's maximum resource name length. */
const MAX_NAME_LENGTH = 63;
/** Characters reserved for the disambiguating suffix, including its dash. */
const SUFFIX_LENGTH = 7;

/**
 * Hetzner names must be valid hostnames. Kubernetes names already are, but
 * "<namespace>-<name>" can exceed the allowed length.
 *
 * Plain truncation is not enough: `a-very-long-namespace/web` and
 * `a-very-long-namespace/worker` can truncate to the same string, and Hetzner
 * names are unique per project. The second object would then fail its create
 * with `uniqueness_error` forever — and the recovery path would not save it,
 * because the existing resource carries a *different* owner uid. So when the
 * name has to be shortened, a short digest of the full name is appended to keep
 * it unique.
 *
 * The name is otherwise cosmetic: resources are identified by id and by the
 * ownership labels, never by name.
 */
export function hetznerResourceName(namespace: string, name: string): string {
    const full = `${namespace}-${name}`.toLowerCase().replace(/[^a-z0-9.-]/g, '-');

    const trimmed =
        full.length <= MAX_NAME_LENGTH
            ? full
            : `${full.slice(0, MAX_NAME_LENGTH - SUFFIX_LENGTH)}-${digest(full)}`;

    return trimmed.replace(/^[.-]+/, '').replace(/[.-]+$/, '');
}

/**
 * A short, stable, lower-case-alphanumeric digest.
 *
 * FNV-1a rather than a cryptographic hash: this is collision *avoidance* for
 * cosmetic names, not a security boundary, and it keeps the function pure and
 * dependency-free.
 */
function digest(value: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36).padStart(6, '0').slice(0, 6);
}

/** True when the resource already carries exactly the labels we want. */
export function labelsMatch(
    actual: Record<string, string> | undefined,
    desired: Record<string, string>,
): boolean {
    const current = actual ?? {};
    const currentKeys = Object.keys(current);
    const desiredKeys = Object.keys(desired);
    if (currentKeys.length !== desiredKeys.length) {
        return false;
    }
    return desiredKeys.every((key) => current[key] === desired[key]);
}
