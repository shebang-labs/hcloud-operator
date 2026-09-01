/**
 * Spec fragments and helpers shared by several kinds.
 *
 * These are the pieces that recur across the Hetzner API — delete protection,
 * reverse DNS entries, a reference to another resource — expressed once so the
 * eleven CRDs stay consistent with each other and a user who has learned one
 * has learned them all.
 */

import type { ResourceRef } from '../framework/references.js';
import type { DnsPtr, Protection } from '../hcloud/types.js';

/** Delete (and for servers, rebuild) protection, as declared in a spec. */
export interface ProtectionSpec {
    /** Refuse deletion until this is turned off. */
    delete?: boolean;
    /** Servers only: refuse rebuild. */
    rebuild?: boolean;
}

/** One reverse DNS entry. */
export interface DnsPtrSpec {
    ip: string;
    /** The hostname to publish, or null to clear the entry. */
    dnsPtr: string | null;
}

/** True when the remote protection settings already match the spec. */
export function protectionMatches(
    actual: Protection | undefined,
    desired: ProtectionSpec | undefined,
): boolean {
    if (!desired) {
        return true; // Nothing requested: whatever is set is fine.
    }
    if (desired.delete !== undefined && (actual?.delete ?? false) !== desired.delete) {
        return false;
    }
    if (desired.rebuild !== undefined && (actual?.rebuild ?? false) !== desired.rebuild) {
        return false;
    }
    return true;
}

/** Converts a spec protection block into the API's payload shape. */
export function toProtectionPayload(desired: ProtectionSpec): Protection {
    return {
        ...(desired.delete !== undefined ? { delete: desired.delete } : {}),
        ...(desired.rebuild !== undefined ? { rebuild: desired.rebuild } : {}),
    };
}

/** Reverse DNS entries the spec asks for that are not set remotely yet. */
export function dnsPtrChanges(
    actual: DnsPtr[] | string | null | undefined,
    desired: DnsPtrSpec[] | undefined,
): DnsPtrSpec[] {
    if (!desired?.length) {
        return [];
    }
    const current = new Map<string, string | null>();
    if (Array.isArray(actual)) {
        for (const entry of actual) {
            current.set(entry.ip, entry.dns_ptr);
        }
    }
    return desired.filter((entry) => current.get(entry.ip) !== entry.dnsPtr);
}

/** Compares two lists of primitives regardless of order. */
export function sameSet<T extends string | number>(
    left: readonly T[] | undefined,
    right: readonly T[] | undefined,
): boolean {
    const a = [...(left ?? [])].sort();
    const b = [...(right ?? [])].sort();
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Structural equality for the small plain objects the Hetzner API uses. */
export function deepEqual(left: unknown, right: unknown): boolean {
    if (left === right) {
        return true;
    }
    if (typeof left !== typeof right || left === null || right === null) {
        return false;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
            return false;
        }
        return left.every((value, index) => deepEqual(value, right[index]));
    }
    if (typeof left !== 'object') {
        return false;
    }
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    // Undefined-valued keys are treated as absent: the Hetzner API omits fields
    // it has no value for, and a spec that omits them means the same thing.
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
        if (a[key] === undefined && b[key] === undefined) {
            continue;
        }
        if (!deepEqual(a[key], b[key])) {
            return false;
        }
    }
    return true;
}

/** A reference list that may be absent. */
export type Refs = readonly ResourceRef[] | undefined;

/** Records one applied change for the reconcile log and the status message. */
export class ChangeLog {
    private readonly entries: string[] = [];

    record(change: string): void {
        this.entries.push(change);
    }

    get changed(): boolean {
        return this.entries.length > 0;
    }

    get changes(): string[] {
        return [...this.entries];
    }
}
