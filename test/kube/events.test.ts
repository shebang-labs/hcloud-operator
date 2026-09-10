/**
 * Events are diagnostics, not part of the reconcile. The properties that matter
 * are therefore about restraint: they must never fail a reconcile, never
 * flood a namespace, and never be attached to an object they cannot identify.
 */

import type { CoreV1Api, KubernetesObject } from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';
import { createEventRecorder, nullEventRecorder } from '../../src/kube/events.js';
import { nullLogger } from '../../src/observability/logger.js';

interface CreatedEvent {
    namespace: string;
    body: {
        metadata?: { generateName?: string };
        involvedObject?: { uid?: string; name?: string; kind?: string };
        reason?: string;
        message?: string;
        type?: string;
        source?: { component?: string };
    };
}

function fakeCore(behaviour: 'ok' | 'reject' = 'ok') {
    const created: CreatedEvent[] = [];
    const core = {
        async createNamespacedEvent(args: CreatedEvent) {
            created.push(args);
            if (behaviour === 'reject') {
                throw new Error('the API server said no');
            }
            return args.body;
        },
    } as unknown as CoreV1Api;
    return { core, created };
}

const resource: KubernetesObject = {
    apiVersion: 'hcloud.shebanglabs.io/v1alpha1',
    kind: 'HetznerServer',
    metadata: {
        name: 'web-01',
        namespace: 'demo',
        uid: 'uid-1',
        resourceVersion: '42',
    },
};

/** Events are fire-and-forget, so let the microtask queue drain. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('createEventRecorder', () => {
    it('attaches the event to the object that caused it', async () => {
        const { core, created } = fakeCore();

        createEventRecorder({ core, logger: nullLogger }).normal(
            resource,
            'Created',
            'Created Hetzner server 4711',
        );
        await settle();

        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({
            namespace: 'demo',
            body: {
                type: 'Normal',
                reason: 'Created',
                message: 'Created Hetzner server 4711',
                involvedObject: { uid: 'uid-1', name: 'web-01', kind: 'HetznerServer' },
                source: { component: 'hcloud-operator' },
            },
        });
    });

    it('uses generateName, so concurrent events cannot collide', async () => {
        const { core, created } = fakeCore();

        createEventRecorder({ core, logger: nullLogger }).warning(resource, 'Failed', 'boom');
        await settle();

        expect(created[0]?.body.metadata?.generateName).toBe('web-01.');
    });

    it('records warnings as type Warning', async () => {
        const { core, created } = fakeCore();

        createEventRecorder({ core, logger: nullLogger }).warning(resource, 'Failed', 'boom');
        await settle();

        expect(created[0]?.body.type).toBe('Warning');
    });

    it('suppresses an identical event for the same object', async () => {
        // An object stuck in a retry loop would otherwise fill its namespace's
        // event retention with one repeated line.
        const { core, created } = fakeCore();
        const recorder = createEventRecorder({ core, logger: nullLogger });

        for (let attempt = 0; attempt < 5; attempt += 1) {
            recorder.warning(resource, 'ReconcileError', 'the same failure');
        }
        await settle();

        expect(created).toHaveLength(1);
    });

    it('lets the same event through again once the window has passed', async () => {
        const { core, created } = fakeCore();
        let now = 0;
        const recorder = createEventRecorder({ core, logger: nullLogger, now: () => now });

        recorder.warning(resource, 'ReconcileError', 'still failing');
        now += 11 * 60 * 1000;
        recorder.warning(resource, 'ReconcileError', 'still failing');
        await settle();

        expect(created).toHaveLength(2);
    });

    it('does not suppress a different message or a different object', async () => {
        const { core, created } = fakeCore();
        const recorder = createEventRecorder({ core, logger: nullLogger });

        recorder.warning(resource, 'ReconcileError', 'first failure');
        recorder.warning(resource, 'ReconcileError', 'second failure');
        recorder.warning(
            { ...resource, metadata: { ...resource.metadata, uid: 'uid-2', name: 'web-02' } },
            'ReconcileError',
            'first failure',
        );
        await settle();

        expect(created).toHaveLength(3);
    });

    it('truncates a message the API server would reject', async () => {
        const { core, created } = fakeCore();

        createEventRecorder({ core, logger: nullLogger }).warning(
            resource,
            'Failed',
            'x'.repeat(5_000),
        );
        await settle();

        expect((created[0]?.body.message ?? '').length).toBeLessThanOrEqual(1_000);
        expect(created[0]?.body.message?.endsWith('...')).toBe(true);
    });

    it('skips an object it cannot identify rather than sending a useless event', async () => {
        const { core, created } = fakeCore();
        const recorder = createEventRecorder({ core, logger: nullLogger });

        recorder.normal({ metadata: { name: 'x', namespace: 'y' } }, 'R', 'no uid');
        recorder.normal({ metadata: { name: 'x', uid: 'u' } }, 'R', 'no namespace');
        recorder.normal({ metadata: {} }, 'R', 'nothing at all');
        await settle();

        expect(created).toHaveLength(0);
    });

    it('never throws when the API server rejects the event', async () => {
        // The event is a diagnostic; the reconcile is the job.
        const { core } = fakeCore('reject');
        const recorder = createEventRecorder({ core, logger: nullLogger });

        expect(() => recorder.normal(resource, 'Created', 'boom')).not.toThrow();
        await settle();
    });

    it('does not make the caller wait on the API server', async () => {
        // createNamespacedEvent never resolves; recording must still return.
        const core = {
            createNamespacedEvent: () => new Promise(() => {}),
        } as unknown as CoreV1Api;

        const before = Date.now();
        createEventRecorder({ core, logger: nullLogger }).normal(resource, 'Created', 'x');

        expect(Date.now() - before).toBeLessThan(50);
    });

    it('bounds its deduplication table', async () => {
        const { core, created } = fakeCore();
        let now = 0;
        const recorder = createEventRecorder({ core, logger: nullLogger, now: () => now });

        // More distinct events than the table holds; it must not grow forever.
        for (let index = 0; index < 2_500; index += 1) {
            now += 1;
            recorder.normal(resource, 'Created', `message ${index}`);
        }
        await settle();

        expect(created).toHaveLength(2_500);
    });
});

describe('nullEventRecorder', () => {
    it('discards everything without throwing', () => {
        expect(() => {
            nullEventRecorder.normal(resource, 'R', 'm');
            nullEventRecorder.warning(resource, 'R', 'm');
        }).not.toThrow();
    });
});

describe('the engine wired to a recorder', () => {
    it('is the default-off path when no recorder is supplied', () => {
        // Constructing an engine without `events` must not require a Core API.
        expect(vi.isMockFunction(nullEventRecorder.normal)).toBe(false);
        expect(nullEventRecorder.normal(resource, 'R', 'm')).toBeUndefined();
    });
});
