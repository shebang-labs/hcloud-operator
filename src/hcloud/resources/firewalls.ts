/**
 * Hetzner firewalls.
 *
 * Two things make firewalls different from every other resource:
 *
 *   1. `set_rules` replaces the *entire* rule set. There is no add/remove, so
 *      the adapter always sends the full desired list — which is exactly what a
 *      declarative controller wants anyway.
 *   2. A firewall is applied to resources either by server id or by a Hetzner
 *      label selector, and both forms come back in the same `applied_to` array.
 */

import type { Firewall, FirewallAppliedTo, FirewallRule } from '../types.js';
import {
    type BaseResourceApi,
    createBaseResourceApi,
    type ResourceClientDependencies,
} from './base.js';

export interface CreateFirewallInput {
    name: string;
    rules?: FirewallRule[];
    applyTo?: FirewallAppliedTo[];
    labels?: Record<string, string>;
}

export interface FirewallApi extends BaseResourceApi<Firewall> {
    create(input: CreateFirewallInput): Promise<Firewall>;
    /** Replaces the whole rule set. Hetzner has no partial rule update. */
    setRules(id: number, rules: FirewallRule[]): Promise<void>;
    applyToResources(id: number, targets: FirewallAppliedTo[]): Promise<void>;
    removeFromResources(id: number, targets: FirewallAppliedTo[]): Promise<void>;
}

export function createFirewallApi(dependencies: ResourceClientDependencies): FirewallApi {
    const base = createBaseResourceApi<Firewall>(dependencies, {
        plural: 'firewalls',
        singular: 'firewall',
        scope: 'firewalls',
    });

    return {
        ...base,

        async create(input) {
            const { resource, actions } = await base.createRaw({
                name: input.name,
                ...(input.rules?.length ? { rules: input.rules } : {}),
                ...(input.applyTo?.length ? { apply_to: input.applyTo } : {}),
                ...(input.labels ? { labels: input.labels } : {}),
            });
            await base.awaitActions(actions);
            return resource;
        },

        async setRules(id, rules) {
            await base.runActions(id, 'set_rules', { rules });
        },

        async applyToResources(id, targets) {
            if (targets.length === 0) {
                return;
            }
            await base.runActions(id, 'apply_to_resources', { apply_to: targets });
        },

        async removeFromResources(id, targets) {
            if (targets.length === 0) {
                return;
            }
            await base.runActions(id, 'remove_from_resources', { remove_from: targets });
        },
    };
}
