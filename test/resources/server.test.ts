/**
 * The HetznerServer adapter: every imperative Hetzner operation expressed as
 * desired state.
 *
 * The two things worth proving over and over are that a destructive change does
 * not happen without its guard flag, and that a multi-step operation is safe to
 * interrupt — each pass reads reality and takes at most one step, so killing
 * the operator half-way through a resize cannot leave a server in limbo.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Server } from '../../src/hcloud/types.js';
import { CONDITION_READY, CONDITION_SYNCED } from '../../src/kube/conditions.js';
import type { SecretReader } from '../../src/kube/secrets.js';
import { createNetworkAdapter } from '../../src/resources/network.js';
import { createPlacementGroupAdapter } from '../../src/resources/placement-group.js';
import { createServerAdapter, describeServerState } from '../../src/resources/server/index.js';
import { imageMatches } from '../../src/resources/server/lifecycle.js';
import type { HetznerServerSpec, HetznerServerStatus } from '../../src/resources/server/spec.js';
import { createSshKeyAdapter } from '../../src/resources/ssh-key.js';
import { buildResource } from '../support/fake-store.js';
import { createHarness, type Harness, type KindHarness } from '../support/harness.js';

const baseSpec: HetznerServerSpec = {
    serverType: 'cpx21',
    image: 'ubuntu-24.04',
    location: 'nbg1',
};

function server(spec: Partial<HetznerServerSpec> = {}, options = {}) {
    return buildResource<HetznerServerSpec, HetznerServerStatus>(
        'HetznerServer',
        { ...baseSpec, ...spec },
        options,
    );
}

/** A Secret reader backed by a plain map, as in certificate.test.ts. */
function secretReader(data: Record<string, string> = {}): SecretReader {
    return { read: async (_namespace, ref) => data[ref.key] ?? null };
}

let harness: Harness;
let servers: KindHarness;

beforeEach(() => {
    harness = createHarness();
    servers = harness.register(createServerAdapter(harness.hcloud.servers));
});

/** The single Hetzner server in the fake project. */
function only(): Record<string, unknown> {
    const all = harness.api.all('servers');
    expect(all).toHaveLength(1);
    return all[0] as Record<string, unknown>;
}

describe('validation', () => {
    it.each([
        [{ serverType: '' }, /one of spec.serverTypes or spec.serverType is required/],
        [{ serverType: undefined, serverTypes: [] }, /is required/],
        [{ serverType: 'cx22', serverTypes: ['cx42'] }, /mutually exclusive/],
        [{ image: '' }, /spec.image is required/],
        [{ location: undefined }, /one of spec.location or spec.datacenter/],
        [{ location: 'nbg1', datacenter: 'nbg1-dc3' }, /mutually exclusive/],
        [{ powerState: 'Paused' as never }, /must be "Running" or "Stopped"/],
        [{ gracefulShutdownTimeoutSeconds: -1 }, /must not be negative/],
        [{ userData: '#cloud-config', userDataSecretRef: { name: 'boot' } }, /mutually exclusive/],
    ])('rejects %o', async (spec, expected) => {
        const resource = server(spec);

        await servers.once(resource);

        expect(resource.status?.message).toMatch(expected);
        expect(harness.api.all('servers')).toHaveLength(0);
    });

    it('accepts serverTypes in place of serverType', async () => {
        await servers.settle(server({ serverType: undefined, serverTypes: ['cx42'] }));

        expect(harness.api.lastBody('POST /servers')).toMatchObject({ server_type: 'cx42' });
    });

    it('creates the first entry when Hetzner has capacity for it', async () => {
        // The rest of the list is a fallback, not a menu: nothing may reorder it.
        await servers.settle(server({ serverType: undefined, serverTypes: ['cx42', 'cx22'] }));

        expect(harness.api.lastBody('POST /servers')).toMatchObject({ server_type: 'cx42' });
    });

    it('refuses a server that would have no address at all', async () => {
        const resource = server({ publicNet: { enableIPv4: false, enableIPv6: false } });

        await servers.once(resource);

        expect(resource.status?.message).toMatch(/no address at all/);
    });

    it('accepts no public IPs when a private network is declared', async () => {
        await servers.settle(
            server({
                publicNet: { enableIPv4: false, enableIPv6: false },
                networks: [{ networkRef: { id: 10 } }],
            }),
        );

        expect(harness.api.all('servers')).toHaveLength(1);
    });
});

describe('creation', () => {
    it('creates the server in the state the spec asks for', async () => {
        await servers.settle(server({ powerState: 'Stopped' }));

        expect(harness.api.lastBody('POST /servers')).toMatchObject({
            server_type: 'cpx21',
            image: 'ubuntu-24.04',
            location: 'nbg1',
            start_after_create: false,
        });
        expect(only().status).toBe('off');
    });

    it('resolves SSH keys, networks and the placement group by name', async () => {
        const keys = harness.register(createSshKeyAdapter(harness.hcloud.sshKeys));
        const networks = harness.register(createNetworkAdapter(harness.hcloud.networks));
        const groups = harness.register(
            createPlacementGroupAdapter(harness.hcloud.placementGroups),
        );

        await keys.settle(
            buildResource(
                'HetznerSSHKey',
                { publicKey: 'ssh-ed25519 AAAA admin@example.com' },
                { name: 'ops' },
            ),
        );
        await networks.settle(
            buildResource('HetznerNetwork', { ipRange: '10.0.0.0/16' }, { name: 'prod' }),
        );
        await groups.settle(buildResource('HetznerPlacementGroup', {}, { name: 'web' }));

        await servers.settle(
            server({
                sshKeyRefs: [{ name: 'ops' }],
                networks: [{ networkRef: { name: 'prod' } }],
                placementGroupRef: { name: 'web' },
            }),
        );

        const body = harness.api.lastBody('POST /servers') as Record<string, unknown>;
        expect(body.ssh_keys).toHaveLength(1);
        expect(body.networks).toHaveLength(1);
        expect(body.placement_group).toEqual(expect.any(Number));
    });

    it('passes inline user data straight through', async () => {
        await servers.settle(server({ userData: '#cloud-config\nruncmd: [echo hi]' }));

        expect(harness.api.lastBody('POST /servers')).toMatchObject({
            user_data: '#cloud-config\nruncmd: [echo hi]',
        });
    });

    it('reads user data from the Secret it points at', async () => {
        const secrets = secretReader({ 'user-data': '#cloud-config\nruncmd: [join-k3s]' });
        servers = harness.register(createServerAdapter(harness.hcloud.servers, { secrets }));

        await servers.settle(server({ userDataSecretRef: { name: 'k3s-agent-cloud-init' } }));

        expect(harness.api.lastBody('POST /servers')).toMatchObject({
            user_data: '#cloud-config\nruncmd: [join-k3s]',
        });
    });

    it('honours a custom key in that Secret', async () => {
        const secrets = secretReader({ 'agent.yaml': '#cloud-config' });
        servers = harness.register(createServerAdapter(harness.hcloud.servers, { secrets }));

        await servers.settle(server({ userDataSecretRef: { name: 'boot', key: 'agent.yaml' } }));

        expect(harness.api.lastBody('POST /servers')).toMatchObject({ user_data: '#cloud-config' });
    });

    it('refuses to create a server whose user data Secret is missing the key', async () => {
        const secrets = secretReader();
        servers = harness.register(createServerAdapter(harness.hcloud.servers, { secrets }));
        const resource = server({ userDataSecretRef: { name: 'boot' } });

        // Throwing rather than booting an unconfigured server: user data cannot
        // be applied after create, and the reconcile retries once the Secret
        // lands.
        await expect(servers.once(resource)).rejects.toThrow(/has no key "user-data"/);
        expect(harness.api.all('servers')).toHaveLength(0);
    });

    it('refuses to create one when the controller cannot read Secrets at all', async () => {
        const resource = server({ userDataSecretRef: { name: 'boot' } });

        await expect(servers.once(resource)).rejects.toThrow(/cannot read Secrets/);
        expect(harness.api.all('servers')).toHaveLength(0);
    });

    it('reports the addresses and the Hetzner status', async () => {
        const resource = server();
        await servers.settle(resource);

        expect(resource.status).toMatchObject({
            serverStatus: 'running',
            serverType: 'cpx21',
            image: 'ubuntu-24.04',
            location: 'nbg1',
            phase: 'Ready',
        });
        expect(resource.status?.ipv4).toMatch(/^203\.0\.113\./);
    });
});

describe('power state', () => {
    it('powers a stopped server on', async () => {
        const resource = server({ powerState: 'Stopped' });
        await servers.settle(resource);

        resource.spec.powerState = 'Running';
        await servers.settle(resource);

        expect(only().status).toBe('running');
    });

    it('asks the guest to shut down before cutting the power', async () => {
        const resource = server();
        await servers.settle(resource);
        harness.api.reset();

        resource.spec.powerState = 'Stopped';
        await servers.settle(resource);

        const id = resource.status?.id;
        expect(harness.api.countRequests(`POST /servers/${id}/actions/shutdown`)).toBe(1);
        expect(harness.api.countRequests(`POST /servers/${id}/actions/poweroff`)).toBe(0);
    });

    it('records when the shutdown was requested', async () => {
        const resource = server();
        await servers.settle(resource);

        // Make the guest ignore the ACPI request.
        const stored = only();
        resource.spec.powerState = 'Stopped';
        await servers.once(resource);
        stored.status = 'running';

        expect(resource.status?.shutdownRequestedAt).toBeTruthy();
    });

    it('cuts the power once the grace period has passed', async () => {
        const resource = server({ powerState: 'Stopped', gracefulShutdownTimeoutSeconds: 60 });
        await servers.settle(server());
        // Re-point at the created server, then pretend the guest is ignoring us.
        const created = only();
        resource.status = {
            id: created.id as number,
            // The shutdown was asked for two minutes ago.
            shutdownRequestedAt: new Date(Date.now() - 120_000).toISOString(),
        };
        created.labels = { ...(created.labels as object) };
        created.status = 'running';
        harness.api.reset();

        await servers.once(resource);

        expect(harness.api.countRequests(`POST /servers/${created.id}/actions/poweroff`)).toBe(1);
    });

    it('waits rather than acting while a transition is in flight', async () => {
        const resource = server();
        await servers.settle(resource);
        only().status = 'starting';
        harness.api.reset();

        const result = await servers.once(resource);

        expect(result.requeueAfterMs).toBeGreaterThan(0);
        expect(harness.api.countRequests('POST /servers/')).toBe(0);
    });
});

describe('resizing', () => {
    it('refuses without allowDowntime and explains why', async () => {
        const resource = server();
        await servers.settle(resource);
        harness.api.reset();

        resource.spec.serverType = 'cpx31';
        await servers.once(resource);

        expect(harness.api.countRequests('POST /servers/')).toBe(0);
        expect(servers.store.condition('default', 'example', CONDITION_SYNCED)).toMatchObject({
            status: 'False',
            reason: 'GuardRequired',
        });
        expect(resource.status?.message).toMatch(/allowDowntime/);
    });

    it('powers off, resizes and powers back on across passes', async () => {
        const resource = server({ allowDowntime: true });
        await servers.settle(resource);
        const id = resource.status?.id;
        harness.api.reset();

        resource.spec.serverType = 'cpx31';
        // Pass one: request the shutdown, remember why.
        await servers.once(resource);
        expect(harness.api.countRequests(`POST /servers/${id}/actions/shutdown`)).toBe(1);
        expect(resource.status?.pendingOperation).toBe('Resizing');

        // Pass two: the server is off, so change the type and start it again.
        await servers.once(resource);
        expect(harness.api.countRequests(`POST /servers/${id}/actions/change_type`)).toBe(1);
        expect(harness.api.countRequests(`POST /servers/${id}/actions/poweron`)).toBe(1);
        expect(only().server_type).toMatchObject({ name: 'cpx31' });
    });

    it('leaves the server off when the spec asked for it to be off', async () => {
        const resource = server({ allowDowntime: true, powerState: 'Stopped' });
        await servers.settle(resource);
        const id = resource.status?.id;
        harness.api.reset();

        resource.spec.serverType = 'cpx31';
        await servers.settle(resource);

        expect(harness.api.countRequests(`POST /servers/${id}/actions/poweron`)).toBe(0);
    });

    it('passes upgradeDisk through, since it makes the resize one-way', async () => {
        const resource = server({ allowDowntime: true, upgradeDisk: true, powerState: 'Stopped' });
        await servers.settle(resource);
        const id = resource.status?.id;

        resource.spec.serverType = 'cpx31';
        await servers.settle(resource);

        expect(harness.api.lastBody(`POST /servers/${id}/actions/change_type`)).toMatchObject({
            upgrade_disk: true,
        });
    });

    it('leaves the cheap steps for the next pass when a disruptive step acted', async () => {
        // Hetzner locks the server for the duration of the shutdown; enabling
        // backups in the same pass would only fail with `locked`.
        const resource = server({ allowDowntime: true });
        await servers.settle(resource);
        const id = resource.status?.id;
        harness.api.reset();

        resource.spec.serverType = 'cpx31';
        resource.spec.backups = true;
        await servers.once(resource);

        expect(harness.api.countRequests(`POST /servers/${id}/actions/shutdown`)).toBe(1);
        expect(harness.api.countRequests(`POST /servers/${id}/actions/enable_backup`)).toBe(0);

        // Nothing is lost: the following passes pick the cheap step up.
        await servers.settle(resource);
        expect(only().backup_window).toBeTruthy();
    });

    it('clears pendingOperation once the type matches again', async () => {
        const resource = server({ allowDowntime: true, powerState: 'Stopped' });
        await servers.settle(resource);
        resource.spec.serverType = 'cpx31';
        await servers.settle(resource);

        expect(resource.status?.pendingOperation).toBeNull();
    });
});

describe('rebuilding', () => {
    it('refuses without allowDataLoss and says the disk would be erased', async () => {
        const resource = server();
        await servers.settle(resource);
        harness.api.reset();

        resource.spec.image = 'debian-12';
        await servers.once(resource);

        expect(harness.api.countRequests('POST /servers/')).toBe(0);
        expect(resource.status?.message).toMatch(/erases the disk/);
    });

    it('treats a snapshot-built server as drift from a named image', async () => {
        // A snapshot has no name, so it cannot be "ubuntu-24.04"; treating that
        // as a match would make a rebuild request vanish without a trace.
        const resource = server();
        await servers.settle(resource);
        only().image = { id: 4711, name: null };
        harness.api.reset();

        await servers.once(resource);

        expect(harness.api.countRequests('POST /servers/')).toBe(0);
        expect(resource.status?.message).toMatch(/built from "#4711"/);
        expect(resource.status?.message).toMatch(/allowDataLoss/);
    });

    it('rebuilds when the guard is set', async () => {
        const resource = server({ allowDataLoss: true });
        await servers.settle(resource);
        const id = resource.status?.id;
        harness.api.reset();

        resource.spec.image = 'debian-12';
        await servers.settle(resource);

        expect(harness.api.lastBody(`POST /servers/${id}/actions/rebuild`)).toEqual({
            image: 'debian-12',
        });
    });

    it('does not rebuild in the same pass as a resize', async () => {
        // Both changed at once. Only the resize should start, so Hetzner is never
        // asked to run two actions against a locked server.
        const resource = server({ allowDowntime: true, allowDataLoss: true });
        await servers.settle(resource);
        const id = resource.status?.id;
        harness.api.reset();

        resource.spec.serverType = 'cpx31';
        resource.spec.image = 'debian-12';
        await servers.once(resource);

        expect(harness.api.countRequests(`POST /servers/${id}/actions/rebuild`)).toBe(0);
    });
});

describe('backups, rescue and ISO', () => {
    it('enables and disables daily backups', async () => {
        const resource = server({ backups: true });
        await servers.settle(resource);
        expect(only().backup_window).toBeTruthy();

        resource.spec.backups = false;
        await servers.settle(resource);
        expect(only().backup_window).toBeNull();
    });

    it('leaves backups alone when the field is absent', async () => {
        const resource = server({ backups: true });
        await servers.settle(resource);
        harness.api.reset();

        resource.spec.backups = undefined;
        await servers.settle(resource);

        expect(harness.api.countRequests('POST /servers/')).toBe(0);
        expect(only().backup_window).toBeTruthy();
    });

    it('enables rescue mode with the requested SSH keys', async () => {
        const keys = harness.register(createSshKeyAdapter(harness.hcloud.sshKeys));
        await keys.settle(
            buildResource(
                'HetznerSSHKey',
                { publicKey: 'ssh-ed25519 AAAA admin@example.com' },
                { name: 'ops' },
            ),
        );

        const resource = server({
            rescue: { enabled: true, type: 'linux64', sshKeyRefs: [{ name: 'ops' }] },
        });
        await servers.settle(resource);

        const body = harness.api.lastBody(
            `POST /servers/${resource.status?.id}/actions/enable_rescue`,
        ) as Record<string, unknown>;
        expect(body.type).toBe('linux64');
        expect(body.ssh_keys).toHaveLength(1);
        expect(only().rescue_enabled).toBe(true);
    });

    it('attaches and detaches an ISO', async () => {
        const resource = server({ iso: 'debian-12-netinst' });
        await servers.settle(resource);
        expect(only().iso).toMatchObject({ name: 'debian-12-netinst' });

        resource.spec.iso = null;
        await servers.settle(resource);
        expect(only().iso).toBeNull();
    });
});

describe('networks and placement groups', () => {
    it('attaches, updates alias IPs and detaches', async () => {
        const resource = server({ networks: [{ networkRef: { id: 10 }, ip: '10.0.1.5' }] });
        await servers.settle(resource);
        expect(only().private_net).toHaveLength(1);

        resource.spec.networks = [
            { networkRef: { id: 10 }, ip: '10.0.1.5', aliasIps: ['10.0.1.200'] },
        ];
        await servers.settle(resource);
        expect((only().private_net as Array<{ alias_ips: string[] }>)[0]?.alias_ips).toEqual([
            '10.0.1.200',
        ]);

        resource.spec.networks = [];
        await servers.settle(resource);
        expect(only().private_net).toHaveLength(0);
    });

    it('attaches networks that want a fixed IP after create, so the IP is honoured', async () => {
        // POST /servers only takes network ids, so a requested IP can only be
        // applied by attach_to_network once the server exists.
        const resource = server({
            networks: [{ networkRef: { id: 10 }, ip: '10.0.1.11' }, { networkRef: { id: 20 } }],
        });
        await servers.settle(resource);
        const id = resource.status?.id;

        expect(harness.api.countRequests(`POST /servers/${id}/actions/attach_to_network`)).toBe(1);
        expect(harness.api.lastBody(`POST /servers/${id}/actions/attach_to_network`)).toEqual({
            network: 10,
            ip: '10.0.1.11',
        });
        // Network 20 carries the address the fake hands out at create time, which
        // is how we know it was joined there rather than attached afterwards.
        expect(only().private_net).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ network: 20, ip: '10.0.1.100' }),
                expect.objectContaining({ network: 10, ip: '10.0.1.11' }),
            ]),
        );
        expect(only().private_net).toHaveLength(2);
    });

    it('refuses to move a fixed private IP without allowDowntime', async () => {
        const resource = server({ networks: [{ networkRef: { id: 10 }, ip: '10.0.1.11' }] });
        await servers.settle(resource);
        const id = resource.status?.id;
        harness.api.reset();

        resource.spec.networks = [{ networkRef: { id: 10 }, ip: '10.0.1.12' }];
        await servers.once(resource);

        expect(harness.api.countRequests(`POST /servers/${id}/actions/detach_from_network`)).toBe(
            0,
        );
        expect(servers.store.condition('default', 'example', CONDITION_SYNCED)).toMatchObject({
            status: 'False',
            reason: 'GuardRequired',
        });
        expect(resource.status?.message).toMatch(/allowDowntime/);
        expect((only().private_net as Array<{ ip: string }>)[0]?.ip).toBe('10.0.1.11');
    });

    it('re-attaches with the new IP when allowDowntime is set', async () => {
        const resource = server({
            allowDowntime: true,
            networks: [{ networkRef: { id: 10 }, ip: '10.0.1.11', aliasIps: ['10.0.1.200'] }],
        });
        await servers.settle(resource);
        const id = resource.status?.id;
        harness.api.reset();

        resource.spec.networks = [
            { networkRef: { id: 10 }, ip: '10.0.1.12', aliasIps: ['10.0.1.200'] },
        ];
        await servers.settle(resource);

        expect(harness.api.countRequests(`POST /servers/${id}/actions/detach_from_network`)).toBe(
            1,
        );
        expect(harness.api.lastBody(`POST /servers/${id}/actions/attach_to_network`)).toEqual({
            network: 10,
            ip: '10.0.1.12',
            alias_ips: ['10.0.1.200'],
        });
        expect(only().private_net).toEqual([
            expect.objectContaining({ network: 10, ip: '10.0.1.12', alias_ips: ['10.0.1.200'] }),
        ]);
    });

    it('leaves attachments alone when spec.networks is absent', async () => {
        const resource = server({ networks: [{ networkRef: { id: 10 } }] });
        await servers.settle(resource);
        harness.api.reset();

        resource.spec.networks = undefined;
        await servers.settle(resource);

        expect(only().private_net).toHaveLength(1);
    });

    it('refuses to change placement group while the server is running', async () => {
        const resource = server();
        await servers.settle(resource);
        harness.api.reset();

        resource.spec.placementGroupRef = { id: 55 };
        await servers.once(resource);

        expect(harness.api.countRequests('POST /servers/')).toBe(0);
        expect(resource.status?.message).toMatch(/powered off/);
    });

    it('changes placement group once the server is off', async () => {
        const resource = server({ powerState: 'Stopped' });
        await servers.settle(resource);
        const id = resource.status?.id;

        resource.spec.placementGroupRef = { id: 55 };
        await servers.settle(resource);

        expect(
            harness.api.countRequests(`POST /servers/${id}/actions/add_to_placement_group`),
        ).toBe(1);
    });
});

describe('reverse DNS and protection', () => {
    it('publishes a reverse DNS entry for the public address', async () => {
        const resource = server();
        await servers.settle(resource);
        const ipv4 = resource.status?.ipv4 ?? '';

        resource.spec.dnsPtr = [{ ip: ipv4, dnsPtr: 'web-01.example.com' }];
        await servers.settle(resource);

        expect(
            harness.api.lastBody(`POST /servers/${resource.status?.id}/actions/change_dns_ptr`),
        ).toEqual({ ip: ipv4, dns_ptr: 'web-01.example.com' });
    });

    it('does not re-send a reverse DNS entry that is already set', async () => {
        const resource = server();
        await servers.settle(resource);
        const ipv4 = resource.status?.ipv4 ?? '';
        resource.spec.dnsPtr = [{ ip: ipv4, dnsPtr: 'web-01.example.com' }];
        await servers.settle(resource);
        harness.api.reset();

        await servers.settle(resource);

        expect(harness.api.countRequests('POST /servers/')).toBe(0);
    });

    it('applies both protection flags', async () => {
        const resource = server({ protection: { delete: true, rebuild: true } });
        await servers.settle(resource);

        expect(only().protection).toMatchObject({ delete: true, rebuild: true });
    });

    it('turns a bare protected error into an instruction', async () => {
        const resource = server({ protection: { delete: true } });
        await servers.settle(resource);
        harness.api.failNext({
            match: 'DELETE /servers/',
            error: Object.assign(
                new (await import('../../src/hcloud/errors.js')).HetznerApiError({
                    status: 403,
                    code: 'protected',
                    message: 'protected',
                    retryable: false,
                }),
            ),
        });

        resource.metadata = { ...resource.metadata, deletionTimestamp: new Date().toISOString() };

        await expect(servers.once(resource)).rejects.toThrow(/spec.protection.delete: false/);
    });
});

describe('locking', () => {
    it('waits instead of stacking actions on a locked server', async () => {
        const resource = server();
        await servers.settle(resource);
        only().locked = true;
        harness.api.reset();

        resource.spec.backups = true;
        const result = await servers.once(resource);

        expect(result.requeueAfterMs).toBeGreaterThan(0);
        expect(harness.api.countRequests('POST /servers/')).toBe(0);
    });
});

describe('drift', () => {
    it('reports a location change it cannot apply', async () => {
        const resource = server();
        await servers.settle(resource);

        resource.spec.location = 'fsn1';
        await servers.once(resource);

        expect(servers.store.condition('default', 'example', CONDITION_SYNCED)).toMatchObject({
            status: 'False',
            reason: 'ImmutableFieldChanged',
        });
        expect(resource.status?.phase).toBe('Updating');
    });
});

describe('deletion', () => {
    it('removes the server and then releases the object', async () => {
        const resource = server();
        await servers.settle(resource);

        resource.metadata = { ...resource.metadata, deletionTimestamp: new Date().toISOString() };
        await servers.once(resource);
        await servers.once(resource);

        expect(harness.api.all('servers')).toHaveLength(0);
        expect(resource.metadata?.finalizers ?? []).not.toContain(
            'hcloud.shebanglabs.io/finalizer',
        );
    });
});

describe('describeServerState', () => {
    const at = (status: string): Server => ({ id: 1, name: 'a', status });

    it.each([
        ['running', 'Ready', true],
        ['initializing', 'Creating', false],
        ['starting', 'Creating', false],
        ['migrating', 'Updating', false],
        ['rebuilding', 'Updating', false],
        ['stopping', 'Updating', false],
        ['deleting', 'Deleting', false],
        ['gibberish', 'Error', false],
    ])('maps %o to phase %o, ready=%s', (status, phase, ready) => {
        expect(describeServerState(at(status))).toMatchObject({ phase, ready });
    });

    it('treats "off" as a legitimate state, not an error', () => {
        // spec.powerState: Stopped is a desired state; reporting it as Error would
        // make every deliberately stopped server look broken.
        expect(describeServerState(at('off'))).toMatchObject({ phase: 'Ready', ready: false });
    });

    it('describes an empty status without producing a blank message', () => {
        expect(describeServerState(at('')).message).toMatch(/unknown state/);
    });
});

describe('imageMatches', () => {
    const withImage = (image: Server['image']): Server => ({
        id: 1,
        name: 'a',
        status: 'running',
        image,
    });

    it('compares system images by name', () => {
        expect(imageMatches('ubuntu-24.04', withImage({ id: 1, name: 'ubuntu-24.04' }))).toBe(true);
        expect(imageMatches('debian-12', withImage({ id: 1, name: 'ubuntu-24.04' }))).toBe(false);
    });

    it('compares snapshots by id, because their name is null', () => {
        expect(imageMatches('4711', withImage({ id: 4711, name: null }))).toBe(true);
        expect(imageMatches('4712', withImage({ id: 4711, name: null }))).toBe(false);
    });

    it('does not report drift when the image is gone', () => {
        expect(imageMatches('ubuntu-24.04', withImage(null))).toBe(true);
    });

    it('does not let a snapshot pass for a named image', () => {
        expect(imageMatches('ubuntu-24.04', withImage({ id: 4711, name: null }))).toBe(false);
    });
});

describe('settling', () => {
    it('stops asking to be reconciled once a running server matches the spec', async () => {
        const resource = server();

        const result = await servers.settle(resource).then(() => servers.once(resource));

        expect(result.requeueAfterMs).toBeUndefined();
    });

    it('stops asking to be reconciled once a server the spec wants off is off', async () => {
        // Without this, a deliberately stopped server re-reconciles every minute
        // forever: it is never "Ready", but it is exactly what was asked for.
        const resource = server({ powerState: 'Stopped' });
        await servers.settle(resource);

        const result = await servers.once(resource);

        expect(only().status).toBe('off');
        expect(result.requeueAfterMs).toBeUndefined();
    });

    it('reports a deliberately stopped server as Ready', async () => {
        // Hetzner attaches volumes and moves placement groups on stopped servers,
        // so "off" is a usable state when it is the one that was asked for.
        const resource = server({ powerState: 'Stopped' });
        await servers.settle(resource);

        expect(only().status).toBe('off');
        expect(resource.status?.phase).toBe('Ready');
        expect(servers.store.condition('default', 'example', CONDITION_READY)).toMatchObject({
            status: 'True',
        });
    });

    it('does not report a server that should be on as Ready while it is off', () => {
        const adapter = createServerAdapter(harness.hcloud.servers);
        const off: Server = { id: 1, name: 'a', status: 'off' };

        expect(adapter.project(off, { ...baseSpec, powerState: 'Stopped' })).toMatchObject({
            ready: true,
        });
        expect(adapter.project(off, { ...baseSpec, powerState: 'Running' })).toMatchObject({
            ready: false,
        });
    });

    it('keeps asking while a server that should be on is off', async () => {
        const resource = server({ powerState: 'Running' });
        await servers.settle(resource);
        // Something stopped it outside the operator.
        only().status = 'off';

        const result = await servers.once(resource);

        expect(result.requeueAfterMs).toBeGreaterThan(0);
    });
});
