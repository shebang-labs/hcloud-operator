/**
 * Hetzner floating IPs: an address that can be moved between servers, which is
 * what makes them useful for failover.
 */

import type { FloatingIp, Protection } from '../types.js';
import {
    type BaseResourceApi,
    createBaseResourceApi,
    type ResourceClientDependencies,
} from './base.js';

export interface CreateFloatingIpInput {
    type: 'ipv4' | 'ipv6';
    name: string;
    description?: string;
    /** Either a home location, or a server to assign it to immediately. */
    homeLocation?: string;
    serverId?: number;
    labels?: Record<string, string>;
}

export interface FloatingIpApi extends BaseResourceApi<FloatingIp> {
    create(input: CreateFloatingIpInput): Promise<FloatingIp>;
    assign(id: number, serverId: number): Promise<void>;
    unassign(id: number): Promise<void>;
    changeDnsPtr(id: number, ip: string, dnsPtr: string | null): Promise<void>;
    changeProtection(id: number, protection: Protection): Promise<void>;
    updateDescription(id: number, description: string): Promise<FloatingIp>;
}

export function createFloatingIpApi(dependencies: ResourceClientDependencies): FloatingIpApi {
    const base = createBaseResourceApi<FloatingIp>(dependencies, {
        plural: 'floating_ips',
        singular: 'floating_ip',
        scope: 'floating_ips',
    });

    return {
        ...base,

        async create(input) {
            const { resource, actions } = await base.createRaw({
                type: input.type,
                name: input.name,
                ...(input.description ? { description: input.description } : {}),
                ...(input.serverId !== undefined
                    ? { server: input.serverId }
                    : { home_location: input.homeLocation }),
                ...(input.labels ? { labels: input.labels } : {}),
            });
            await base.awaitActions(actions);
            return resource;
        },

        async assign(id, serverId) {
            await base.runAction(id, 'assign', { server: serverId });
        },

        async unassign(id) {
            await base.runAction(id, 'unassign');
        },

        async changeDnsPtr(id, ip, dnsPtr) {
            await base.runAction(id, 'change_dns_ptr', { ip, dns_ptr: dnsPtr });
        },

        async changeProtection(id, protection) {
            await base.runAction(id, 'change_protection', {
                ...(protection.delete !== undefined ? { delete: protection.delete } : {}),
            });
        },

        updateDescription(id, description) {
            return base.update(id, { description } as never);
        },
    };
}
