/**
 * The server lifecycle steps that have to wait on the guest.
 *
 * These drive the adapter with an injected clock, because the interesting
 * question — "how long has the shutdown been outstanding?" — is about time, and
 * sleeping through a two-minute grace period in a test is not an option.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createServerAdapter } from '../../src/resources/server/index.js';
import type { HetznerServerSpec, HetznerServerStatus } from '../../src/resources/server/spec.js';
import { buildResource } from '../support/fake-store.js';
import { createHarness, type Harness, type KindHarness } from '../support/harness.js';

const baseSpec: HetznerServerSpec = {
    serverType: 'cpx21',
    image: 'ubuntu-24.04',
    location: 'nbg1',
    gracefulShutdownTimeoutSeconds: 60,
};

function server(spec: Partial<HetznerServerSpec> = {}) {
    return buildResource<HetznerServerSpec, HetznerServerStatus>('HetznerServer', {
        ...baseSpec,
        ...spec,
    });
}

let harness: Harness;
let servers: KindHarness;
let now: Date;

function advance(ms: number): void {
    now = new Date(now.getTime() + ms);
}

beforeEach(() => {
    now = new Date('2026-01-01T12:00:00Z');
    harness = createHarness();
    servers = harness.register(createServerAdapter(harness.hcloud.servers, { now: () => now }));
});

/** The single Hetzner server in the fake project. */
function only(): Record<string, unknown> {
    const all = harness.api.all('servers');
    expect(all).toHaveLength(1);
    return all[0] as Record<string, unknown>;
}

describe('resizing a guest that ignores ACPI', () => {
    it('does not re-issue the shutdown while the grace period runs', async () => {
        const resource = server({ allowDowntime: true });
        await servers.settle(resource);
        const id = resource.status?.id;
        harness.api.reset();

        resource.spec.serverType = 'cpx31';
        await servers.once(resource);
        const requestedAt = resource.status?.shutdownRequestedAt;
        expect(requestedAt).toBe(now.toISOString());
        // The guest ignored the request.
        only().status = 'running';

        advance(30_000);
        const result = await servers.once(resource);

        // Re-sending the shutdown would restart the clock every pass, so a guest
        // that never honours ACPI would never be forced off.
        expect(harness.api.countRequests(`POST /servers/${id}/actions/shutdown`)).toBe(1);
        expect(harness.api.countRequests(`POST /servers/${id}/actions/poweroff`)).toBe(0);
        expect(resource.status?.shutdownRequestedAt).toBe(requestedAt);
        expect(resource.status?.pendingOperation).toBe('Resizing');
        expect(result.requeueAfterMs).toBeGreaterThan(0);
    });

    it('cuts the power once the grace period has passed, then resizes', async () => {
        const resource = server({ allowDowntime: true });
        await servers.settle(resource);
        const id = resource.status?.id;
        harness.api.reset();

        resource.spec.serverType = 'cpx31';
        await servers.once(resource);
        only().status = 'running';

        advance(61_000);
        await servers.once(resource);
        expect(harness.api.countRequests(`POST /servers/${id}/actions/shutdown`)).toBe(1);
        expect(harness.api.countRequests(`POST /servers/${id}/actions/poweroff`)).toBe(1);
        expect(only().status).toBe('off');

        // Now that it is off the resize proceeds as usual.
        await servers.once(resource);
        expect(harness.api.countRequests(`POST /servers/${id}/actions/change_type`)).toBe(1);
        expect(harness.api.countRequests(`POST /servers/${id}/actions/poweron`)).toBe(1);
        expect(only().server_type).toMatchObject({ name: 'cpx31' });
        expect(resource.status?.pendingOperation).toBeNull();
    });
});

describe('stopping a guest that ignores ACPI', () => {
    it('stamps the shutdown request with the injected clock', async () => {
        const resource = server();
        await servers.settle(resource);

        resource.spec.powerState = 'Stopped';
        await servers.once(resource);

        expect(resource.status?.shutdownRequestedAt).toBe(now.toISOString());
    });

    it('waits out the grace period before cutting the power', async () => {
        const resource = server();
        await servers.settle(resource);
        const id = resource.status?.id;
        harness.api.reset();

        resource.spec.powerState = 'Stopped';
        await servers.once(resource);
        only().status = 'running';

        advance(30_000);
        await servers.once(resource);
        only().status = 'running';
        expect(harness.api.countRequests(`POST /servers/${id}/actions/shutdown`)).toBe(1);
        expect(harness.api.countRequests(`POST /servers/${id}/actions/poweroff`)).toBe(0);

        advance(31_000);
        await servers.once(resource);
        expect(harness.api.countRequests(`POST /servers/${id}/actions/poweroff`)).toBe(1);
        expect(only().status).toBe('off');
        expect(resource.status?.shutdownRequestedAt).toBeNull();
    });
});
