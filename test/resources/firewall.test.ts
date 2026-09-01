/**
 * Firewalls have two quirks worth pinning down: `set_rules` replaces the whole
 * rule set, and rules come back from Hetzner in an arbitrary order. Comparing
 * them as an ordered list would make every resync look like a change and
 * rewrite the rules forever.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
    createFirewallAdapter,
    type HetznerFirewallSpec,
    rulesMatch,
    toRulePayload,
} from '../../src/resources/firewall.js';
import { createServerAdapter } from '../../src/resources/server/index.js';
import { buildResource } from '../support/fake-store.js';
import { createHarness, type Harness, type KindHarness } from '../support/harness.js';

function firewall(spec: Partial<HetznerFirewallSpec> = {}, options = {}) {
    return buildResource<HetznerFirewallSpec, never>('HetznerFirewall', { ...spec }, options);
}

const httpsRule = {
    direction: 'in' as const,
    protocol: 'tcp' as const,
    port: '443',
    sourceIps: ['0.0.0.0/0'],
};

let harness: Harness;
let firewalls: KindHarness;

beforeEach(() => {
    harness = createHarness();
    firewalls = harness.register(createFirewallAdapter(harness.hcloud.firewalls));
});

const only = () => harness.api.all('firewalls')[0] as Record<string, unknown>;

describe('validation', () => {
    it('requires a port for tcp and udp', async () => {
        const resource = firewall({
            rules: [{ direction: 'in', protocol: 'tcp', sourceIps: ['0.0.0.0/0'] }],
        });
        await firewalls.once(resource);
        expect(resource.status?.message).toMatch(/port is required for tcp/);
    });

    it('does not require a port for icmp', async () => {
        await firewalls.settle(
            firewall({ rules: [{ direction: 'in', protocol: 'icmp', sourceIps: ['0.0.0.0/0'] }] }),
        );
        expect(harness.api.all('firewalls')).toHaveLength(1);
    });

    it('requires sourceIps inbound and destinationIps outbound', async () => {
        const inbound = firewall({ rules: [{ direction: 'in', protocol: 'tcp', port: '80' }] });
        await firewalls.once(inbound);
        expect(inbound.status?.message).toMatch(/sourceIps is required for inbound/);

        const outbound = firewall({ rules: [{ direction: 'out', protocol: 'tcp', port: '80' }] });
        await firewalls.once(outbound);
        expect(outbound.status?.message).toMatch(/destinationIps is required for outbound/);
    });

    it('rejects an unknown protocol', async () => {
        const resource = firewall({
            rules: [{ direction: 'in', protocol: 'sctp' as never, sourceIps: ['0.0.0.0/0'] }],
        });
        await firewalls.once(resource);
        expect(resource.status?.message).toMatch(/protocol must be one of/);
    });
});

describe('rules', () => {
    it('creates the firewall with its rules', async () => {
        const resource = firewall({ rules: [httpsRule] });
        await firewalls.settle(resource);

        expect(resource.status?.ruleCount).toBe(1);
        expect(harness.api.lastBody('POST /firewalls')).toMatchObject({
            rules: [{ direction: 'in', protocol: 'tcp', port: '443', source_ips: ['0.0.0.0/0'] }],
        });
    });

    it('replaces the whole rule set when one changes', async () => {
        const resource = firewall({ rules: [httpsRule] });
        await firewalls.settle(resource);

        resource.spec.rules = [httpsRule, { ...httpsRule, port: '80' }];
        await firewalls.settle(resource);

        expect(only().rules).toHaveLength(2);
    });

    it('does not rewrite rules that already match', async () => {
        const resource = firewall({ rules: [httpsRule] });
        await firewalls.settle(resource);
        harness.api.reset();

        await firewalls.settle(resource);

        expect(harness.api.countRequests('POST /firewalls/')).toBe(0);
    });

    it('does not rewrite rules that only differ in order', async () => {
        const rules = [httpsRule, { ...httpsRule, port: '80' }];
        const resource = firewall({ rules });
        await firewalls.settle(resource);

        resource.spec.rules = [...rules].reverse();
        harness.api.reset();
        await firewalls.settle(resource);

        expect(harness.api.countRequests('POST /firewalls/')).toBe(0);
    });
});

describe('targets', () => {
    it('applies to a label selector, which covers servers created later', async () => {
        const resource = firewall({ applyToLabelSelectors: ['role=web'] });
        await firewalls.settle(resource);

        expect(resource.status?.appliedToLabelSelectors).toEqual(['role=web']);
    });

    it('applies to a referenced server', async () => {
        const servers = harness.register(createServerAdapter(harness.hcloud.servers));
        const serverResource = buildResource(
            'HetznerServer',
            { serverType: 'cpx21', image: 'ubuntu-24.04', location: 'nbg1' },
            { name: 'web-01' },
        );
        await servers.settle(serverResource);

        const resource = firewall({ applyToServerRefs: [{ name: 'web-01' }] });
        await firewalls.settle(resource);

        expect(resource.status?.appliedToServerIds).toEqual([serverResource.status?.id]);
    });

    it('adds and removes targets to match the spec', async () => {
        const resource = firewall({ applyToLabelSelectors: ['role=web', 'role=api'] });
        await firewalls.settle(resource);
        expect(only().applied_to).toHaveLength(2);

        resource.spec.applyToLabelSelectors = ['role=web'];
        await firewalls.settle(resource);

        expect(only().applied_to).toHaveLength(1);
    });

    it('does not re-apply targets that are already there', async () => {
        const resource = firewall({ applyToLabelSelectors: ['role=web'] });
        await firewalls.settle(resource);
        harness.api.reset();

        await firewalls.settle(resource);

        expect(harness.api.countRequests('POST /firewalls/')).toBe(0);
    });
});

describe('rulesMatch', () => {
    const rule = toRulePayload(httpsRule);

    it('ignores order', () => {
        const other = toRulePayload({ ...httpsRule, port: '80' });
        expect(rulesMatch([rule, other], [other, rule])).toBe(true);
    });

    it('ignores the order of source CIDRs', () => {
        const a = toRulePayload({ ...httpsRule, sourceIps: ['10.0.0.0/8', '0.0.0.0/0'] });
        const b = toRulePayload({ ...httpsRule, sourceIps: ['0.0.0.0/0', '10.0.0.0/8'] });
        expect(rulesMatch([a], [b])).toBe(true);
    });

    it('notices a different length, port, direction or description', () => {
        expect(rulesMatch([rule], [])).toBe(false);
        expect(rulesMatch([rule], [toRulePayload({ ...httpsRule, port: '80' })])).toBe(false);
        expect(
            rulesMatch(
                [rule],
                [toRulePayload({ ...httpsRule, direction: 'out', destinationIps: ['0.0.0.0/0'] })],
            ),
        ).toBe(false);
        expect(rulesMatch([rule], [toRulePayload({ ...httpsRule, description: 'HTTPS' })])).toBe(
            false,
        );
    });
});

describe('toRulePayload', () => {
    it('sends source_ips inbound and destination_ips outbound, never both', () => {
        expect(toRulePayload(httpsRule)).toEqual({
            direction: 'in',
            protocol: 'tcp',
            port: '443',
            source_ips: ['0.0.0.0/0'],
        });
        expect(
            toRulePayload({
                direction: 'out',
                protocol: 'tcp',
                port: '443',
                destinationIps: ['0.0.0.0/0'],
            }),
        ).toEqual({
            direction: 'out',
            protocol: 'tcp',
            port: '443',
            destination_ips: ['0.0.0.0/0'],
        });
    });
});
