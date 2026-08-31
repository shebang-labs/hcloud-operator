/**
 * Liveness and readiness are distinct on purpose. Conflating them is the classic
 * operator bug: a standby replica that reports itself unhealthy gets restarted
 * by the kubelet, forever, and never gets the chance to take the lease.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createHealthServer, type HealthServer } from '../../src/observability/health.js';
import { nullLogger } from '../../src/observability/logger.js';
import { createMetrics } from '../../src/observability/metrics.js';

let server: HealthServer | undefined;
let port = 0;

afterEach(async () => {
    await server?.stop();
    server = undefined;
});

async function start(checks: { live: () => boolean; ready: () => boolean }) {
    const metrics = createMetrics();
    metrics.reconcileTotal.inc({ kind: 'HetznerServer', outcome: 'success' });

    // Port 0 lets the OS pick a free one; read it back off the listening socket.
    port = 40_000 + Math.floor(Math.random() * 20_000);
    server = createHealthServer({
        port,
        address: '127.0.0.1',
        checks,
        registry: metrics.registry,
        logger: nullLogger,
    });
    await server.start();
}

const healthy = { live: () => true, ready: () => true };

describe('health server', () => {
    it('answers /healthz while the process is alive', async () => {
        await start(healthy);

        const response = await fetch(`http://127.0.0.1:${port}/healthz`);

        expect(response.status).toBe(200);
        expect(await response.text()).toBe('ok');
    });

    it('stays live but not ready for a standby replica', async () => {
        await start({ live: () => true, ready: () => false });

        expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
        expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(503);
    });

    it('fails /healthz once the operator declares itself wedged', async () => {
        await start({ live: () => false, ready: () => false });

        expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(500);
    });

    it('serves the metrics registry in the Prometheus content type', async () => {
        await start(healthy);

        const response = await fetch(`http://127.0.0.1:${port}/metrics`);

        expect(response.headers.get('content-type')).toContain('version=0.0.4');
        expect(await response.text()).toContain('hcloud_operator_reconcile_total');
    });

    it('404s anything else rather than guessing', async () => {
        await start(healthy);

        expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
        expect((await fetch(`http://127.0.0.1:${port}/admin`)).status).toBe(404);
    });

    it('ignores a query string on a known path', async () => {
        await start(healthy);

        expect((await fetch(`http://127.0.0.1:${port}/healthz?verbose=1`)).status).toBe(200);
    });

    it('stops listening on stop', async () => {
        await start(healthy);
        const stopped = server;
        server = undefined;
        await stopped?.stop();

        await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
    });
});
