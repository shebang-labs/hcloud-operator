/**
 * The operator: a registry of kinds plus the lifecycle that runs them.
 *
 * Adding a twelfth Hetzner resource is one folder under `src/resources/` and one
 * line in `src/resources/index.ts`. Nothing in this file changes, which is the
 * point of the whole framework.
 *
 * Leader election wraps the lifecycle rather than living inside it: a standby
 * replica has started its health server and can serve /healthz, but it has not
 * created a single informer or touched the Hetzner API.
 */

import type { Labelled } from '../hcloud/types.js';
import {
    type CommonSpec,
    type CommonStatus,
    createResourceStore,
    type EventRecorder,
    type KubernetesClients,
    type ManagedResource,
    type ResourceDescriptor,
} from '../kube/index.js';
import type { Logger } from '../observability/logger.js';
import type { OperatorMetrics } from '../observability/metrics.js';
import { ReconcileEngine } from './reconcile-engine.js';
import {
    createReferenceResolver,
    type ReferenceResolver,
    type ReferenceTarget,
} from './references.js';
import { ResourceController, type RunnableController } from './resource-controller.js';
import type { ResourceAdapter } from './types.js';

/** Everything a kind needs in order to build its controller. */
export interface KindEnvironment {
    clients: KubernetesClients;
    logger: Logger;
    metrics?: OperatorMetrics;
    events?: EventRecorder;
    refs: ReferenceResolver;
    namespace?: string;
    resyncPeriodMs: number;
    concurrency: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
    now?: () => Date;
}

/** Any adapter, with its concrete types erased. */
export type AnyResourceAdapter = ResourceAdapter<CommonSpec, CommonStatus, Labelled>;

/** A kind, ready to be instantiated. Produced by `defineKind`. */
export interface KindRegistration {
    readonly descriptor: ResourceDescriptor;
    /**
     * The adapter itself, so things that only need its pure parts — the
     * admission webhook needs `validate()` — can reach it without building a
     * whole controller.
     */
    readonly adapter: AnyResourceAdapter;
    build(environment: KindEnvironment): {
        controller: RunnableController;
        referenceTarget: ReferenceTarget;
    };
}

/**
 * Turns a typed adapter into a registration whose types are erased.
 *
 * This is the single place in the codebase where a kind's concrete types stop
 * being visible. Everything the engine and controller do is still fully typed —
 * they are constructed *inside* this generic function, where `TSpec`, `TStatus`
 * and `TRemote` are all known.
 */
export function defineKind<
    TSpec extends CommonSpec,
    TStatus extends CommonStatus,
    TRemote extends Labelled,
>(adapter: ResourceAdapter<TSpec, TStatus, TRemote>): KindRegistration {
    return {
        descriptor: adapter.descriptor,
        // The one cast in the file: `defineKind` is where a kind's concrete
        // types stop being visible to the rest of the operator.
        adapter: adapter as unknown as AnyResourceAdapter,

        build(environment) {
            const store = createResourceStore<ManagedResource<TSpec, TStatus>>(
                environment.clients.customObjects,
                adapter.descriptor,
            );

            const engine = new ReconcileEngine<TSpec, TStatus, TRemote>({
                adapter,
                store,
                refs: environment.refs,
                logger: environment.logger,
                ...(environment.events ? { events: environment.events } : {}),
                ...(environment.now ? { now: environment.now } : {}),
            });

            const controller = new ResourceController<TSpec, TStatus, TRemote>({
                descriptor: adapter.descriptor,
                clients: environment.clients,
                store,
                engine,
                logger: environment.logger,
                ...(environment.metrics ? { metrics: environment.metrics } : {}),
                ...(environment.namespace ? { namespace: environment.namespace } : {}),
                resyncPeriodMs: environment.resyncPeriodMs,
                concurrency: environment.concurrency,
                retryBaseDelayMs: environment.retryBaseDelayMs,
                retryMaxDelayMs: environment.retryMaxDelayMs,
            });

            return {
                controller,
                referenceTarget: {
                    descriptor: adapter.descriptor,
                    get: (namespace, name) => store.get(namespace, name),
                    remote: adapter.api,
                },
            };
        },
    };
}

export interface OperatorOptions {
    kinds: readonly KindRegistration[];
    clients: KubernetesClients;
    logger: Logger;
    metrics?: OperatorMetrics;
    events?: EventRecorder;
    namespace?: string;
    /** Only run these kinds. Empty means all of them. */
    enabledKinds?: readonly string[];
    resyncPeriodMs: number;
    concurrency: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
    now?: () => Date;
}

export class Operator {
    private readonly controllers: RunnableController[] = [];
    private readonly logger: Logger;
    private running = false;

    constructor(options: OperatorOptions) {
        this.logger = options.logger;

        const selected = selectKinds(options.kinds, options.enabledKinds);
        if (selected.length === 0) {
            throw new Error(
                `No kinds selected. ENABLED_KINDS=${(options.enabledKinds ?? []).join(',')} ` +
                    `matched none of: ${options.kinds.map((kind) => kind.descriptor.kind).join(', ')}`,
            );
        }

        // The resolver reads a map that the kinds themselves fill in below.
        // Building it first breaks the cycle: every kind needs a resolver that
        // can see every other kind, including ones registered after it.
        const targets = new Map<string, ReferenceTarget>();
        const refs = createReferenceResolver(targets);

        const environment: KindEnvironment = {
            clients: options.clients,
            logger: options.logger,
            ...(options.metrics ? { metrics: options.metrics } : {}),
            ...(options.events ? { events: options.events } : {}),
            refs,
            ...(options.namespace ? { namespace: options.namespace } : {}),
            resyncPeriodMs: options.resyncPeriodMs,
            concurrency: options.concurrency,
            retryBaseDelayMs: options.retryBaseDelayMs,
            retryMaxDelayMs: options.retryMaxDelayMs,
            ...(options.now ? { now: options.now } : {}),
        };

        for (const kind of selected) {
            const { controller, referenceTarget } = kind.build(environment);
            targets.set(kind.descriptor.kind, referenceTarget);
            this.controllers.push(controller);
        }
    }

    /** Names of the kinds this operator is running. */
    get kinds(): string[] {
        return this.controllers.map((controller) => controller.kind);
    }

    /** True once every controller has listed and started watching. */
    get synced(): boolean {
        return this.running && this.controllers.every((controller) => controller.synced);
    }

    async start(): Promise<void> {
        this.logger.info('Starting controllers', { kinds: this.kinds });
        // Sequential on purpose: the first failure (usually a missing CRD or bad
        // RBAC) should surface with the kind that caused it, not buried among
        // ten parallel stack traces.
        for (const controller of this.controllers) {
            await controller.start();
        }
        this.running = true;
        this.logger.info('All controllers running', { count: this.controllers.length });
    }

    async stop(): Promise<void> {
        this.running = false;
        // Stopping in parallel is safe and much faster: each controller only
        // waits for its own in-flight reconciles.
        const results = await Promise.allSettled(
            this.controllers.map((controller) => controller.stop()),
        );
        for (const result of results) {
            if (result.status === 'rejected') {
                this.logger.warn('A controller did not stop cleanly', { error: result.reason });
            }
        }
        this.logger.info('All controllers stopped');
    }
}

/** Filters the registry by `ENABLED_KINDS`, case-insensitively. */
export function selectKinds(
    kinds: readonly KindRegistration[],
    enabled: readonly string[] | undefined,
): KindRegistration[] {
    if (!enabled?.length) {
        return [...kinds];
    }
    const wanted = new Set(enabled.map((entry) => entry.toLowerCase()));
    return kinds.filter(
        (kind) =>
            wanted.has(kind.descriptor.kind.toLowerCase()) ||
            wanted.has(kind.descriptor.plural.toLowerCase()) ||
            wanted.has(kind.descriptor.shortName.toLowerCase()),
    );
}
