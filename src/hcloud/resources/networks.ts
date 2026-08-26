/**
 * Hetzner private networks.
 *
 * A network is a container for subnets and routes, and both of those are
 * managed through *actions* rather than through the object itself. There is no
 * "update subnets" call: you add and delete them one at a time, which is why
 * this module exposes them as individual operations and the adapter computes
 * the difference.
 */

import type { Network, NetworkRoute, NetworkSubnet, Protection } from '../types.js';
import {
    type BaseResourceApi,
    createBaseResourceApi,
    type ResourceClientDependencies,
} from './base.js';

export interface CreateNetworkInput {
    name: string;
    ipRange: string;
    subnets?: NetworkSubnet[];
    routes?: NetworkRoute[];
    exposeRoutesToVSwitch?: boolean;
    labels?: Record<string, string>;
}

export interface NetworkApi extends BaseResourceApi<Network> {
    create(input: CreateNetworkInput): Promise<Network>;
    addSubnet(id: number, subnet: NetworkSubnet): Promise<void>;
    deleteSubnet(id: number, ipRange: string): Promise<void>;
    addRoute(id: number, route: NetworkRoute): Promise<void>;
    deleteRoute(id: number, route: NetworkRoute): Promise<void>;
    /** Widening the range is allowed; shrinking it is not. */
    changeIpRange(id: number, ipRange: string): Promise<void>;
    changeProtection(id: number, protection: Protection): Promise<void>;
    setExposeRoutesToVSwitch(id: number, expose: boolean): Promise<Network>;
}

export function createNetworkApi(dependencies: ResourceClientDependencies): NetworkApi {
    const base = createBaseResourceApi<Network>(dependencies, {
        plural: 'networks',
        singular: 'network',
        scope: 'networks',
    });

    return {
        ...base,

        async create(input) {
            const { resource, actions } = await base.createRaw({
                name: input.name,
                ip_range: input.ipRange,
                ...(input.subnets?.length ? { subnets: input.subnets } : {}),
                ...(input.routes?.length ? { routes: input.routes } : {}),
                ...(input.exposeRoutesToVSwitch !== undefined
                    ? { expose_routes_to_vswitch: input.exposeRoutesToVSwitch }
                    : {}),
                ...(input.labels ? { labels: input.labels } : {}),
            });
            await base.awaitActions(actions);
            return resource;
        },

        async addSubnet(id, subnet) {
            await base.runAction(id, 'add_subnet', {
                type: subnet.type,
                network_zone: subnet.network_zone,
                ...(subnet.ip_range ? { ip_range: subnet.ip_range } : {}),
                ...(subnet.vswitch_id !== undefined && subnet.vswitch_id !== null
                    ? { vswitch_id: subnet.vswitch_id }
                    : {}),
            });
        },

        async deleteSubnet(id, ipRange) {
            await base.runAction(id, 'delete_subnet', { ip_range: ipRange });
        },

        async addRoute(id, route) {
            await base.runAction(id, 'add_route', route);
        },

        async deleteRoute(id, route) {
            await base.runAction(id, 'delete_route', route);
        },

        async changeIpRange(id, ipRange) {
            await base.runAction(id, 'change_ip_range', { ip_range: ipRange });
        },

        async changeProtection(id, protection) {
            await base.runAction(id, 'change_protection', {
                ...(protection.delete !== undefined ? { delete: protection.delete } : {}),
            });
        },

        setExposeRoutesToVSwitch(id, expose) {
            return base.update(id, { expose_routes_to_vswitch: expose } as never);
        },
    };
}
