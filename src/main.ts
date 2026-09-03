/**
 * Entry point: wire everything together and handle process lifecycle.
 *
 *   config -> logger + metrics -> health server -> Kubernetes clients
 *          -> Hetzner client -> kind registry -> leader election -> operator
 *
 * The health server starts *before* leader election, so a standby replica is
 * still live and scrapeable while it waits for the lease. On SIGTERM we stop the
 * watches, let running reconciles finish, and only then hand the lease back — in
 * that order, so a rolling update never has two replicas acting at once and
 * never abandons a half-finished Hetzner operation.
 */

import { createValidator, createWebhookServer, type WebhookServer } from './admission/index.js';
import { loadConfig, type OperatorConfig } from './config/index.js';
import { Operator } from './framework/operator.js';
import { createHetznerCloud } from './hcloud/index.js';
import { createKubernetesClients } from './kube/client.js';
import { createEventRecorder } from './kube/events.js';
import { createLeaderElector, type LeaderElector } from './kube/leader-election.js';
import { createSecretReader } from './kube/secrets.js';
import { createHealthServer } from './observability/health.js';
import { createLogger, type Logger } from './observability/logger.js';
import { createMetrics } from './observability/metrics.js';
import { buildKinds } from './resources/index.js';

async function main(): Promise<void> {
    const config = loadConfig();
    const logger = createLogger(config.logLevel, { component: 'hetzner-server-controller' });
    const metrics = createMetrics();

    logger.info('Operator starting', {
        nodeVersion: process.version,
        logLevel: config.logLevel,
        namespace: config.namespace ?? '(all namespaces)',
        leaderElection: config.leaderElectionEnabled,
    });

    const clients = createKubernetesClients(logger);
    const hcloud = createHetznerCloud({
        token: config.hetznerToken,
        baseUrl: config.hetznerApiUrl,
        timeoutMs: config.hetznerTimeoutMs,
        requestsPerHour: config.hetznerRequestsPerHour,
        actionTimeoutMs: config.actionTimeoutMs,
        metrics,
    });

    metrics.rateLimitRemaining.addSource({}, () => hcloud.rateLimiter.available);

    const kinds = buildKinds({ hcloud, secrets: createSecretReader(clients.core) });

    const operator = new Operator({
        kinds,
        clients,
        logger,
        metrics,
        // Events explain what the operator did; conditions explain what the
        // resource's state is. Users need both to diagnose a problem from
        // `kubectl describe` alone.
        events: createEventRecorder({ core: clients.core, logger }),
        ...(config.namespace ? { namespace: config.namespace } : {}),
        enabledKinds: config.enabledKinds,
        resyncPeriodMs: config.resyncPeriodMs,
        concurrency: config.concurrency,
        retryBaseDelayMs: config.retryBaseDelayMs,
        retryMaxDelayMs: config.retryMaxDelayMs,
    });

    const lifecycle = new Lifecycle({ config, logger, operator, clients });

    const health = createHealthServer({
        port: config.healthPort,
        checks: {
            // Liveness must stay green for a standby replica: a non-leader is
            // healthy, it just has nothing to do yet.
            live: () => !lifecycle.crashed,
            ready: () => operator.synced,
        },
        registry: metrics.registry,
        logger,
    });
    metrics.leaderStatus.addSource({}, () => (lifecycle.isLeader ? 1 : 0));

    await health.start();

    // The webhook shares the adapters' own validate() with the reconcile engine,
    // so the two can never disagree about what a valid spec is.
    let webhook: WebhookServer | undefined;
    if (config.webhookEnabled) {
        webhook = createWebhookServer({
            port: config.webhookPort,
            certFile: config.webhookCertFile,
            keyFile: config.webhookKeyFile,
            logger,
            validator: createValidator({
                adapters: new Map(kinds.map((kind) => [kind.descriptor.kind, kind.adapter])),
                catalog: hcloud.catalog,
                logger,
            }),
        });
        await webhook.start();
    }

    const shutdown = (signal: string): void => {
        lifecycle
            .shutdown(signal, async () => {
                // Stop accepting admission requests first: a webhook that
                // answers after its operator has stopped is worse than one that
                // is simply gone, because the API server has a failurePolicy.
                await webhook?.stop();
                await health.stop();
            })
            .then(() => process.exit(0))
            .catch((error) => {
                logger.error('Shutdown failed', { error });
                process.exit(1);
            });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // A programming error must not leave a silently broken operator running:
    // exit non-zero and let Kubernetes restart the Pod.
    process.on('unhandledRejection', (reason) => {
        logger.error('Unhandled promise rejection, exiting', { error: reason });
        process.exit(1);
    });
    process.on('uncaughtException', (error) => {
        logger.error('Uncaught exception, exiting', { error });
        process.exit(1);
    });

    await lifecycle.run();
}

/**
 * Owns the "am I allowed to reconcile?" question.
 *
 * Split out of `main` because leader election turns startup into a state
 * machine — contend, lead, possibly lose the lease — and that is much easier to
 * follow as a small object than as nested callbacks.
 */
class Lifecycle {
    private readonly config: OperatorConfig;
    private readonly logger: Logger;
    private readonly operator: Operator;
    private readonly elector?: LeaderElector;

    private started = false;
    private shuttingDown = false;
    /** Set when the operator hit a fault it cannot recover from. */
    crashed = false;

    constructor(dependencies: {
        config: OperatorConfig;
        logger: Logger;
        operator: Operator;
        clients: ReturnType<typeof createKubernetesClients>;
    }) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
        this.operator = dependencies.operator;

        if (this.config.leaderElectionEnabled) {
            this.elector = createLeaderElector({
                coordination: dependencies.clients.coordination,
                namespace: this.config.leaderElectionNamespace,
                leaseName: this.config.leaderElectionLeaseName,
                identity: this.config.leaderElectionIdentity,
                leaseDurationMs: this.config.leaderElectionLeaseDurationMs,
                logger: this.logger,
                onStartedLeading: () => this.startOperator(),
                onStoppedLeading: () => this.onLeadershipLost(),
            });
        }
    }

    get isLeader(): boolean {
        return this.elector ? this.elector.isLeader : this.started;
    }

    async run(): Promise<void> {
        if (!this.elector) {
            this.logger.warn(
                'Leader election is disabled. Run a single replica: two replicas without a lease ' +
                    'can both act on the same object.',
            );
            await this.startOperator();
            return;
        }
        await this.elector.run();
    }

    private async startOperator(): Promise<void> {
        if (this.started || this.shuttingDown) {
            return;
        }
        this.started = true;
        await this.operator.start();
    }

    /**
     * Losing the lease means another replica now owns these resources. Two
     * operators reconciling the same object would fight over Hetzner state, so
     * we exit and let Kubernetes restart us as a fresh standby.
     */
    private async onLeadershipLost(): Promise<void> {
        this.logger.error('Lost leadership, stopping so another replica can take over');
        this.crashed = true;
        await this.operator.stop().catch((error) => {
            this.logger.error('Failed to stop cleanly after losing leadership', { error });
        });
        process.exit(1);
    }

    async shutdown(signal: string, stopHealth: () => Promise<void>): Promise<void> {
        if (this.shuttingDown) {
            return;
        }
        this.shuttingDown = true;
        this.logger.info('Shutting down', { signal });

        // Stop reconciling *before* handing the lease back. Releasing it first
        // would let a standby start reconciling the same objects while our own
        // in-flight reconciles were still running against Hetzner — exactly the
        // dual-ownership that leader election exists to prevent.
        if (this.started) {
            await this.operator.stop();
        }
        // Now the lease can go, so a standby takes over in seconds instead of
        // waiting for it to expire.
        await this.elector?.release();
        await stopHealth();
        this.logger.info('Shutdown complete');
    }
}

main().catch((error) => {
    // The logger may not exist yet (bad config), so fall back to stderr.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
        `${JSON.stringify({
            time: new Date().toISOString(),
            level: 'error',
            message: 'Operator failed to start',
            error: message,
        })}\n`,
    );
    process.exit(1);
});
