/**
 * The controller's watch machinery, against a real informer talking to a fake
 * API server over HTTP.
 *
 * This is the closest thing available to an envtest here: the actual
 * `@kubernetes/client-node` informer does a real LIST and a real chunked WATCH.
 * Stubbing it would leave the code most likely to be wrong — reconnection,
 * resync, the startup list — completely unexercised.
 */

import { CustomObjectsApi } from '@kubernetes/client-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReconcileEngine } from '../../src/framework/reconcile-engine.js';
import { createReferenceResolver } from '../../src/framework/references.js';
import { ResourceController } from '../../src/framework/resource-controller.js';
import type { ResourceAdapter } from '../../src/framework/types.js';
import type { Labelled } from '../../src/hcloud/types.js';
import type { AnyManagedResource, CommonSpec, CommonStatus } from '../../src/kube/api.js';
import { GROUP, VERSION } from '../../src/kube/api.js';
import { createResourceStore } from '../../src/kube/store.js';
import type { LogLevel } from '../../src/observability/logger.js';
import { createLogger, nullLogger } from '../../src/observability/logger.js';
import { createMetrics } from '../../src/observability/metrics.js';
import { eventually, FakeApiServer } from '../support/fake-apiserver.js';

const descriptor = { kind: 'HetznerSSHKey', plural: 'hetznersshkeys', shortName: 'hkey' };

function sshKey(name: string): AnyManagedResource {
    return {
        apiVersion: `${GROUP}/${VERSION}`,
        kind: 'HetznerSSHKey',
        metadata: { name, namespace: 'default', uid: `uid-${name}`, resourceVersion: '1' },
        spec: {},
    };
}

/** The same object at a known `metadata.generation`. */
function sshKeyAt(name: string, generation: number): AnyManagedResource {
    const resource = sshKey(name);
    resource.metadata = { ...resource.metadata, generation };
    return resource;
}

let api: FakeApiServer;
let controller: ResourceController<CommonSpec, CommonStatus, Labelled>;
/** Keys the engine was asked to reconcile, in order. */
let reconciled: string[];
/** Set by a test to hold every reconcile open until it resolves. */
let holdReconcile: Promise<void> | undefined;

/** An adapter that records what it was asked to do and touches nothing. */
function recordingEngine() {
    const adapter = {
        descriptor,
        api: {
            get: async () => null,
            listByLabel: async () => [],
            getByName: async () => null,
            update: async () => ({ id: 1 }),
            delete: async () => true,
        },
        create: async () => ({ id: 1 }),
        update: async () => ({ changed: false }),
        project: () => ({
            ready: true,
            phase: 'Ready' as const,
            message: '',
            status: {},
        }),
    } satisfies ResourceAdapter<CommonSpec, CommonStatus, Labelled>;

    const store = createResourceStore<AnyManagedResource>(
        api.kubeConfig().makeApiClient(CustomObjectsApi),
        descriptor,
    );

    const engine = new ReconcileEngine({
        adapter,
        store,
        refs: createReferenceResolver(new Map()),
        logger: nullLogger,
    });
    // The engine itself is covered elsewhere; here we only care that the
    // controller routes the right keys to it.
    vi.spyOn(engine, 'reconcile').mockImplementation(async (namespace, name) => {
        reconciled.push(`${namespace}/${name}`);
        await holdReconcile;
        return {};
    });

    return { engine, store };
}

function build(overrides: Partial<ConstructorParameters<typeof ResourceController>[0]> = {}) {
    const { engine, store } = recordingEngine();
    const kubeConfig = api.kubeConfig();

    return new ResourceController<CommonSpec, CommonStatus, Labelled>({
        descriptor,
        clients: {
            kubeConfig,
            customObjects: kubeConfig.makeApiClient(CustomObjectsApi),
            coordination: {} as never,
            core: {} as never,
            inCluster: false,
        },
        store,
        engine,
        logger: nullLogger,
        resyncPeriodMs: 60_000,
        concurrency: 1,
        retryBaseDelayMs: 10,
        retryMaxDelayMs: 100,
        ...overrides,
    });
}

beforeEach(async () => {
    reconciled = [];
    holdReconcile = undefined;
    api = new FakeApiServer({
        group: GROUP,
        version: VERSION,
        plural: descriptor.plural,
        kind: descriptor.kind,
    });
    await api.start();
});

afterEach(async () => {
    await controller?.stop();
    await api.stop();
});

describe('startup', () => {
    it('reconciles everything that already exists, so a restart is safe', async () => {
        // The whole point: after a Pod restart the operator must not assume an
        // empty world.
        api.seed(sshKey('web-01'));
        api.seed(sshKey('web-02'));

        controller = build();
        await controller.start();

        await eventually(() => new Set(reconciled).size >= 2);
        expect([...new Set(reconciled)].sort()).toEqual(['default/web-01', 'default/web-02']);
    });

    it('reconciles each existing object once, not once per list', async () => {
        // The startup preflight and the informer's own initial list would
        // otherwise both enqueue, doubling the Hetzner API calls on every boot.
        api.seed(sshKey('web-01'));

        controller = build();
        await controller.start();
        await eventually(() => reconciled.length >= 1);
        await new Promise((resolve) => setTimeout(resolve, 150));

        expect(reconciled.filter((key) => key === 'default/web-01')).toHaveLength(1);
    });

    it('reports itself synced only after the initial list and watch', async () => {
        controller = build();
        expect(controller.synced).toBe(false);

        await controller.start();

        expect(controller.synced).toBe(true);
    });

    it('fails loudly when the initial list fails', async () => {
        // At startup this means a missing CRD or wrong RBAC. Coming up healthy
        // and silently reconciling nothing would be far worse.
        api.failListWith = 403;
        controller = build();

        await expect(controller.start()).rejects.toThrow();
        expect(controller.synced).toBe(false);
    });

    it('opens a watch', async () => {
        controller = build();
        await controller.start();

        await eventually(() => api.openWatches > 0);
    });
});

describe('watch events', () => {
    beforeEach(async () => {
        controller = build();
        await controller.start();
        await eventually(() => api.openWatches > 0);
        reconciled.length = 0;
    });

    it('reconciles an object that appears', async () => {
        api.emit('ADDED', sshKey('web-01'));

        await eventually(() => reconciled.includes('default/web-01'));
    });

    it('reconciles an object that changes', async () => {
        api.emit('ADDED', sshKey('web-01'));
        await eventually(() => reconciled.includes('default/web-01'));
        reconciled.length = 0;

        api.emit('MODIFIED', sshKey('web-01'));

        await eventually(() => reconciled.includes('default/web-01'));
    });

    it('does not reconcile an object that is gone', async () => {
        api.emit('ADDED', sshKey('web-01'));
        await eventually(() => reconciled.includes('default/web-01'));
        reconciled.length = 0;

        api.emit('DELETED', sshKey('web-01'));

        // A delete event arrives after the finalizer is gone; there is nothing
        // left to reconcile, and the queue only needs to drop its backoff state.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(reconciled).not.toContain('default/web-01');
    });

    it('ignores an event that only changed the status', async () => {
        // The engine writes status on every pass, and each write comes back as
        // a MODIFIED event. Acting on it makes the operator wake itself up: the
        // queue sees the key go dirty, treats that as "the spec changed", and
        // drops the delay it was about to apply. That is the hot loop that made
        // a server blocked on Hetzner capacity re-POST for half an hour.
        api.emit('ADDED', sshKeyAt('web-01', 4));
        await eventually(() => reconciled.includes('default/web-01'));
        reconciled.length = 0;

        // Same generation: the API server leaves it alone for a status write.
        api.emit('MODIFIED', sshKeyAt('web-01', 4));

        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(reconciled).not.toContain('default/web-01');
    });

    it('reconciles when the generation moves, which is what a spec change does', async () => {
        api.emit('ADDED', sshKeyAt('web-01', 4));
        await eventually(() => reconciled.includes('default/web-01'));
        reconciled.length = 0;

        api.emit('MODIFIED', sshKeyAt('web-01', 5));

        await eventually(() => reconciled.includes('default/web-01'));
    });

    it('reconciles a deletion, which bumps the generation like a spec change', async () => {
        // Losing this event would leave the finalizer in place and a paid
        // server running, so it is worth pinning down rather than assuming.
        api.emit('ADDED', sshKeyAt('web-01', 4));
        await eventually(() => reconciled.includes('default/web-01'));
        reconciled.length = 0;

        const deleting = sshKeyAt('web-01', 5);
        deleting.metadata = {
            ...deleting.metadata,
            deletionTimestamp: new Date().toISOString(),
        };
        api.emit('MODIFIED', deleting);

        await eventually(() => reconciled.includes('default/web-01'));
    });

    it('still reconciles again for a spec change that lands mid-reconcile', async () => {
        // The one event the queue's dirty/running path exists for. The filter
        // sits in front of that path, so it has to let this through: a
        // generation that moves while the key is already running must still
        // mark it dirty, and the queue must run it again the moment the
        // current pass returns rather than waiting for the resync.
        let release = () => {};
        holdReconcile = new Promise<void>((resolve) => {
            release = resolve;
        });

        api.emit('ADDED', sshKeyAt('web-01', 4));
        await eventually(() => reconciled.length === 1);

        // The user edits the spec while the first pass is still running.
        api.emit('MODIFIED', sshKeyAt('web-01', 5));
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(reconciled).toHaveLength(1);

        holdReconcile = undefined;
        release();

        await eventually(() => reconciled.length === 2);
        expect(reconciled).toEqual(['default/web-01', 'default/web-01']);
    });

    it('collapses a burst of events for one object into few reconciles', async () => {
        for (let index = 0; index < 20; index += 1) {
            api.emit('MODIFIED', sshKey('web-01'));
        }

        await eventually(() => reconciled.length > 0);
        await new Promise((resolve) => setTimeout(resolve, 150));

        // De-duplication is what stops twenty kubectl edits becoming twenty
        // round-trips to Hetzner.
        expect(reconciled.length).toBeLessThan(20);
    });
});

describe('resync', () => {
    it('re-reconciles everything on the timer, catching drift and missed events', async () => {
        api.seed(sshKey('web-01'));
        controller = build({ resyncPeriodMs: 60 });
        await controller.start();

        await eventually(
            () => reconciled.filter((key) => key === 'default/web-01').length >= 2,
            3_000,
        );
    });

    it('survives a failing list during resync instead of crashing', async () => {
        api.seed(sshKey('web-01'));
        controller = build({ resyncPeriodMs: 50 });
        await controller.start();
        await eventually(() => reconciled.length >= 1);

        // Transient API server trouble mid-life must not take the operator down.
        api.failListWith = 500;
        await new Promise((resolve) => setTimeout(resolve, 120));
        api.failListWith = undefined as never;

        reconciled.length = 0;
        await eventually(() => reconciled.length >= 1, 3_000);
    });
});

describe('when the API server goes away', () => {
    it('reconnects its watch and keeps reconciling', async () => {
        // A watch is a long-lived HTTP request the API server ends whenever it
        // likes — a rolling control-plane upgrade does it to everyone. An
        // operator that does not come back is an operator that silently stops
        // working until someone notices.
        controller = build();
        await controller.start();
        await eventually(() => api.openWatches > 0);

        api.dropWatches();
        await eventually(() => api.openWatches === 0);

        // The informer re-establishes on its own.
        await eventually(() => api.openWatches > 0, 10_000);

        reconciled.length = 0;
        api.emit('ADDED', sshKey('after-reconnect'));
        await eventually(() => reconciled.includes('default/after-reconnect'), 10_000);
    }, 20_000);

    it('keeps serving the resync while the watch is down', async () => {
        // The resync is the safety net: even with no watch at all, drift is
        // still noticed, just more slowly.
        api.seed(sshKey('web-01'));
        controller = build({ resyncPeriodMs: 60 });
        await controller.start();
        await eventually(() => api.openWatches > 0);

        api.dropWatches();
        reconciled.length = 0;

        await eventually(() => reconciled.includes('default/web-01'), 5_000);
    }, 10_000);
});

describe('shutdown', () => {
    it('logs no errors on a clean stop', async () => {
        // Stopping the informer aborts its watch, which surfaces as an error
        // event. One spurious ERROR line per kind on every rolling update is
        // enough to trip an error-rate alert and train people to ignore them.
        const lines: Array<{ level: LogLevel; message: string }> = [];
        const logger = createLogger(
            'debug',
            {},
            {
                write: (line, level) => lines.push({ level, message: JSON.parse(line).message }),
            },
        );

        controller = build({ logger });
        await controller.start();
        await eventually(() => api.openWatches > 0);

        await controller.stop();
        controller = undefined as never;
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(lines.filter((entry) => entry.level === 'error')).toEqual([]);
    });

    it('stops the watch and the resync timer', async () => {
        controller = build();
        await controller.start();
        await eventually(() => api.openWatches > 0);

        await controller.stop();
        const stopped = controller;
        controller = undefined as never;

        await eventually(() => api.openWatches === 0);
        expect(stopped.synced).toBe(false);
    });

    it('ignores events that arrive after it stopped', async () => {
        controller = build();
        await controller.start();
        await eventually(() => api.openWatches > 0);

        await controller.stop();
        reconciled.length = 0;
        api.emit('ADDED', sshKey('late'));

        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(reconciled).toEqual([]);
        controller = undefined as never;
    });
});

describe('metrics', () => {
    it('reports its queue depth', async () => {
        const metrics = createMetrics();
        controller = build({ metrics });
        await controller.start();

        expect(metrics.registry.render()).toContain(
            'hcloud_operator_queue_depth{kind="HetznerSSHKey"}',
        );
    });

    it('counts a successful reconcile', async () => {
        const metrics = createMetrics();
        api.seed(sshKey('web-01'));
        controller = build({ metrics });
        await controller.start();

        await eventually(
            () => metrics.reconcileTotal.get({ kind: 'HetznerSSHKey', outcome: 'success' }) >= 1,
        );
    });
});
