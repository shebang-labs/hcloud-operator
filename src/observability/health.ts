/**
 * The operator's HTTP surface: liveness, readiness and metrics.
 *
 * Kubernetes needs two distinct signals, and conflating them is a classic
 * operator bug:
 *
 *   - /healthz (liveness)  — "is this process wedged?" It must stay green while
 *     the operator is merely a standby replica, otherwise the kubelet restarts
 *     every non-leader in a loop.
 *   - /readyz (readiness)  — "should this replica be considered started?" It
 *     turns green once the informers have synced.
 *
 * Deliberately built on node:http rather than a framework: three routes, no
 * request bodies, no need for a web server.
 */

import { createServer, type Server } from 'node:http';
import type { Logger } from './logger.js';
import type { MetricsRegistry } from './metrics.js';

export interface HealthChecks {
    /** False when the process is wedged and should be restarted. */
    live(): boolean;
    /** False until the operator has finished starting up. */
    ready(): boolean;
}

export interface HealthServerOptions {
    port: number;
    address?: string;
    checks: HealthChecks;
    registry: MetricsRegistry;
    logger: Logger;
}

export interface HealthServer {
    start(): Promise<void>;
    stop(): Promise<void>;
}

export function createHealthServer(options: HealthServerOptions): HealthServer {
    const { checks, registry, logger } = options;

    const server: Server = createServer((request, response) => {
        const path = (request.url ?? '/').split('?')[0];

        const respond = (status: number, body: string, contentType = 'text/plain'): void => {
            response.writeHead(status, {
                'Content-Type': contentType,
                'Content-Length': Buffer.byteLength(body),
                'Cache-Control': 'no-store',
            });
            response.end(body);
        };

        switch (path) {
            case '/healthz':
                return checks.live() ? respond(200, 'ok') : respond(500, 'unhealthy');
            case '/readyz':
                return checks.ready() ? respond(200, 'ok') : respond(503, 'not ready');
            case '/metrics':
                return respond(200, registry.render(), 'text/plain; version=0.0.4');
            default:
                return respond(404, 'not found');
        }
    });

    // A hung client must not be able to hold the process open on shutdown.
    server.keepAliveTimeout = 5_000;
    server.headersTimeout = 10_000;

    return {
        start() {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(options.port, options.address ?? '0.0.0.0', () => {
                    server.removeListener('error', reject);
                    logger.info('Health and metrics server listening', { port: options.port });
                    resolve();
                });
            });
        },
        stop() {
            return new Promise((resolve) => {
                server.close(() => resolve());
                // close() waits for keep-alive connections to drain; a scrape
                // in flight must not delay a SIGTERM.
                server.closeAllConnections?.();
            });
        },
    };
}
