/**
 * The admission webhook's HTTPS server.
 *
 * Kubernetes will only call a webhook over TLS, and it verifies the certificate
 * against the CA bundle in the `ValidatingWebhookConfiguration`. The operator
 * does not try to manage that itself: the certificate is mounted from a Secret
 * (cert-manager issues it, see the Helm chart), which keeps rotation out of
 * this process entirely.
 *
 * Everything except the TLS setup lives in `handler.ts`, where it can be tested
 * without conjuring a certificate.
 *
 * The webhook is optional. With `WEBHOOK_ENABLED=false` — the default — none of
 * this runs and the operator works exactly as before, reporting bad specs on
 * the `Synced` condition instead of rejecting them at apply time.
 */

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { Logger } from '../observability/logger.js';
import { createRequestHandler } from './handler.js';
import type { Validator } from './validator.js';

export interface WebhookServerOptions {
    port: number;
    address?: string;
    /** Path to the PEM certificate the API server will verify. */
    certFile: string;
    /** Path to its private key. Read once at startup and never logged. */
    keyFile: string;
    validator: Validator;
    logger: Logger;
}

export interface WebhookServer {
    start(): Promise<void>;
    stop(): Promise<void>;
}

export function createWebhookServer(options: WebhookServerOptions): WebhookServer {
    const { logger } = options;

    const server: Server = createServer(
        {
            cert: readFileSync(options.certFile),
            key: readFileSync(options.keyFile),
            minVersion: 'TLSv1.2',
        },
        createRequestHandler({ validator: options.validator, logger }),
    );

    server.keepAliveTimeout = 5_000;
    server.headersTimeout = 10_000;

    return {
        start() {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(options.port, options.address ?? '0.0.0.0', () => {
                    server.removeListener('error', reject);
                    logger.info('Admission webhook listening', { port: options.port });
                    resolve();
                });
            });
        },
        stop() {
            return new Promise((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections?.();
            });
        },
    };
}
