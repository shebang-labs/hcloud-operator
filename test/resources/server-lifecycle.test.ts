/**
 * The server lifecycle steps that have to wait on the guest.
 *
 * These drive the adapter with an injected clock, because the interesting
 * question — "how long has the shutdown been outstanding?" — is about time, and
 * sleeping through a two-minute grace period in a test is not an option.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { CONDITION_SYNCED } from '../../src/kube/conditions.js';
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

describe('a server that fell back to a smaller type', () => {
    /** Places the server, then pretends Hetzner gave it the second entry. */
    async function fallenBack(spec: Record<string, unknown> = {}) {
        const resource = server({
            serverType: undefined,
            serverTypes: ['cpx31', 'cpx21'],
            ...spec,
        });
        await servers.settle(resource);
        only().server_type = { name: 'cpx21' };
        harness.api.reset();
        return resource;
    }

    it('is left alone, because any listed type is in sync', async () => {
        const resource = await fallenBack();

        await servers.settle(resource);

        // Resizing it back up would be downtime nobody asked for, on a node
        // that is working — and a disk that grows cannot be shrunk again.
        expect(
            harness.api.countRequests(`POST /servers/${resource.status?.id}/actions/change_type`),
        ).toBe(0);
        expect(resource.status?.serverType).toBe('cpx21');
    });

    it('stays Synced, so it does not sit red for the rest of its life', async () => {
        const resource = await fallenBack();

        await servers.settle(resource);

        expect(
            servers.store.condition('default', resource.metadata?.name ?? '', CONDITION_SYNCED)
                ?.status,
        ).toBe('True');
    });

    it('is not resized even when allowDowntime is already set', async () => {
        // allowDowntime is there for resizes the user asked for. It must not
        // become blanket permission to undo a fallback.
        const resource = await fallenBack({ allowDowntime: true });

        await servers.settle(resource);

        expect(
            harness.api.countRequests(`POST /servers/${resource.status?.id}/actions/change_type`),
        ).toBe(0);
    });

    it('is resized once its type leaves the list entirely', async () => {
        // That takes a deliberate edit, which is the signal that a resize was
        // actually intended.
        const resource = await fallenBack({ allowDowntime: true });
        resource.spec.serverTypes = ['cpx31'];

        await servers.settle(resource);

        expect(only().server_type).toMatchObject({ name: 'cpx31' });
    });

    it('explains itself rather than resizing when allowDowntime is unset', async () => {
        const resource = await fallenBack();
        resource.spec.serverTypes = ['cpx31'];

        await servers.settle(resource);

        // Both halves matter: which type is the problem, and which one a
        // resize would actually produce — the first entry, not a nearest fit.
        expect(resource.status?.message).toMatch(/no longer lists "cpx21"/);
        expect(resource.status?.message).toMatch(/resized to "cpx31", the first type/);
        expect(
            servers.store.condition('default', resource.metadata?.name ?? '', CONDITION_SYNCED)
                ?.status,
        ).toBe('False');
        expect(only().server_type).toMatchObject({ name: 'cpx21' });
    });
});

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
