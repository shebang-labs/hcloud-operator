/**
 * Assembles a complete, in-memory operator for one kind.
 *
 * Every adapter test uses this: real adapter, real reconcile engine, real
 * Hetzner resource modules, real action tracker — with only the transport and
 * the Kubernetes API replaced. What is under test is therefore the same code
 * that runs in production, and the assertions are about observable behaviour
 * (what is in Hetzner, what is in `.status`) rather than about which methods
 * were called.
 */

import { ReconcileEngine } from '../../src/framework/reconcile-engine.js';
import {
    createReferenceResolver,
    type ReferenceResolver,
    type ReferenceTarget,
} from '../../src/framework/references.js';
import type { ResourceAdapter } from '../../src/framework/types.js';
import { createActionTracker } from '../../src/hcloud/actions.js';
import { assembleHetznerCloud, type HetznerCloud } from '../../src/hcloud/index.js';
import { RateLimiter } from '../../src/hcloud/rate-limiter.js';
import type { Labelled } from '../../src/hcloud/types.js';
import type { AnyManagedResource, CommonSpec, CommonStatus } from '../../src/kube/api.js';
import type { EventRecorder } from '../../src/kube/events.js';
import { nullLogger } from '../../src/observability/logger.js';
import { FakeHetznerApi, type FakeHetznerOptions } from './fake-hcloud.js';
import { FakeResourceStore } from './fake-store.js';

/**
 * A registered kind, with its types erased.
 *
 * Tests address specs and statuses through their own typed builders; the
 * harness only needs to move opaque objects between the store and the engine,
 * so carrying three type parameters through it would buy nothing.
 */
export interface KindHarness {
    readonly adapter: AnyAdapter;
    readonly store: FakeResourceStore<AnyManagedResource>;
    readonly engine: ReconcileEngine<CommonSpec, CommonStatus, Labelled>;
    /** Adds an object and reconciles it until it stops asking to be requeued. */
    settle(resource: AnyManagedResource, maxPasses?: number): Promise<AnyManagedResource>;
    /** One reconcile pass. */
    once(resource: AnyManagedResource): Promise<{ requeueAfterMs?: number }>;
}

type AnyAdapter = ResourceAdapter<CommonSpec, CommonStatus, Labelled>;

/** One event the engine emitted, flattened for assertions. */
export interface RecordedEvent {
    type: 'Normal' | 'Warning';
    reason: string;
    message: string;
    resource: string;
}

export interface Harness {
    readonly api: FakeHetznerApi;
    /** Every Kubernetes Event the engine recorded, in order. */
    readonly events: RecordedEvent[];
    readonly hcloud: HetznerCloud;
    readonly refs: ReferenceResolver;
    /** Registers a kind so the engine can reconcile it and references resolve. */
    register(adapter: AnyAdapter): KindHarness;
}

export function createHarness(options: FakeHetznerOptions = {}): Harness {
    const api = new FakeHetznerApi(options);
    const actions = createActionTracker({
        http: api,
        pollIntervalMs: 0,
        maxPollIntervalMs: 0,
        sleep: async () => undefined,
    });
    // Generous, so the limiter never becomes the reason a test is slow; the
    // limiter's own behaviour is covered in test/hcloud/rate-limiter.test.ts.
    const rateLimiter = new RateLimiter({ requestsPerHour: 3_600 });
    const hcloud = assembleHetznerCloud({ http: api, actions, rateLimiter });

    const targets = new Map<string, ReferenceTarget>();
    const refs = createReferenceResolver(targets);

    const events: RecordedEvent[] = [];
    const recorder: EventRecorder = {
        normal: (resource, reason, message) =>
            events.push({
                type: 'Normal',
                reason,
                message,
                resource: `${resource.metadata?.namespace}/${resource.metadata?.name}`,
            }),
        warning: (resource, reason, message) =>
            events.push({
                type: 'Warning',
                reason,
                message,
                resource: `${resource.metadata?.namespace}/${resource.metadata?.name}`,
            }),
    };

    return {
        api,
        hcloud,
        refs,
        events,

        register(adapter) {
            const store = new FakeResourceStore<AnyManagedResource>();

            const engine = new ReconcileEngine({
                adapter,
                store,
                refs,
                logger: nullLogger,
                events: recorder,
            });

            targets.set(adapter.descriptor.kind, {
                descriptor: adapter.descriptor,
                get: (namespace, name) => store.get(namespace, name),
                remote: adapter.api,
            });

            const namespaceOf = (resource: AnyManagedResource) =>
                resource.metadata?.namespace ?? 'default';
            const nameOf = (resource: AnyManagedResource) => resource.metadata?.name ?? '';

            return {
                adapter,
                store,
                engine,

                once(resource) {
                    store.add(resource);
                    return engine.reconcile(namespaceOf(resource), nameOf(resource));
                },

                async settle(resource, maxPasses = 12) {
                    store.add(resource);
                    const namespace = namespaceOf(resource);
                    const name = nameOf(resource);
                    for (let pass = 0; pass < maxPasses; pass += 1) {
                        const result = await engine.reconcile(namespace, name);
                        if (result.requeueAfterMs === undefined) {
                            break;
                        }
                        // The object may have been released and removed.
                        if (!(await store.get(namespace, name))) {
                            break;
                        }
                    }
                    return (await store.get(namespace, name)) ?? resource;
                },
            };
        },
    };
}
