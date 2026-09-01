/**
 * Networks are the first kind whose `update` does real diffing: Hetzner has no
 * "set subnets" call, so the adapter must work out which add/delete actions
 * close the gap — and must not re-send ones that are already applied, or every
 * resync would show as a change.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
    createNetworkAdapter,
    type HetznerNetworkSpec,
    isCidr,
} from '../../src/resources/network.js';
import { buildResource } from '../support/fake-store.js';
import { createHarness, type Harness, type KindHarness } from '../support/harness.js';

function network(spec: Partial<HetznerNetworkSpec> = {}, options = {}) {
    return buildResource<HetznerNetworkSpec, never>(
        'HetznerNetwork',
        { ipRange: '10.0.0.0/16', ...spec },
        options,
    );
}

let harness: Harness;
let networks: KindHarness;

beforeEach(() => {
    harness = createHarness();
    networks = harness.register(createNetworkAdapter(harness.hcloud.networks));
});

const only = () => harness.api.all('networks')[0] as Record<string, unknown>;

describe('isCidr', () => {
    it.each([
        ['10.0.0.0/16', true],
        ['10.0.1.0/24', true],
        ['0.0.0.0/0', true],
        ['2001:db8::/64', true],
        ['10.0.0.0', false],
        ['10.0.0.0/33', false],
        ['999.0.0.0/8', false],
        ['10.0.0/16', false],
        ['', false],
        [undefined, false],
    ])('says %o is %s', (value, expected) => {
        expect(isCidr(value)).toBe(expected);
    });
});

describe('validation', () => {
    it('rejects a bad network range', async () => {
        const resource = network({ ipRange: 'not-a-cidr' });
        await networks.once(resource);
        expect(resource.status?.message).toMatch(/not a valid CIDR/);
    });

    it('rejects a bad subnet and a subnet with no zone', async () => {
        const resource = network({
            subnets: [
                { type: 'cloud', ipRange: 'nope', networkZone: 'eu-central' },
                { type: 'cloud', ipRange: '10.0.2.0/24', networkZone: '' },
            ],
        });
        await networks.once(resource);
        expect(resource.status?.message).toMatch(/subnets\[\].ipRange/);
        expect(resource.status?.message).toMatch(/networkZone is required/);
    });

    it('rejects a route with a bad destination', async () => {
        const resource = network({ routes: [{ destination: 'nope', gateway: '10.0.1.1' }] });
        await networks.once(resource);
        expect(resource.status?.message).toMatch(/routes\[\].destination/);
    });
});

describe('creation', () => {
    it('creates the network with its subnets and routes in one call', async () => {
        const resource = network({
            subnets: [{ type: 'cloud', ipRange: '10.0.1.0/24', networkZone: 'eu-central' }],
            routes: [{ destination: '10.9.0.0/16', gateway: '10.0.1.1' }],
        });

        await networks.settle(resource);

        expect(resource.status).toMatchObject({ ipRange: '10.0.0.0/16', phase: 'Ready' });
        expect(resource.status?.subnets).toHaveLength(1);
        expect(harness.api.countRequests('POST /networks/')).toBe(0);
    });
});

describe('subnets', () => {
    it('adds one that was appended to the spec', async () => {
        const resource = network({
            subnets: [{ type: 'cloud', ipRange: '10.0.1.0/24', networkZone: 'eu-central' }],
        });
        await networks.settle(resource);

        resource.spec.subnets?.push({
            type: 'cloud',
            ipRange: '10.0.2.0/24',
            networkZone: 'eu-central',
        });
        await networks.settle(resource);

        expect(only().subnets).toHaveLength(2);
    });

    it('deletes one that was removed from the spec', async () => {
        const resource = network({
            subnets: [
                { type: 'cloud', ipRange: '10.0.1.0/24', networkZone: 'eu-central' },
                { type: 'cloud', ipRange: '10.0.2.0/24', networkZone: 'eu-central' },
            ],
        });
        await networks.settle(resource);

        resource.spec.subnets = [
            { type: 'cloud', ipRange: '10.0.1.0/24', networkZone: 'eu-central' },
        ];
        await networks.settle(resource);

        expect(only().subnets).toHaveLength(1);
    });

    it('does nothing when the subnets already match', async () => {
        const resource = network({
            subnets: [{ type: 'cloud', ipRange: '10.0.1.0/24', networkZone: 'eu-central' }],
        });
        await networks.settle(resource);
        harness.api.reset();

        await networks.settle(resource);

        expect(harness.api.countRequests('POST /networks/')).toBe(0);
    });
});

describe('routes', () => {
    it('adds and removes routes to match the spec', async () => {
        const resource = network({ routes: [{ destination: '10.9.0.0/16', gateway: '10.0.1.1' }] });
        await networks.settle(resource);

        resource.spec.routes = [{ destination: '10.8.0.0/16', gateway: '10.0.1.2' }];
        await networks.settle(resource);

        expect(only().routes).toEqual([{ destination: '10.8.0.0/16', gateway: '10.0.1.2' }]);
    });
});

describe('ip range', () => {
    it('refuses to change it without allowIpRangeChange', async () => {
        const resource = network();
        await networks.settle(resource);

        resource.spec.ipRange = '10.0.0.0/12';
        await networks.once(resource);

        expect(only().ip_range).toBe('10.0.0.0/16');
        expect(resource.status?.message).toMatch(/allowIpRangeChange/);
    });

    it('widens it when the guard is set', async () => {
        const resource = network({ allowIpRangeChange: true });
        await networks.settle(resource);

        resource.spec.ipRange = '10.0.0.0/12';
        await networks.settle(resource);

        expect(only().ip_range).toBe('10.0.0.0/12');
    });
});

describe('other fields', () => {
    it('toggles exposeRoutesToVSwitch', async () => {
        const resource = network();
        await networks.settle(resource);

        resource.spec.exposeRoutesToVSwitch = true;
        await networks.settle(resource);

        expect(only().expose_routes_to_vswitch).toBe(true);
    });

    it('applies delete protection', async () => {
        await networks.settle(network({ protection: { delete: true } }));

        expect(only().protection).toMatchObject({ delete: true });
    });

    it('reports attached servers and load balancers in status', async () => {
        const resource = network();
        await networks.settle(resource);
        only().servers = [1, 2];
        only().load_balancers = [3];

        await networks.settle(resource);

        expect(resource.status?.serverIds).toEqual([1, 2]);
        expect(resource.status?.loadBalancerIds).toEqual([3]);
    });
});
