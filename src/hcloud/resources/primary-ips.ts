/**
 * Hetzner primary IPs: the address a server is born with. Unlike a floating IP
 * it is bound to a datacenter and can only be reassigned while the target
 * server is powered off — a constraint the adapter surfaces as a condition
 * rather than as a retry loop.
 */

import type { PrimaryIp, Protection } from '../types.js';
import {
    type BaseResourceApi,
    createBaseResourceApi,
    type ResourceClientDependencies,
} from './base.js';

export interface CreatePrimaryIpInput {
    type: 'ipv4' | 'ipv6';
    name: string;
    datacenter?: string;
    assigneeId?: number;
    assigneeType?: string;
    /** Whether Hetzner deletes the IP when its server goes away. */
    autoDelete?: boolean;
    labels?: Record<string, string>;
}

export interface PrimaryIpApi extends BaseResourceApi<PrimaryIp> {
    create(input: CreatePrimaryIpInput): Promise<PrimaryIp>;
    assign(id: number, assigneeId: number, assigneeType?: string): Promise<void>;
    unassign(id: number): Promise<void>;
    changeDnsPtr(id: number, ip: string, dnsPtr: string | null): Promise<void>;
    changeProtection(id: number, protection: Protection): Promise<void>;
    setAutoDelete(id: number, autoDelete: boolean): Promise<PrimaryIp>;
}

export function createPrimaryIpApi(dependencies: ResourceClientDependencies): PrimaryIpApi {
    const base = createBaseResourceApi<PrimaryIp>(dependencies, {
        plural: 'primary_ips',
        singular: 'primary_ip',
        scope: 'primary_ips',
    });

    return {
        ...base,

        async create(input) {
            const { resource, actions } = await base.createRaw({
                type: input.type,
                name: input.name,
                ...(input.assigneeId !== undefined
                    ? {
                          assignee_id: input.assigneeId,
                          assignee_type: input.assigneeType ?? 'server',
                      }
                    : { datacenter: input.datacenter }),
                ...(input.autoDelete !== undefined ? { auto_delete: input.autoDelete } : {}),
                ...(input.labels ? { labels: input.labels } : {}),
            });
            await base.awaitActions(actions);
            return resource;
        },

        async assign(id, assigneeId, assigneeType = 'server') {
            await base.runAction(id, 'assign', {
                assignee_id: assigneeId,
                assignee_type: assigneeType,
            });
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

        setAutoDelete(id, autoDelete) {
            return base.update(id, { auto_delete: autoDelete } as never);
        },
    };
}
