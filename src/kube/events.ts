/**
 * Kubernetes Events.
 *
 * Conditions say what a resource's state *is*; events say what the operator
 * *did*, and in what order. `kubectl describe hsrv web-01` showing "Resized
 * from cpx21 to cpx31" and then "Powered on" is the difference between a user
 * diagnosing a problem themselves and opening an issue.
 *
 * Three rules keep this from becoming a liability:
 *
 *  1. Best effort. Emitting an event must never fail a reconcile — the event is
 *     a diagnostic, the reconcile is the job.
 *  2. Transitions only. Callers emit when something actually changed or failed,
 *     never on a steady-state pass, so a healthy cluster produces no events.
 *  3. Deduplicated. An object stuck in a retry loop would otherwise emit the
 *     same event at every backoff tick until its retention window fills with
 *     one repeated line.
 */

import type { CoreV1Api, KubernetesObject } from '@kubernetes/client-node';
import type { Logger } from '../observability/logger.js';

export type EventType = 'Normal' | 'Warning';

export interface EventRecorder {
    /** Something expected happened: created, resized, deleted. */
    normal(resource: KubernetesObject, reason: string, message: string): void;
    /** Something went wrong, or needs a human: a failure, a blocked change. */
    warning(resource: KubernetesObject, reason: string, message: string): void;
}

/** How long an identical event is suppressed for one object. */
const DEDUPLICATION_WINDOW_MS = 10 * 60 * 1000;
/** Upper bound on the dedup table, so it cannot grow without limit. */
const MAX_TRACKED_EVENTS = 2_000;
/** The API server rejects a message over 1KiB. */
const MAX_MESSAGE_LENGTH = 1_000;

export interface EventRecorderOptions {
    core: CoreV1Api;
    logger: Logger;
    /** Value for `source.component`; identifies this operator in the event. */
    component?: string;
    now?: () => number;
}

export function createEventRecorder(options: EventRecorderOptions): EventRecorder {
    const { core, logger } = options;
    const component = options.component ?? 'hetzner-server-controller';
    const now = options.now ?? (() => Date.now());
    const recentlySent = new Map<string, number>();

    /** True when this exact event was already sent for this object recently. */
    function isDuplicate(key: string): boolean {
        const sentAt = recentlySent.get(key);
        if (sentAt !== undefined && now() - sentAt < DEDUPLICATION_WINDOW_MS) {
            return true;
        }
        if (recentlySent.size >= MAX_TRACKED_EVENTS) {
            // Cheaper than tracking access order, and the consequence of
            // dropping the table is one duplicate event, not a fault.
            recentlySent.clear();
        }
        recentlySent.set(key, now());
        return false;
    }

    function emit(
        resource: KubernetesObject,
        type: EventType,
        reason: string,
        message: string,
    ): void {
        const namespace = resource.metadata?.namespace;
        const name = resource.metadata?.name;
        const uid = resource.metadata?.uid;
        if (!namespace || !name || !uid) {
            // Nothing to attach the event to. Not worth failing over.
            return;
        }

        const truncated =
            message.length <= MAX_MESSAGE_LENGTH
                ? message
                : `${message.slice(0, MAX_MESSAGE_LENGTH - 3)}...`;

        if (isDuplicate(`${uid}/${type}/${reason}/${truncated}`)) {
            return;
        }

        const timestamp = new Date(now());

        // Deliberately not awaited: a reconcile must not wait on, or fail
        // because of, a diagnostic write.
        void core
            .createNamespacedEvent({
                namespace,
                body: {
                    metadata: {
                        // The API server appends a unique suffix, so concurrent
                        // events for one object cannot collide.
                        generateName: `${name}.`,
                        namespace,
                    },
                    involvedObject: {
                        apiVersion: resource.apiVersion,
                        kind: resource.kind,
                        namespace,
                        name,
                        uid,
                        resourceVersion: resource.metadata?.resourceVersion,
                    },
                    reason,
                    message: truncated,
                    type,
                    source: { component },
                    firstTimestamp: timestamp,
                    lastTimestamp: timestamp,
                    eventTime: timestamp,
                    reportingComponent: component,
                    reportingInstance: component,
                    action: reason,
                    count: 1,
                },
            })
            .catch((error) => {
                logger.debug('Could not record an event', {
                    resource: `${namespace}/${name}`,
                    reason,
                    error,
                });
            });
    }

    return {
        normal: (resource, reason, message) => emit(resource, 'Normal', reason, message),
        warning: (resource, reason, message) => emit(resource, 'Warning', reason, message),
    };
}

/** An recorder that discards everything. The default when none is supplied. */
export const nullEventRecorder: EventRecorder = {
    normal: () => {},
    warning: () => {},
};
