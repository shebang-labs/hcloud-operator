/**
 * One controller per kind: it watches objects of that kind and feeds their keys
 * into a work queue, where the reconcile engine picks them up.
 *
 * Three independent sources put work into the queue:
 *
 *   1. the watch (informer)  — reacts within milliseconds to kubectl apply/delete;
 *   2. the periodic resync   — lists every object every few minutes, so nothing
 *      is lost if a watch event was missed, and drift in Hetzner is noticed;
 *   3. the startup list      — after a Pod restart the operator reconciles all
 *      existing objects instead of assuming an empty world.
 *
 * A watch is a long-running HTTP request the API server can end at any time.
 * `makeInformer` handles reconnecting and keeps a local cache; on a hard error
 * we restart it ourselves after a short delay.
 */

import { type Informer, type KubernetesListObject, makeInformer } from '@kubernetes/client-node';
import type { Labelled } from '../hcloud/types.js';
import type { KubernetesClients } from '../kube/client.js';
import {
    type CommonSpec,
    type CommonStatus,
    GROUP,
    type ManagedResource,
    parseResourceKey,
    type ResourceDescriptor,
    type ResourceStore,
    resourceKey,
    VERSION,
    watchPath,
} from '../kube/index.js';
import type { Logger } from '../observability/logger.js';
import type { OperatorMetrics } from '../observability/metrics.js';
import type { ReconcileEngine } from './reconcile-engine.js';
import { WorkQueue } from './workqueue.js';

const INFORMER_RESTART_DELAY_MS = 5_000;

export interface ResourceControllerOptions<
    TSpec extends CommonSpec,
    TStatus extends CommonStatus,
    TRemote extends Labelled,
> {
    descriptor: ResourceDescriptor;
    clients: KubernetesClients;
    store: ResourceStore<ManagedResource<TSpec, TStatus>>;
    engine: ReconcileEngine<TSpec, TStatus, TRemote>;
    logger: Logger;
    metrics?: OperatorMetrics;
    namespace?: string;
    resyncPeriodMs: number;
    concurrency: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
}

/** The lifecycle the operator drives, with the kind's types erased. */
export interface RunnableController {
    readonly kind: string;
    readonly queueDepth: number;
    /** True once the initial list has been reconciled and the watch is up. */
    readonly synced: boolean;
    start(): Promise<void>;
    stop(): Promise<void>;
}

export class ResourceController<
    TSpec extends CommonSpec,
    TStatus extends CommonStatus,
    TRemote extends Labelled,
> implements RunnableController
{
    private readonly options: ResourceControllerOptions<TSpec, TStatus, TRemote>;
    private readonly logger: Logger;
    private readonly queue: WorkQueue;

    private informer?: Informer<ManagedResource<TSpec, TStatus>>;
    private resyncTimer?: NodeJS.Timeout;
    private restartTimer?: NodeJS.Timeout;
    private stopped = false;
    private started = false;

    constructor(options: ResourceControllerOptions<TSpec, TStatus, TRemote>) {
        this.options = options;
        this.logger = options.logger.child({ kind: options.descriptor.kind });

        this.queue = new WorkQueue({
            name: options.descriptor.kind,
            logger: this.logger,
            concurrency: options.concurrency,
            baseDelayMs: options.retryBaseDelayMs,
            maxDelayMs: options.retryMaxDelayMs,
            handler: (key) => this.handle(key),
        });

        options.metrics?.queueDepth.addSource(
            { kind: options.descriptor.kind },
            () => this.queue.depth,
        );
    }

    get kind(): string {
        return this.options.descriptor.kind;
    }

    get queueDepth(): number {
        return this.queue.depth;
    }

    get synced(): boolean {
        return this.started;
    }

    async start(): Promise<void> {
        // A list before the informer, purely to fail fast. If the CRD is
        // missing or RBAC is wrong, this throws with the real reason; the
        // informer would only log an error and retry forever, leaving a Pod
        // that looks healthy and silently reconciles nothing.
        //
        // It deliberately does not enqueue: the informer's own initial list
        // emits an `add` for every existing object, which is what makes a Pod
        // restart safe. Enqueuing here as well would reconcile everything twice
        // on every start.
        await this.verifyAccess();
        await this.startInformer();

        this.resyncTimer = setInterval(() => {
            void this.enqueueAll('resync');
        }, this.options.resyncPeriodMs);
        this.resyncTimer.unref?.();

        this.started = true;
        this.logger.info('Watching resources', {
            group: GROUP,
            version: VERSION,
            plural: this.options.descriptor.plural,
            namespace: this.options.namespace ?? '(all namespaces)',
            resyncPeriodMs: this.options.resyncPeriodMs,
            concurrency: this.options.concurrency,
        });
    }

    async stop(): Promise<void> {
        this.stopped = true;
        this.started = false;

        if (this.resyncTimer) {
            clearInterval(this.resyncTimer);
        }
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
        }
        if (this.informer) {
            await this.informer.stop().catch((error) => {
                this.logger.warn('Failed to stop the informer cleanly', { error });
            });
        }

        await this.queue.stop();
        this.logger.info('Controller stopped');
    }

    /** One unit of work: reconcile a key, recording metrics and failures. */
    private async handle(key: string): Promise<{ requeueAfterMs?: number }> {
        const { namespace, name } = parseResourceKey(key);
        const { metrics } = this.options;
        const labels = { kind: this.kind };

        const startedAt = process.hrtime.bigint();
        try {
            const result = await this.options.engine.reconcile(namespace, name);
            metrics?.reconcileTotal.inc({ ...labels, outcome: 'success' });
            return result;
        } catch (error) {
            metrics?.reconcileTotal.inc({ ...labels, outcome: 'failure' });
            // Write the failure into the object's status, then rethrow so the
            // queue applies its exponential backoff.
            await this.options.engine.recordFailure(namespace, name, error);
            throw error;
        } finally {
            metrics?.reconcileDuration.observe(
                Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
                labels,
            );
        }
    }

    /**
     * Confirms the operator can actually see this kind, and fails loudly if not.
     *
     * Throwing here is the point: a missing CRD or a wrong RBAC rule should
     * crash-loop the Pod with the reason in its logs, not degrade into an
     * operator that runs cleanly and manages nothing.
     */
    private async verifyAccess(): Promise<void> {
        try {
            const resources = await this.options.store.list(this.options.namespace);
            this.logger.info('Found existing resources', { count: resources.length });
        } catch (error) {
            this.logger.error('Cannot list resources; is the CRD installed and RBAC correct?', {
                error,
            });
            throw error;
        }
    }

    /**
     * Lists every object and queues it. Runs on the resync timer, so drift in
     * Hetzner is noticed and nothing is lost if a watch event was missed.
     */
    private async enqueueAll(trigger: 'resync'): Promise<void> {
        try {
            const resources = await this.options.store.list(this.options.namespace);
            for (const resource of resources) {
                this.queue.add(resourceKey(resource));
            }
            this.logger.debug('Queued resources for resync', { trigger, count: resources.length });
        } catch (error) {
            // A transient API server problem mid-life must not take the
            // operator down; the next resync tries again.
            this.logger.error('Failed to list resources', { trigger, error });
        }
    }

    private async startInformer(): Promise<void> {
        const { clients, descriptor, namespace } = this.options;

        const listFn = async (): Promise<KubernetesListObject<ManagedResource<TSpec, TStatus>>> => {
            const response = namespace
                ? await clients.customObjects.listNamespacedCustomObject({
                      group: descriptor.group ?? GROUP,
                      version: descriptor.version ?? VERSION,
                      plural: descriptor.plural,
                      namespace,
                  })
                : await clients.customObjects.listCustomObjectForAllNamespaces({
                      group: descriptor.group ?? GROUP,
                      version: descriptor.version ?? VERSION,
                      resourcePlural: descriptor.plural,
                  });
            return response as KubernetesListObject<ManagedResource<TSpec, TStatus>>;
        };

        const informer = makeInformer<ManagedResource<TSpec, TStatus>>(
            clients.kubeConfig,
            watchPath(descriptor, namespace),
            listFn,
        );

        const enqueue = (event: string) => (resource: ManagedResource<TSpec, TStatus>) => {
            const key = resourceKey(resource);
            this.logger.debug('Received watch event', { event, resource: key });
            this.queue.add(key);
        };

        informer.on('add', enqueue('add'));
        informer.on('update', enqueue('update'));
        informer.on('delete', (resource: ManagedResource<TSpec, TStatus>) => {
            // The object is gone for good, so drop its retry-backoff counter.
            // Without this the queue keeps one entry per object that ever failed
            // and never recovered — a small leak, but one keyed by user input
            // and therefore unbounded over the lifetime of the process.
            this.queue.forget(resourceKey(resource));
        });

        informer.on('error', (error) => {
            if (this.stopped) {
                // Stopping the informer aborts its in-flight watch request, and
                // the abort surfaces here as an error. Logging it at error level
                // would put one spurious ERROR line per kind into the logs of
                // every clean shutdown — enough to trip an error-rate alert on
                // every rolling update.
                this.logger.debug('Watch ended during shutdown', { error });
                return;
            }
            this.logger.error('Watch failed, restarting it shortly', {
                error,
                retryInMs: INFORMER_RESTART_DELAY_MS,
            });
            this.scheduleInformerRestart(informer);
        });

        this.informer = informer;
        await informer.start();
    }

    private scheduleInformerRestart(informer: Informer<ManagedResource<TSpec, TStatus>>): void {
        if (this.stopped || this.restartTimer) {
            return;
        }
        this.restartTimer = setTimeout(() => {
            this.restartTimer = undefined;
            if (this.stopped) {
                return;
            }
            informer.start().catch((error) => {
                this.logger.error('Restarting the watch failed', { error });
                this.scheduleInformerRestart(informer);
            });
        }, INFORMER_RESTART_DELAY_MS);
        this.restartTimer.unref?.();
    }
}
