/**
 * Hetzner Cloud servers — every operation the API offers, wrapped one to one.
 *
 * Two safety properties are enforced here rather than left to callers:
 *
 *   1. The create response contains a generated `root_password` when no SSH key
 *      was given. It is dropped immediately and never returned, so it cannot be
 *      logged or written into a Kubernetes status by accident.
 *   2. Every asynchronous operation is awaited to a terminal action state, so
 *      "the call returned" and "the server changed" mean the same thing to the
 *      layer above.
 */

import type { Image, Protection, Server } from '../types.js';
import {
    type BaseResourceApi,
    createBaseResourceApi,
    type ResourceClientDependencies,
} from './base.js';

export interface CreateServerInput {
    name: string;
    serverType: string;
    image: string;
    /** Either a location or a datacenter, never both. */
    location?: string;
    datacenter?: string;
    sshKeyIds?: number[];
    volumeIds?: number[];
    firewallIds?: number[];
    networkIds?: number[];
    placementGroupId?: number;
    userData?: string;
    startAfterCreate?: boolean;
    automount?: boolean;
    publicNet?: {
        enableIpv4?: boolean;
        enableIpv6?: boolean;
        ipv4Id?: number;
        ipv6Id?: number;
    };
    labels?: Record<string, string>;
}

export interface RebuildResult {
    server: Server;
}

export interface ServerApi extends BaseResourceApi<Server> {
    create(input: CreateServerInput): Promise<Server>;

    /* Power management. */
    powerOn(id: number): Promise<void>;
    /** ACPI shutdown: asks the guest OS to stop cleanly. */
    shutdown(id: number): Promise<void>;
    /** Cuts the power. Data loss is possible; only used as a fallback. */
    powerOff(id: number): Promise<void>;
    reboot(id: number): Promise<void>;
    reset(id: number): Promise<void>;

    /* Lifecycle changes. */
    changeType(id: number, serverType: string, upgradeDisk: boolean): Promise<void>;
    rebuild(id: number, image: string): Promise<void>;

    /* Backups, snapshots and rescue. */
    enableBackup(id: number): Promise<void>;
    disableBackup(id: number): Promise<void>;
    createImage(
        id: number,
        options: {
            description?: string;
            type?: 'snapshot' | 'backup';
            labels?: Record<string, string>;
        },
    ): Promise<Image>;
    enableRescue(id: number, options: { type?: string; sshKeyIds?: number[] }): Promise<void>;
    disableRescue(id: number): Promise<void>;

    /* Attachments. */
    attachIso(id: number, iso: string): Promise<void>;
    detachIso(id: number): Promise<void>;
    attachToNetwork(id: number, networkId: number, ip?: string, aliasIps?: string[]): Promise<void>;
    detachFromNetwork(id: number, networkId: number): Promise<void>;
    changeAliasIps(id: number, networkId: number, aliasIps: string[]): Promise<void>;
    addToPlacementGroup(id: number, placementGroupId: number): Promise<void>;
    removeFromPlacementGroup(id: number): Promise<void>;

    /* Miscellaneous. */
    changeDnsPtr(id: number, ip: string, dnsPtr: string | null): Promise<void>;
    changeProtection(id: number, protection: Protection): Promise<void>;
    /** Metrics series for a server. Read-only; surfaced for debugging. */
    metrics(id: number, type: string, start: string, end: string): Promise<unknown>;
}

export function createServerApi(dependencies: ResourceClientDependencies): ServerApi {
    const base = createBaseResourceApi<Server>(dependencies, {
        plural: 'servers',
        singular: 'server',
        scope: 'servers',
    });

    return {
        ...base,

        async create(input) {
            const { resource, actions } = await base.createRaw({
                name: input.name,
                server_type: input.serverType,
                image: input.image,
                ...(input.datacenter
                    ? { datacenter: input.datacenter }
                    : input.location
                      ? { location: input.location }
                      : {}),
                start_after_create: input.startAfterCreate ?? true,
                ...(input.sshKeyIds?.length ? { ssh_keys: input.sshKeyIds } : {}),
                ...(input.volumeIds?.length ? { volumes: input.volumeIds } : {}),
                ...(input.firewallIds?.length
                    ? { firewalls: input.firewallIds.map((id) => ({ firewall: id })) }
                    : {}),
                ...(input.networkIds?.length ? { networks: input.networkIds } : {}),
                ...(input.placementGroupId !== undefined
                    ? { placement_group: input.placementGroupId }
                    : {}),
                ...(input.userData ? { user_data: input.userData } : {}),
                ...(input.automount !== undefined ? { automount: input.automount } : {}),
                ...(input.publicNet
                    ? {
                          public_net: {
                              ...(input.publicNet.enableIpv4 !== undefined
                                  ? { enable_ipv4: input.publicNet.enableIpv4 }
                                  : {}),
                              ...(input.publicNet.enableIpv6 !== undefined
                                  ? { enable_ipv6: input.publicNet.enableIpv6 }
                                  : {}),
                              ...(input.publicNet.ipv4Id !== undefined
                                  ? { ipv4: input.publicNet.ipv4Id }
                                  : {}),
                              ...(input.publicNet.ipv6Id !== undefined
                                  ? { ipv6: input.publicNet.ipv6Id }
                                  : {}),
                          },
                      }
                    : {}),
                ...(input.labels ? { labels: input.labels } : {}),
            });

            // `next_actions` covers start_after_create and any attachments. Wait
            // for all of them so the caller sees a settled server.
            await base.awaitActions(actions);
            return resource;
        },

        powerOn: (id) => base.runAction(id, 'poweron'),
        shutdown: (id) => base.runAction(id, 'shutdown'),
        powerOff: (id) => base.runAction(id, 'poweroff'),
        reboot: (id) => base.runAction(id, 'reboot'),
        reset: (id) => base.runAction(id, 'reset'),

        changeType: (id, serverType, upgradeDisk) =>
            base.runAction(id, 'change_type', {
                server_type: serverType,
                // Growing the disk makes the change irreversible: Hetzner cannot
                // downgrade a server whose disk was enlarged.
                upgrade_disk: upgradeDisk,
            }),

        rebuild: (id, image) => base.runAction(id, 'rebuild', { image }),

        enableBackup: (id) => base.runAction(id, 'enable_backup'),
        disableBackup: (id) => base.runAction(id, 'disable_backup'),

        async createImage(id, options) {
            const response = await base.http.post<{
                image: Image;
                action?: { id: number; command: string; status: 'running' | 'success' | 'error' };
            }>(`/servers/${id}/actions/create_image`, {
                ...(options.description ? { description: options.description } : {}),
                type: options.type ?? 'snapshot',
                ...(options.labels ? { labels: options.labels } : {}),
            });
            await base.awaitAction(response.action);
            return response.image;
        },

        enableRescue: (id, options) =>
            base.runAction(id, 'enable_rescue', {
                type: options.type ?? 'linux64',
                ...(options.sshKeyIds?.length ? { ssh_keys: options.sshKeyIds } : {}),
            }),
        disableRescue: (id) => base.runAction(id, 'disable_rescue'),

        attachIso: (id, iso) => base.runAction(id, 'attach_iso', { iso }),
        detachIso: (id) => base.runAction(id, 'detach_iso'),

        attachToNetwork: (id, networkId, ip, aliasIps) =>
            base.runAction(id, 'attach_to_network', {
                network: networkId,
                ...(ip ? { ip } : {}),
                ...(aliasIps?.length ? { alias_ips: aliasIps } : {}),
            }),
        detachFromNetwork: (id, networkId) =>
            base.runAction(id, 'detach_from_network', { network: networkId }),
        changeAliasIps: (id, networkId, aliasIps) =>
            base.runAction(id, 'change_alias_ips', { network: networkId, alias_ips: aliasIps }),

        addToPlacementGroup: (id, placementGroupId) =>
            base.runAction(id, 'add_to_placement_group', { placement_group: placementGroupId }),
        removeFromPlacementGroup: (id) => base.runAction(id, 'remove_from_placement_group'),

        changeDnsPtr: (id, ip, dnsPtr) =>
            base.runAction(id, 'change_dns_ptr', { ip, dns_ptr: dnsPtr }),

        changeProtection: (id, protection) =>
            base.runAction(id, 'change_protection', {
                ...(protection.delete !== undefined ? { delete: protection.delete } : {}),
                ...(protection.rebuild !== undefined ? { rebuild: protection.rebuild } : {}),
            }),

        metrics: (id, type, start, end) =>
            base.http.get(`/servers/${id}/metrics`, { params: { type, start, end } }),
    };
}
