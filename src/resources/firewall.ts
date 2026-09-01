/**
 * HetznerFirewall — stateless packet filter rules and where they apply.
 *
 * Two Hetzner quirks shape this adapter:
 *
 *   1. `set_rules` replaces the whole rule set. There is no partial update —
 *      which suits a declarative controller, because the spec *is* the whole
 *      desired set.
 *   2. A firewall applies either to specific servers or to a Hetzner label
 *      selector. Label selectors are the interesting option: a firewall can
 *      cover every server the operator manages for one Kubernetes namespace,
 *      including servers created after the firewall.
 */

import type { ResourceRef } from '../framework/references.js';
import type { ResourceAdapter, UpdateOutcome } from '../framework/types.js';
import type { FirewallApi } from '../hcloud/resources/firewalls.js';
import type { Firewall, FirewallAppliedTo, FirewallRule } from '../hcloud/types.js';
import type { CommonSpec, CommonStatus, ResourceDescriptor } from '../kube/api.js';
import { ChangeLog, deepEqual } from './common.js';

export const FIREWALL_PROTOCOLS = ['tcp', 'udp', 'icmp', 'esp', 'gre'] as const;
export type FirewallProtocol = (typeof FIREWALL_PROTOCOLS)[number];

export interface FirewallRuleSpec {
    direction: 'in' | 'out';
    protocol: FirewallProtocol;
    /** A port or range ("80", "8000-8080"). Required for tcp and udp. */
    port?: string;
    /** CIDRs the rule accepts traffic from. Required for `direction: in`. */
    sourceIps?: string[];
    /** CIDRs the rule allows traffic to. Required for `direction: out`. */
    destinationIps?: string[];
    description?: string;
}

export interface HetznerFirewallSpec extends CommonSpec {
    rules?: FirewallRuleSpec[];
    /** Servers this firewall protects. */
    applyToServerRefs?: ResourceRef[];
    /** Hetzner label selectors this firewall protects, e.g. "role=web". */
    applyToLabelSelectors?: string[];
}

export interface HetznerFirewallStatus extends CommonStatus {
    ruleCount?: number;
    appliedToServerIds?: number[];
    appliedToLabelSelectors?: string[];
}

export const firewallDescriptor: ResourceDescriptor = {
    kind: 'HetznerFirewall',
    plural: 'hetznerfirewalls',
    shortName: 'hfw',
};

export function createFirewallAdapter(
    api: FirewallApi,
): ResourceAdapter<HetznerFirewallSpec, HetznerFirewallStatus, Firewall> {
    return {
        descriptor: firewallDescriptor,
        api,
        syncName: true,

        validate(spec) {
            const problems: string[] = [];
            for (const [index, rule] of (spec.rules ?? []).entries()) {
                const where = `spec.rules[${index}]`;
                if (!FIREWALL_PROTOCOLS.includes(rule.protocol)) {
                    problems.push(
                        `${where}.protocol must be one of ${FIREWALL_PROTOCOLS.join(', ')}, got "${rule.protocol}"`,
                    );
                }
                if (['tcp', 'udp'].includes(rule.protocol) && !rule.port) {
                    problems.push(`${where}.port is required for ${rule.protocol} rules`);
                }
                if (rule.direction === 'in' && !rule.sourceIps?.length) {
                    problems.push(`${where}.sourceIps is required for inbound rules`);
                }
                if (rule.direction === 'out' && !rule.destinationIps?.length) {
                    problems.push(`${where}.destinationIps is required for outbound rules`);
                }
            }
            return problems;
        },

        async create(context) {
            const applyTo = await resolveTargets(context.spec, context);
            return api.create({
                name: context.hetznerName,
                rules: (context.spec.rules ?? []).map(toRulePayload),
                applyTo,
                labels: context.labels,
            });
        },

        async update(context, remote): Promise<UpdateOutcome> {
            const log = new ChangeLog();

            const desiredRules = (context.spec.rules ?? []).map(toRulePayload);
            if (!rulesMatch(remote.rules ?? [], desiredRules)) {
                await api.setRules(remote.id, desiredRules);
                log.record(`replaced the rule set with ${desiredRules.length} rule(s)`);
            }

            const desired = await resolveTargets(context.spec, context);
            const actual = (remote.applied_to ?? []).map(normaliseTarget);
            const desiredKeys = new Set(desired.map(targetKey));
            const actualKeys = new Set(actual.map(targetKey));

            const toAdd = desired.filter((target) => !actualKeys.has(targetKey(target)));
            const toRemove = actual.filter((target) => !desiredKeys.has(targetKey(target)));

            if (toAdd.length) {
                await api.applyToResources(remote.id, toAdd);
                log.record(`applied to ${toAdd.map(targetKey).join(', ')}`);
            }
            if (toRemove.length) {
                await api.removeFromResources(remote.id, toRemove);
                log.record(`removed from ${toRemove.map(targetKey).join(', ')}`);
            }

            return { changed: log.changed, changes: log.changes };
        },

        project(remote) {
            const applied = remote.applied_to ?? [];
            const serverIds = applied
                .filter((target) => target.type === 'server')
                .map((target) => target.server?.id)
                .filter((id): id is number => id !== undefined);
            const selectors = applied
                .filter((target) => target.type === 'label_selector')
                .map((target) => target.label_selector?.selector)
                .filter((selector): selector is string => Boolean(selector));

            return {
                ready: true,
                phase: 'Ready',
                message: `The firewall has ${(remote.rules ?? []).length} rule(s) and protects ${
                    serverIds.length + selectors.length
                } target(s)`,
                status: {
                    ruleCount: (remote.rules ?? []).length,
                    appliedToServerIds: serverIds,
                    appliedToLabelSelectors: selectors,
                },
            };
        },
    };
}

async function resolveTargets(
    spec: HetznerFirewallSpec,
    context: {
        refs: { resolve(kind: string, ref: ResourceRef, ns: string): Promise<number> };
        namespace: string;
    },
): Promise<FirewallAppliedTo[]> {
    const targets: FirewallAppliedTo[] = [];
    for (const ref of spec.applyToServerRefs ?? []) {
        const id = await context.refs.resolve('HetznerServer', ref, context.namespace);
        targets.push({ type: 'server', server: { id } });
    }
    for (const selector of spec.applyToLabelSelectors ?? []) {
        targets.push({ type: 'label_selector', label_selector: { selector } });
    }
    return targets;
}

/** A stable identity for a target, so add/remove sets can be diffed. */
function targetKey(target: FirewallAppliedTo): string {
    return target.type === 'server'
        ? `server:${target.server?.id}`
        : `label_selector:${target.label_selector?.selector}`;
}

/** Drops the read-only `applied_to_resources` echo Hetzner adds to responses. */
function normaliseTarget(target: FirewallAppliedTo): FirewallAppliedTo {
    return target.type === 'server'
        ? { type: 'server', server: { id: target.server?.id ?? 0 } }
        : {
              type: 'label_selector',
              label_selector: { selector: target.label_selector?.selector ?? '' },
          };
}

export function toRulePayload(rule: FirewallRuleSpec): FirewallRule {
    return {
        direction: rule.direction,
        protocol: rule.protocol,
        ...(rule.port ? { port: rule.port } : {}),
        ...(rule.direction === 'in'
            ? { source_ips: rule.sourceIps ?? [] }
            : { destination_ips: rule.destinationIps ?? [] }),
        ...(rule.description ? { description: rule.description } : {}),
    };
}

/**
 * Rules are compared as an unordered set: Hetzner does not preserve the order
 * they were sent in, and re-sending an identical set on every resync would show
 * up as a permanent "changed" in the logs.
 */
export function rulesMatch(actual: FirewallRule[], desired: FirewallRule[]): boolean {
    if (actual.length !== desired.length) {
        return false;
    }
    const remaining = [...actual];
    for (const rule of desired) {
        const index = remaining.findIndex((candidate) => sameRule(candidate, rule));
        if (index < 0) {
            return false;
        }
        remaining.splice(index, 1);
    }
    return true;
}

function sameRule(left: FirewallRule, right: FirewallRule): boolean {
    return (
        left.direction === right.direction &&
        left.protocol === right.protocol &&
        (left.port ?? null) === (right.port ?? null) &&
        // Hetzner normalises CIDRs but not their order.
        deepEqual([...(left.source_ips ?? [])].sort(), [...(right.source_ips ?? [])].sort()) &&
        deepEqual(
            [...(left.destination_ips ?? [])].sort(),
            [...(right.destination_ips ?? [])].sort(),
        ) &&
        (left.description ?? null) === (right.description ?? null)
    );
}
