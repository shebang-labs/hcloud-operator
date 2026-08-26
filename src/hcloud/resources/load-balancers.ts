/**
 * Hetzner load balancers.
 *
 * The most action-heavy resource in the API: services and targets each have
 * their own add/update/delete calls, and the object itself accepts almost no
 * direct updates. Everything below is a thin wrapper — deciding *which* calls
 * to make from a desired service/target list is the adapter's job.
 */

import type {
    LoadBalancer,
    LoadBalancerService,
    LoadBalancerTarget,
    Protection,
} from '../types.js';
import {
    type BaseResourceApi,
    createBaseResourceApi,
    type ResourceClientDependencies,
} from './base.js';

export interface CreateLoadBalancerInput {
    name: string;
    loadBalancerType: string;
    algorithm?: string;
    /** Either a concrete location or a network zone. */
    location?: string;
    networkZone?: string;
    services?: LoadBalancerService[];
    targets?: LoadBalancerTarget[];
    publicInterface?: boolean;
    networkId?: number;
    labels?: Record<string, string>;
}

export interface LoadBalancerApi extends BaseResourceApi<LoadBalancer> {
    create(input: CreateLoadBalancerInput): Promise<LoadBalancer>;
    addService(id: number, service: LoadBalancerService): Promise<void>;
    updateService(id: number, service: LoadBalancerService): Promise<void>;
    deleteService(id: number, listenPort: number): Promise<void>;
    addTarget(id: number, target: LoadBalancerTarget): Promise<void>;
    removeTarget(id: number, target: LoadBalancerTarget): Promise<void>;
    changeAlgorithm(id: number, algorithm: string): Promise<void>;
    changeType(id: number, loadBalancerType: string): Promise<void>;
    attachToNetwork(id: number, networkId: number, ip?: string): Promise<void>;
    detachFromNetwork(id: number, networkId: number): Promise<void>;
    setPublicInterface(id: number, enabled: boolean): Promise<void>;
    changeDnsPtr(id: number, ip: string, dnsPtr: string | null): Promise<void>;
    changeProtection(id: number, protection: Protection): Promise<void>;
}

export function createLoadBalancerApi(dependencies: ResourceClientDependencies): LoadBalancerApi {
    const base = createBaseResourceApi<LoadBalancer>(dependencies, {
        plural: 'load_balancers',
        singular: 'load_balancer',
        scope: 'load_balancers',
    });

    return {
        ...base,

        async create(input) {
            const { resource, actions } = await base.createRaw({
                name: input.name,
                load_balancer_type: input.loadBalancerType,
                ...(input.algorithm ? { algorithm: { type: input.algorithm } } : {}),
                ...(input.location
                    ? { location: input.location }
                    : input.networkZone
                      ? { network_zone: input.networkZone }
                      : {}),
                ...(input.services?.length ? { services: input.services } : {}),
                ...(input.targets?.length ? { targets: input.targets } : {}),
                ...(input.publicInterface !== undefined
                    ? { public_interface: input.publicInterface }
                    : {}),
                ...(input.networkId !== undefined ? { network: input.networkId } : {}),
                ...(input.labels ? { labels: input.labels } : {}),
            });
            await base.awaitActions(actions);
            return resource;
        },

        async addService(id, service) {
            await base.runAction(id, 'add_service', service);
        },

        async updateService(id, service) {
            await base.runAction(id, 'update_service', service);
        },

        async deleteService(id, listenPort) {
            await base.runAction(id, 'delete_service', { listen_port: listenPort });
        },

        async addTarget(id, target) {
            await base.runAction(id, 'add_target', target);
        },

        async removeTarget(id, target) {
            // remove_target only accepts the identity of the target, not its
            // health status, so send just the discriminator and its key.
            await base.runAction(id, 'remove_target', {
                type: target.type,
                ...(target.server ? { server: target.server } : {}),
                ...(target.label_selector ? { label_selector: target.label_selector } : {}),
                ...(target.ip ? { ip: target.ip } : {}),
            });
        },

        async changeAlgorithm(id, algorithm) {
            await base.runAction(id, 'change_algorithm', { type: algorithm });
        },

        async changeType(id, loadBalancerType) {
            await base.runAction(id, 'change_type', { load_balancer_type: loadBalancerType });
        },

        async attachToNetwork(id, networkId, ip) {
            await base.runAction(id, 'attach_to_network', {
                network: networkId,
                ...(ip ? { ip } : {}),
            });
        },

        async detachFromNetwork(id, networkId) {
            await base.runAction(id, 'detach_from_network', { network: networkId });
        },

        async setPublicInterface(id, enabled) {
            await base.runAction(
                id,
                enabled ? 'enable_public_interface' : 'disable_public_interface',
            );
        },

        async changeDnsPtr(id, ip, dnsPtr) {
            await base.runAction(id, 'change_dns_ptr', { ip, dns_ptr: dnsPtr });
        },

        async changeProtection(id, protection) {
            await base.runAction(id, 'change_protection', {
                ...(protection.delete !== undefined ? { delete: protection.delete } : {}),
            });
        },
    };
}
