/**
 * HetznerNetwork — a private network, its subnets and its routes.
 *
 * Hetzner has no "update subnets" call: subnets and routes are added and
 * deleted one at a time through actions. That makes this the first adapter
 * where `update` has real work to do — it computes the difference between the
 * declared list and reality and issues exactly the calls that close the gap.
 *
 * Deleting a subnet that still has servers in it fails, and rightly so; the
 * error surfaces on the `Synced` condition rather than being swallowed.
 */

import type { ResourceAdapter, UpdateOutcome } from '../framework/types.js';
import type { NetworkApi } from '../hcloud/resources/networks.js';
import type { Network, NetworkRoute, NetworkSubnet } from '../hcloud/types.js';
import type { CommonSpec, CommonStatus, ResourceDescriptor } from '../kube/api.js';
import {
    ChangeLog,
    deepEqual,
    type ProtectionSpec,
    protectionMatches,
    toProtectionPayload,
} from './common.js';

export interface SubnetSpec {
    /** Hetzner subnet type: "cloud", "server" or "vswitch". */
    type: string;
    /** CIDR inside the network's range, e.g. "10.0.1.0/24". */
    ipRange: string;
    /** e.g. "eu-central". */
    networkZone: string;
    /** Only for `type: vswitch`. */
    vSwitchId?: number;
}

export interface RouteSpec {
    destination: string;
    gateway: string;
}

export interface HetznerNetworkSpec extends CommonSpec {
    /** The network's CIDR, e.g. "10.0.0.0/16". Can only be widened. */
    ipRange: string;
    subnets?: SubnetSpec[];
    routes?: RouteSpec[];
    /** Publish the network's routes to an attached vSwitch. */
    exposeRoutesToVSwitch?: boolean;
    protection?: ProtectionSpec;
    /**
     * Widening `spec.ipRange` briefly interrupts private traffic, so it is only
     * applied when this is set.
     */
    allowIpRangeChange?: boolean;
}

export interface HetznerNetworkStatus extends CommonStatus {
    ipRange?: string;
    subnets?: Array<{ type: string; ipRange?: string; networkZone: string; gateway?: string }>;
    routes?: RouteSpec[];
    serverIds?: number[];
    loadBalancerIds?: number[];
}

export const networkDescriptor: ResourceDescriptor = {
    kind: 'HetznerNetwork',
    plural: 'hetznernetworks',
    shortName: 'hnet',
};

export function createNetworkAdapter(
    api: NetworkApi,
): ResourceAdapter<HetznerNetworkSpec, HetznerNetworkStatus, Network> {
    return {
        descriptor: networkDescriptor,
        api,
        syncName: true,

        validate(spec) {
            const problems: string[] = [];
            if (!isCidr(spec.ipRange)) {
                problems.push(`spec.ipRange "${spec.ipRange}" is not a valid CIDR block`);
            }
            for (const subnet of spec.subnets ?? []) {
                if (!isCidr(subnet.ipRange)) {
                    problems.push(
                        `spec.subnets[].ipRange "${subnet.ipRange}" is not a valid CIDR block`,
                    );
                }
                if (!subnet.networkZone) {
                    problems.push('spec.subnets[].networkZone is required');
                }
            }
            for (const route of spec.routes ?? []) {
                if (!isCidr(route.destination)) {
                    problems.push(
                        `spec.routes[].destination "${route.destination}" is not a valid CIDR block`,
                    );
                }
            }
            return problems;
        },

        create(context) {
            const { spec } = context;
            return api.create({
                name: context.hetznerName,
                ipRange: spec.ipRange,
                subnets: (spec.subnets ?? []).map(toSubnetPayload),
                routes: (spec.routes ?? []).map(toRoutePayload),
                ...(spec.exposeRoutesToVSwitch !== undefined
                    ? { exposeRoutesToVSwitch: spec.exposeRoutesToVSwitch }
                    : {}),
                labels: context.labels,
            });
        },

        async update(context, remote): Promise<UpdateOutcome> {
            const { spec } = context;
            const log = new ChangeLog();
            let blocked: string | undefined;

            // Subnets are keyed by their CIDR: that is what `delete_subnet`
            // takes, and two subnets can never share one.
            const desiredSubnets = new Map(
                (spec.subnets ?? []).map((subnet) => [subnet.ipRange, subnet]),
            );
            const actualSubnets = new Map(
                (remote.subnets ?? [])
                    .filter((subnet): subnet is NetworkSubnet & { ip_range: string } =>
                        Boolean(subnet.ip_range),
                    )
                    .map((subnet) => [subnet.ip_range, subnet]),
            );

            for (const [ipRange, subnet] of desiredSubnets) {
                if (!actualSubnets.has(ipRange)) {
                    await api.addSubnet(remote.id, toSubnetPayload(subnet));
                    log.record(`added subnet ${ipRange}`);
                }
            }
            for (const ipRange of actualSubnets.keys()) {
                if (!desiredSubnets.has(ipRange)) {
                    // Fails loudly if servers are still attached, which is the
                    // correct outcome: silently detaching them would be worse.
                    await api.deleteSubnet(remote.id, ipRange);
                    log.record(`removed subnet ${ipRange}`);
                }
            }

            const desiredRoutes = (spec.routes ?? []).map(toRoutePayload);
            const actualRoutes = remote.routes ?? [];
            for (const route of desiredRoutes) {
                if (!actualRoutes.some((entry) => deepEqual(entry, route))) {
                    await api.addRoute(remote.id, route);
                    log.record(`added route ${route.destination} via ${route.gateway}`);
                }
            }
            for (const route of actualRoutes) {
                if (!desiredRoutes.some((entry) => deepEqual(entry, route))) {
                    await api.deleteRoute(remote.id, route);
                    log.record(`removed route ${route.destination} via ${route.gateway}`);
                }
            }

            if (spec.ipRange !== remote.ip_range) {
                if (spec.allowIpRangeChange) {
                    await api.changeIpRange(remote.id, spec.ipRange);
                    log.record(`changed ip range to ${spec.ipRange}`);
                } else {
                    blocked =
                        `spec.ipRange is "${spec.ipRange}" but the network uses "${remote.ip_range}". ` +
                        'Changing it briefly interrupts private traffic, so set spec.allowIpRangeChange: true to apply it. ' +
                        'Note that Hetzner can only widen a range, never shrink it.';
                }
            }

            if (
                spec.exposeRoutesToVSwitch !== undefined &&
                spec.exposeRoutesToVSwitch !== (remote.expose_routes_to_vswitch ?? false)
            ) {
                await api.setExposeRoutesToVSwitch(remote.id, spec.exposeRoutesToVSwitch);
                log.record(`set exposeRoutesToVSwitch to ${spec.exposeRoutesToVSwitch}`);
            }

            if (!protectionMatches(remote.protection, spec.protection)) {
                await api.changeProtection(remote.id, toProtectionPayload(spec.protection ?? {}));
                log.record('updated delete protection');
            }

            return {
                changed: log.changed,
                changes: log.changes,
                ...(blocked ? { blocked } : {}),
            };
        },

        project(remote) {
            return {
                ready: true,
                phase: 'Ready',
                message: `The network ${remote.ip_range} is available`,
                status: {
                    ipRange: remote.ip_range,
                    subnets: (remote.subnets ?? []).map((subnet) => ({
                        type: subnet.type,
                        ...(subnet.ip_range ? { ipRange: subnet.ip_range } : {}),
                        networkZone: subnet.network_zone,
                        ...(subnet.gateway ? { gateway: subnet.gateway } : {}),
                    })),
                    routes: (remote.routes ?? []).map((route) => ({
                        destination: route.destination,
                        gateway: route.gateway,
                    })),
                    serverIds: remote.servers ?? [],
                    loadBalancerIds: remote.load_balancers ?? [],
                },
            };
        },
    };
}

function toSubnetPayload(subnet: SubnetSpec): NetworkSubnet {
    return {
        type: subnet.type,
        ip_range: subnet.ipRange,
        network_zone: subnet.networkZone,
        ...(subnet.vSwitchId !== undefined ? { vswitch_id: subnet.vSwitchId } : {}),
    };
}

function toRoutePayload(route: RouteSpec): NetworkRoute {
    return { destination: route.destination, gateway: route.gateway };
}

/** Good enough to catch typos; the Hetzner API is the real authority. */
export function isCidr(value: string | undefined): boolean {
    if (!value) {
        return false;
    }
    const [address, prefix] = value.split('/');
    if (!address || !prefix || !/^\d+$/.test(prefix)) {
        return false;
    }
    const bits = Number(prefix);
    if (address.includes(':')) {
        return bits >= 0 && bits <= 128;
    }
    const octets = address.split('.');
    return (
        bits >= 0 &&
        bits <= 32 &&
        octets.length === 4 &&
        octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    );
}
