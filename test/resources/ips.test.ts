/**
 * Floating and primary IPs look alike but differ in one important way: a
 * floating IP can be moved between running servers (which is what makes it a
 * failover tool), while a primary IP can only be reassigned with both servers
 * powered off. The operator will not power a server down on its own, so that
 * limit surfaces as a blocked change with an explanation.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
    createFloatingIpAdapter,
    type HetznerFloatingIPSpec,
} from '../../src/resources/floating-ip.js';
import {
    createPrimaryIpAdapter,
    type HetznerPrimaryIPSpec,
} from '../../src/resources/primary-ip.js';
import { buildResource } from '../support/fake-store.js';
import { createHarness, type Harness, type KindHarness } from '../support/harness.js';

let harness: Harness;
let floating: KindHarness;
let primary: KindHarness;

beforeEach(() => {
    harness = createHarness();
    floating = harness.register(createFloatingIpAdapter(harness.hcloud.floatingIps));
    primary = harness.register(createPrimaryIpAdapter(harness.hcloud.primaryIps));
});

function floatingIp(spec: Partial<HetznerFloatingIPSpec> = {}, options = {}) {
    return buildResource<HetznerFloatingIPSpec, never>(
        'HetznerFloatingIP',
        { type: 'ipv4', homeLocation: 'nbg1', ...spec },
        options,
    );
}

function primaryIp(spec: Partial<HetznerPrimaryIPSpec> = {}, options = {}) {
    return buildResource<HetznerPrimaryIPSpec, never>(
        'HetznerPrimaryIP',
        { type: 'ipv4', datacenter: 'nbg1-dc3', ...spec },
        options,
    );
}

const onlyFloating = () => harness.api.all('floating_ips')[0] as Record<string, unknown>;
const onlyPrimary = () => harness.api.all('primary_ips')[0] as Record<string, unknown>;

describe('HetznerFloatingIP', () => {
    it('rejects an unknown type and a spec with no home', async () => {
        const badType = floatingIp({ type: 'ipv7' as never });
        await floating.once(badType);
        expect(badType.status?.message).toMatch(/"ipv4" or "ipv6"/);

        const homeless = floatingIp({ homeLocation: undefined });
        await floating.once(homeless);
        expect(homeless.status?.message).toMatch(/homeLocation or spec.serverRef/);
    });

    it('is Ready as soon as it exists, assigned or not', async () => {
        const resource = floatingIp();
        await floating.settle(resource);

        expect(resource.status).toMatchObject({ assigned: false, phase: 'Ready', type: 'ipv4' });
        expect(resource.status?.ip).toBeTruthy();
    });

    it('reassigns in place, without unassigning first', async () => {
        const resource = floatingIp({ serverRef: { id: 7 } });
        await floating.settle(resource);
        const id = resource.status?.id;
        harness.api.reset();

        resource.spec.serverRef = { id: 8 };
        await floating.settle(resource);

        // Unassigning first would widen the failover window for no reason.
        expect(harness.api.countRequests(`POST /floating_ips/${id}/actions/unassign`)).toBe(0);
        expect(onlyFloating().server).toBe(8);
    });

    it('unassigns when the reference is removed', async () => {
        const resource = floatingIp({ serverRef: { id: 7 } });
        await floating.settle(resource);

        resource.spec.serverRef = undefined;
        await floating.settle(resource);

        expect(onlyFloating().server).toBeNull();
    });

    it('publishes and then leaves reverse DNS alone', async () => {
        const resource = floatingIp();
        await floating.settle(resource);
        const ip = resource.status?.ip ?? '';

        resource.spec.dnsPtr = [{ ip, dnsPtr: 'egress.example.com' }];
        await floating.settle(resource);
        expect(onlyFloating().dns_ptr).toEqual([{ ip, dns_ptr: 'egress.example.com' }]);

        harness.api.reset();
        await floating.settle(resource);
        expect(harness.api.countRequests('POST /floating_ips/')).toBe(0);
    });

    it('updates the description', async () => {
        const resource = floatingIp({ description: 'first' });
        await floating.settle(resource);

        resource.spec.description = 'second';
        await floating.settle(resource);

        expect(onlyFloating().description).toBe('second');
    });

    it('unassigns before deleting, since Hetzner refuses otherwise', async () => {
        const resource = floatingIp({ serverRef: { id: 7 } });
        await floating.settle(resource);
        const id = resource.status?.id;
        harness.api.reset();

        resource.metadata = { ...resource.metadata, deletionTimestamp: new Date().toISOString() };
        await floating.once(resource);

        expect(harness.api.countRequests(`POST /floating_ips/${id}/actions/unassign`)).toBe(1);
        expect(harness.api.all('floating_ips')).toHaveLength(0);
    });

    it('reports a type change it cannot apply', async () => {
        const resource = floatingIp();
        await floating.settle(resource);

        resource.spec.type = 'ipv6';
        await floating.once(resource);

        expect(resource.status?.message).toMatch(/address will change with it/);
    });
});

describe('HetznerPrimaryIP', () => {
    it('assigns an unassigned IP without complaint', async () => {
        const resource = primaryIp();
        await primary.settle(resource);

        resource.spec.serverRef = { id: 7 };
        await primary.settle(resource);

        expect(onlyPrimary().assignee_id).toBe(7);
    });

    it('refuses to move an assigned IP and explains the Hetzner constraint', async () => {
        const resource = primaryIp({ serverRef: { id: 7 } });
        await primary.settle(resource);
        harness.api.reset();

        resource.spec.serverRef = { id: 8 };
        await primary.once(resource);

        expect(onlyPrimary().assignee_id).toBe(7);
        expect(resource.status?.message).toMatch(/both servers are powered off/);
    });

    it('unassigns when the reference is removed', async () => {
        const resource = primaryIp({ serverRef: { id: 7 } });
        await primary.settle(resource);

        resource.spec.serverRef = undefined;
        await primary.settle(resource);

        expect(onlyPrimary().assignee_id).toBeNull();
    });

    it('toggles autoDelete', async () => {
        const resource = primaryIp({ autoDelete: false });
        await primary.settle(resource);

        resource.spec.autoDelete = true;
        await primary.settle(resource);

        expect(onlyPrimary().auto_delete).toBe(true);
    });

    it('applies delete protection', async () => {
        await primary.settle(primaryIp({ protection: { delete: true } }));

        expect(onlyPrimary().protection).toMatchObject({ delete: true });
    });

    it('unassigns before deleting', async () => {
        const resource = primaryIp({ serverRef: { id: 7 } });
        await primary.settle(resource);
        const id = resource.status?.id;
        harness.api.reset();

        resource.metadata = { ...resource.metadata, deletionTimestamp: new Date().toISOString() };
        await primary.once(resource);

        expect(harness.api.countRequests(`POST /primary_ips/${id}/actions/unassign`)).toBe(1);
    });

    it('reports a datacenter change it cannot apply', async () => {
        const resource = primaryIp();
        await primary.settle(resource);

        resource.spec.datacenter = 'fsn1-dc14';
        await primary.once(resource);

        expect(resource.status?.message).toMatch(/Immutable fields differ/);
    });
});
