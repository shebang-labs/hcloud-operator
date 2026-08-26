/**
 * The eleven endpoint modules, exercised against the in-memory API.
 *
 * These tests are about the *wire format*: the paths, the snake_case payload
 * keys, and the response unwrapping. A mistake here is invisible to every layer
 * above — the types line up perfectly while Hetzner rejects the request — so
 * this is the one place the request bodies are asserted directly.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createActionTracker } from '../../src/hcloud/actions.js';
import { HetznerApiError } from '../../src/hcloud/errors.js';
import { assembleHetznerCloud, type HetznerCloud } from '../../src/hcloud/index.js';
import { RateLimiter } from '../../src/hcloud/rate-limiter.js';
import { labelSelector } from '../../src/hcloud/resources/base.js';
import { FakeHetznerApi } from '../support/fake-hcloud.js';

let api: FakeHetznerApi;
let hcloud: HetznerCloud;

beforeEach(() => {
    api = new FakeHetznerApi();
    hcloud = assembleHetznerCloud({
        http: api,
        rateLimiter: new RateLimiter({ requestsPerHour: 3_600 }),
        actions: createActionTracker({
            http: api,
            pollIntervalMs: 0,
            maxPollIntervalMs: 0,
            sleep: async () => undefined,
        }),
    });
});

describe('the shared base operations', () => {
    it('returns null instead of throwing for a missing resource', async () => {
        expect(await hcloud.servers.get(999)).toBeNull();
    });

    it('reports a delete of something already gone as false', async () => {
        expect(await hcloud.servers.delete(999)).toBe(false);
    });

    it('filters by label selector', async () => {
        api.seed('servers', { name: 'a', labels: { role: 'web' } });
        api.seed('servers', { name: 'b', labels: { role: 'db' } });

        const found = await hcloud.servers.listByLabel(labelSelector({ role: 'web' }));

        expect(found.map((server) => server.name)).toEqual(['a']);
    });

    it('finds by exact name in a single request', async () => {
        api.seed('servers', { name: 'web-01' });
        api.seed('servers', { name: 'web-01-staging' });
        api.reset();

        const found = await hcloud.servers.getByName('web-01');

        expect(found?.name).toBe('web-01');
        expect(api.countRequests('GET /servers')).toBe(1);
    });

    it('pages through a long list', async () => {
        const paged = new FakeHetznerApi({ pageSize: 2 });
        const client = assembleHetznerCloud({
            http: paged,
            rateLimiter: new RateLimiter({ requestsPerHour: 3_600 }),
            actions: createActionTracker({ http: paged, sleep: async () => undefined }),
        });
        for (let index = 0; index < 7; index += 1) {
            paged.seed('servers', { name: `web-${index}`, labels: { role: 'web' } });
        }

        const found = await client.servers.listByLabel('role=web');

        expect(found).toHaveLength(7);
    });
});

describe('servers', () => {
    it('sends the documented create payload', async () => {
        await hcloud.servers.create({
            name: 'demo-web-01',
            serverType: 'cpx21',
            image: 'ubuntu-24.04',
            location: 'nbg1',
            sshKeyIds: [1, 2],
            networkIds: [10],
            firewallIds: [20],
            placementGroupId: 30,
            userData: '#cloud-config',
            labels: { role: 'web' },
        });

        expect(api.lastBody('POST /servers')).toMatchObject({
            name: 'demo-web-01',
            server_type: 'cpx21',
            image: 'ubuntu-24.04',
            location: 'nbg1',
            start_after_create: true,
            ssh_keys: [1, 2],
            networks: [10],
            firewalls: [{ firewall: 20 }],
            placement_group: 30,
            user_data: '#cloud-config',
            labels: { role: 'web' },
        });
    });

    it('sends a datacenter instead of a location when asked', async () => {
        await hcloud.servers.create({
            name: 'a',
            serverType: 'cx22',
            image: 'ubuntu-24.04',
            datacenter: 'nbg1-dc3',
        });

        const body = api.lastBody('POST /servers') as Record<string, unknown>;
        expect(body.datacenter).toBe('nbg1-dc3');
        expect(body.location).toBeUndefined();
    });

    it('never returns the generated root password', async () => {
        const server = await hcloud.servers.create({
            name: 'a',
            serverType: 'cx22',
            image: 'ubuntu-24.04',
            location: 'nbg1',
        });

        expect(JSON.stringify(server)).not.toContain('root_password');
    });

    it.each([
        ['powerOn', 'poweron'],
        ['shutdown', 'shutdown'],
        ['powerOff', 'poweroff'],
        ['reboot', 'reboot'],
        ['reset', 'reset'],
        ['enableBackup', 'enable_backup'],
        ['disableBackup', 'disable_backup'],
        ['disableRescue', 'disable_rescue'],
        ['detachIso', 'detach_iso'],
        ['removeFromPlacementGroup', 'remove_from_placement_group'],
    ])('%s posts to the %s action', async (method, action) => {
        const server = await hcloud.servers.create({
            name: 'a',
            serverType: 'cx22',
            image: 'ubuntu-24.04',
            location: 'nbg1',
        });

        await hcloud.servers[method as 'powerOn'](server.id);

        expect(api.countRequests(`POST /servers/${server.id}/actions/${action}`)).toBe(1);
    });

    it('passes upgrade_disk through on a resize', async () => {
        const server = await hcloud.servers.create({
            name: 'a',
            serverType: 'cx22',
            image: 'ubuntu-24.04',
            location: 'nbg1',
        });

        await hcloud.servers.changeType(server.id, 'cpx31', true);

        expect(api.lastBody(`POST /servers/${server.id}/actions/change_type`)).toEqual({
            server_type: 'cpx31',
            upgrade_disk: true,
        });
    });

    it('creates a snapshot and returns the image', async () => {
        const server = await hcloud.servers.create({
            name: 'a',
            serverType: 'cx22',
            image: 'ubuntu-24.04',
            location: 'nbg1',
        });

        const image = await hcloud.servers.createImage(server.id, {
            description: 'pre-upgrade',
            labels: { role: 'backup' },
        });

        expect(image.description).toBe('pre-upgrade');
        expect(image.created_from?.id).toBe(server.id);
    });

    it('sends alias IPs when attaching to a network', async () => {
        const server = await hcloud.servers.create({
            name: 'a',
            serverType: 'cx22',
            image: 'ubuntu-24.04',
            location: 'nbg1',
        });

        await hcloud.servers.attachToNetwork(server.id, 10, '10.0.1.5', ['10.0.1.200']);

        expect(api.lastBody(`POST /servers/${server.id}/actions/attach_to_network`)).toEqual({
            network: 10,
            ip: '10.0.1.5',
            alias_ips: ['10.0.1.200'],
        });
    });

    it('sends both protection flags', async () => {
        const server = await hcloud.servers.create({
            name: 'a',
            serverType: 'cx22',
            image: 'ubuntu-24.04',
            location: 'nbg1',
        });

        await hcloud.servers.changeProtection(server.id, { delete: true, rebuild: false });

        expect(api.lastBody(`POST /servers/${server.id}/actions/change_protection`)).toEqual({
            delete: true,
            rebuild: false,
        });
    });
});

describe('ssh keys', () => {
    it('sends public_key in snake_case', async () => {
        await hcloud.sshKeys.create({ name: 'ops', publicKey: 'ssh-ed25519 AAAA', labels: {} });

        expect(api.lastBody('POST /ssh_keys')).toMatchObject({
            name: 'ops',
            public_key: 'ssh-ed25519 AAAA',
        });
    });

    it('looks a key up by fingerprint', async () => {
        const created = await hcloud.sshKeys.create({ name: 'ops', publicKey: 'ssh-ed25519 AAAA' });

        const found = await hcloud.sshKeys.getByFingerprint(created.fingerprint ?? '');

        expect(found?.id).toBe(created.id);
    });
});

describe('volumes', () => {
    it('creates next to a location or a server, never both', async () => {
        await hcloud.volumes.create({ name: 'data', size: 50, location: 'nbg1', format: 'ext4' });
        expect(api.lastBody('POST /volumes')).toMatchObject({
            size: 50,
            location: 'nbg1',
            format: 'ext4',
        });

        await hcloud.volumes.create({ name: 'data-2', size: 50, serverId: 7, automount: true });
        const body = api.lastBody('POST /volumes') as Record<string, unknown>;
        expect(body.server).toBe(7);
        expect(body.location).toBeUndefined();
    });

    it('refuses to shrink before touching the API', async () => {
        const volume = await hcloud.volumes.create({ name: 'data', size: 50, location: 'nbg1' });
        api.reset();

        await expect(hcloud.volumes.resize(volume.id, 10, 50)).rejects.toThrow(/cannot shrink/);
        expect(api.requests).toHaveLength(0);
    });

    it('skips a resize to the size it already is', async () => {
        const volume = await hcloud.volumes.create({ name: 'data', size: 50, location: 'nbg1' });
        api.reset();

        await hcloud.volumes.resize(volume.id, 50, 50);

        expect(api.requests).toHaveLength(0);
    });

    it('attaches and detaches', async () => {
        const volume = await hcloud.volumes.create({ name: 'data', size: 50, location: 'nbg1' });

        await hcloud.volumes.attach(volume.id, 7, true);
        expect(api.peek('volumes', volume.id)?.server).toBe(7);

        await hcloud.volumes.detach(volume.id);
        expect(api.peek('volumes', volume.id)?.server).toBeNull();
    });
});

describe('networks', () => {
    it('sends ip_range and nested subnets in snake_case', async () => {
        await hcloud.networks.create({
            name: 'prod',
            ipRange: '10.0.0.0/16',
            subnets: [{ type: 'cloud', ip_range: '10.0.1.0/24', network_zone: 'eu-central' }],
            routes: [{ destination: '10.1.0.0/16', gateway: '10.0.1.1' }],
        });

        expect(api.lastBody('POST /networks')).toMatchObject({
            ip_range: '10.0.0.0/16',
            subnets: [{ type: 'cloud', ip_range: '10.0.1.0/24', network_zone: 'eu-central' }],
            routes: [{ destination: '10.1.0.0/16', gateway: '10.0.1.1' }],
        });
    });

    it('adds and deletes subnets one at a time, as the API requires', async () => {
        const network = await hcloud.networks.create({ name: 'prod', ipRange: '10.0.0.0/16' });

        await hcloud.networks.addSubnet(network.id, {
            type: 'cloud',
            ip_range: '10.0.1.0/24',
            network_zone: 'eu-central',
        });
        expect(api.peek('networks', network.id)?.subnets).toHaveLength(1);

        await hcloud.networks.deleteSubnet(network.id, '10.0.1.0/24');
        expect(api.peek('networks', network.id)?.subnets).toHaveLength(0);
    });
});

describe('firewalls', () => {
    it('replaces the whole rule set with set_rules', async () => {
        const firewall = await hcloud.firewalls.create({ name: 'web' });

        await hcloud.firewalls.setRules(firewall.id, [
            { direction: 'in', protocol: 'tcp', port: '443', source_ips: ['0.0.0.0/0'] },
        ]);

        expect(api.lastBody(`POST /firewalls/${firewall.id}/actions/set_rules`)).toEqual({
            rules: [{ direction: 'in', protocol: 'tcp', port: '443', source_ips: ['0.0.0.0/0'] }],
        });
    });

    it('skips the apply/remove calls when there is nothing to do', async () => {
        const firewall = await hcloud.firewalls.create({ name: 'web' });
        api.reset();

        await hcloud.firewalls.applyToResources(firewall.id, []);
        await hcloud.firewalls.removeFromResources(firewall.id, []);

        expect(api.requests).toHaveLength(0);
    });

    it('waits for every action a multi-action endpoint returns', async () => {
        const slow = new FakeHetznerApi({ actionPolls: 2 });
        const client = assembleHetznerCloud({
            http: slow,
            rateLimiter: new RateLimiter({ requestsPerHour: 3_600 }),
            actions: createActionTracker({
                http: slow,
                pollIntervalMs: 0,
                maxPollIntervalMs: 0,
                sleep: async () => undefined,
            }),
        });
        const firewall = await client.firewalls.create({ name: 'web' });

        await client.firewalls.setRules(firewall.id, []);

        expect(slow.countRequests('GET /firewalls/actions/')).toBeGreaterThan(0);
    });
});

describe('load balancers', () => {
    it('wraps the algorithm and picks location or network zone', async () => {
        await hcloud.loadBalancers.create({
            name: 'web',
            loadBalancerType: 'lb11',
            algorithm: 'least_connections',
            networkZone: 'eu-central',
            networkId: 10,
            publicInterface: false,
        });

        expect(api.lastBody('POST /load_balancers')).toMatchObject({
            load_balancer_type: 'lb11',
            algorithm: { type: 'least_connections' },
            network_zone: 'eu-central',
            network: 10,
            public_interface: false,
        });
    });

    it('sends only the identity of a target when removing it', async () => {
        const balancer = await hcloud.loadBalancers.create({
            name: 'web',
            loadBalancerType: 'lb11',
            location: 'nbg1',
        });

        await hcloud.loadBalancers.removeTarget(balancer.id, {
            type: 'server',
            server: { id: 7 },
            use_private_ip: true,
            health_status: [{ listen_port: 443, status: 'healthy' }],
        });

        expect(api.lastBody(`POST /load_balancers/${balancer.id}/actions/remove_target`)).toEqual({
            type: 'server',
            server: { id: 7 },
        });
    });

    it('toggles the public interface through the right action', async () => {
        const balancer = await hcloud.loadBalancers.create({
            name: 'web',
            loadBalancerType: 'lb11',
            location: 'nbg1',
        });

        await hcloud.loadBalancers.setPublicInterface(balancer.id, false);
        expect(
            api.countRequests(
                `POST /load_balancers/${balancer.id}/actions/disable_public_interface`,
            ),
        ).toBe(1);

        await hcloud.loadBalancers.setPublicInterface(balancer.id, true);
        expect(
            api.countRequests(
                `POST /load_balancers/${balancer.id}/actions/enable_public_interface`,
            ),
        ).toBe(1);
    });
});

describe('floating and primary IPs', () => {
    it('creates a floating IP homed to a location', async () => {
        await hcloud.floatingIps.create({ type: 'ipv4', name: 'egress', homeLocation: 'nbg1' });

        expect(api.lastBody('POST /floating_ips')).toMatchObject({
            type: 'ipv4',
            home_location: 'nbg1',
        });
    });

    it('assigns a primary IP with its assignee type', async () => {
        const ip = await hcloud.primaryIps.create({
            type: 'ipv4',
            name: 'web',
            datacenter: 'nbg1-dc3',
        });

        await hcloud.primaryIps.assign(ip.id, 7);

        expect(api.lastBody(`POST /primary_ips/${ip.id}/actions/assign`)).toEqual({
            assignee_id: 7,
            assignee_type: 'server',
        });
    });

    it('clears reverse DNS with an explicit null', async () => {
        const ip = await hcloud.floatingIps.create({
            type: 'ipv4',
            name: 'egress',
            homeLocation: 'nbg1',
        });

        await hcloud.floatingIps.changeDnsPtr(ip.id, '203.0.113.5', null);

        expect(api.lastBody(`POST /floating_ips/${ip.id}/actions/change_dns_ptr`)).toEqual({
            ip: '203.0.113.5',
            dns_ptr: null,
        });
    });
});

describe('certificates', () => {
    it('sends private_key for an uploaded certificate and never reads it back', async () => {
        const certificate = await hcloud.certificates.create({
            type: 'uploaded',
            name: 'tls',
            certificate: '-----BEGIN CERTIFICATE-----',
            privateKey: '-----BEGIN PRIVATE KEY-----super-secret',
        });

        expect(api.lastBody('POST /certificates')).toMatchObject({
            type: 'uploaded',
            private_key: '-----BEGIN PRIVATE KEY-----super-secret',
        });
        expect(JSON.stringify(certificate)).not.toContain('super-secret');
    });

    it('sends domain_names for a managed certificate', async () => {
        await hcloud.certificates.create({
            type: 'managed',
            name: 'tls',
            domainNames: ['example.com'],
        });

        expect(api.lastBody('POST /certificates')).toMatchObject({
            type: 'managed',
            domain_names: ['example.com'],
        });
    });
});

describe('images', () => {
    it('lists only this project’s snapshots, not Hetzner’s system images', async () => {
        api.seed('images', { name: null, type: 'snapshot', status: 'available' });
        api.seed('images', { name: 'ubuntu-24.04', type: 'system', status: 'available' });

        const own = await hcloud.images.listOwn();

        expect(own).toHaveLength(1);
        expect(own[0]?.type).toBe('snapshot');
    });
});

describe('the read-only catalog', () => {
    it('serves the lists the admission checks need', async () => {
        expect((await hcloud.catalog.serverTypes()).map((type) => type.name)).toContain('cpx21');
        expect((await hcloud.catalog.locations()).map((location) => location.name)).toContain(
            'nbg1',
        );
        expect(await hcloud.catalog.datacenters()).toHaveLength(1);
        expect(await hcloud.catalog.isos()).toHaveLength(1);
        expect(await hcloud.catalog.pricing()).toBeDefined();
    });

    it('caches, so validating a hundred objects is not a hundred requests', async () => {
        await hcloud.catalog.serverTypes();
        await hcloud.catalog.serverTypes();

        expect(api.countRequests('GET /server_types')).toBe(1);
    });

    it('does not cache a failure', async () => {
        api.failNext({
            match: 'GET /server_types',
            error: new HetznerApiError({
                status: 500,
                code: 'server_error',
                message: 'boom',
                retryable: true,
            }),
        });

        await expect(hcloud.catalog.serverTypes()).rejects.toThrow();
        // The next call must try again rather than reject valid input for an hour.
        await expect(hcloud.catalog.serverTypes()).resolves.toHaveLength(3);
    });

    it('drops everything on invalidate', async () => {
        await hcloud.catalog.locations();
        hcloud.catalog.invalidate();
        await hcloud.catalog.locations();

        expect(api.countRequests('GET /locations')).toBe(2);
    });
});
