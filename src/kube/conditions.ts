/**
 * Helpers for Kubernetes status conditions.
 *
 * Conditions are the standard way for a controller to report *why* a resource
 * is in some state. Every condition has a type ("Ready"), a status
 * ("True"/"False"/"Unknown"), a short machine readable reason and a human
 * message. `lastTransitionTime` must only change when the status flips — that
 * is what makes `kubectl describe` output useful, so we take care of it here.
 */

import type { ResourceCondition } from './api.js';

/** The Hetzner resource exists and is usable. */
export const CONDITION_READY = 'Ready';
/** The Hetzner resource matches the desired spec (no drift, no failed calls). */
export const CONDITION_SYNCED = 'Synced';
/** Every resource this one references exists and is Ready. */
export const CONDITION_DEPENDENCIES_READY = 'DependenciesReady';

/** Reasons the operator sets, collected so they can be alerted on by name. */
export const ConditionReason = {
    Creating: 'Creating',
    Created: 'Created',
    InSync: 'InSync',
    Updating: 'Updating',
    Deleting: 'Deleting',
    Adopted: 'Adopted',
    Orphaned: 'Orphaned',
    Ready: 'Ready',
    NotReady: 'NotReady',
    WaitingForDependency: 'WaitingForDependency',
    DependencyMissing: 'DependencyMissing',
    ImmutableFieldChanged: 'ImmutableFieldChanged',
    GuardRequired: 'GuardRequired',
    ReconcileError: 'ReconcileError',
} as const;

export interface ConditionInput {
    type: string;
    status: 'True' | 'False' | 'Unknown';
    reason: string;
    message: string;
    observedGeneration?: number;
}

/**
 * Returns a new condition list with `input` inserted or updated.
 * The input list is never modified.
 */
export function setCondition(
    conditions: ResourceCondition[] | undefined,
    input: ConditionInput,
    now: Date = new Date(),
): ResourceCondition[] {
    const existing = conditions ?? [];
    const previous = existing.find((condition) => condition.type === input.type);

    const next: ResourceCondition = {
        type: input.type,
        status: input.status,
        reason: input.reason,
        message: truncate(input.message),
        lastTransitionTime:
            previous && previous.status === input.status
                ? previous.lastTransitionTime
                : now.toISOString(),
        ...(input.observedGeneration !== undefined
            ? { observedGeneration: input.observedGeneration }
            : {}),
    };

    if (!previous) {
        return [...existing, next];
    }

    return existing.map((condition) => (condition.type === input.type ? next : condition));
}

/** Applies several conditions in one go. */
export function setConditions(
    conditions: ResourceCondition[] | undefined,
    inputs: ConditionInput[],
    now: Date = new Date(),
): ResourceCondition[] {
    return inputs.reduce<ResourceCondition[]>(
        (accumulator, input) => setCondition(accumulator, input, now),
        conditions ?? [],
    );
}

export function findCondition(
    conditions: ResourceCondition[] | undefined,
    type: string,
): ResourceCondition | undefined {
    return conditions?.find((condition) => condition.type === type);
}

/** True when the named condition is present and True. */
export function isConditionTrue(
    conditions: ResourceCondition[] | undefined,
    type: string,
): boolean {
    return findCondition(conditions, type)?.status === 'True';
}

/**
 * The Kubernetes API server rejects condition messages over 32768 bytes, and a
 * Hetzner validation error can carry a long detail blob. Truncate rather than
 * let a status write fail and hide the very error we are trying to report.
 */
const MAX_MESSAGE_LENGTH = 2_000;

function truncate(message: string, limit: number = MAX_MESSAGE_LENGTH): string {
    return message.length <= limit ? message : `${message.slice(0, limit - 3)}...`;
}

/** Long enough for any real error sentence, short enough for `kubectl describe`. */
const MAX_SUMMARY_LENGTH = 1_024;

/**
 * Reduces a caught error to the one line worth putting in a condition or Event.
 *
 * A `@kubernetes/client-node` ApiException's message is a multi-line blob:
 * "HTTP-Code: 409\nMessage: Conflict\nBody: {...}\nHeaders: {...}". Written
 * verbatim into status it fills `kubectl describe` with response headers, and
 * the sentence a user actually needs is buried inside the Status body. So only
 * the first line is kept, with the body's own message appended when there is
 * one, and the whole thing is capped so one error cannot bloat a status object.
 */
export function summarizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const firstLine = message.split(/\r?\n/, 1)[0]?.trim() ?? '';
    const detail = statusMessageOf(error);
    const summary = detail && detail !== firstLine ? `${firstLine}: ${detail}` : firstLine;
    return truncate(summary || 'unknown error', MAX_SUMMARY_LENGTH);
}

/** The `message` of a Kubernetes Status carried as an ApiException body, if any. */
function statusMessageOf(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('body' in error)) {
        return undefined;
    }
    const body = (error as { body: unknown }).body;
    if (typeof body !== 'object' || body === null || !('message' in body)) {
        return undefined;
    }
    const message = (body as { message: unknown }).message;
    return typeof message === 'string' && message.trim() ? message.trim() : undefined;
}

/** "uniqueness_error" -> "UniquenessError", for use as a condition reason. */
export function toReason(code: string): string {
    const camel = code
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
    return camel || 'Error';
}
