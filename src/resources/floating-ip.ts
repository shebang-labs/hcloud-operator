/**
 * HetznerFloatingIP — an address that can be moved between servers, which is
 * what makes it useful for failover: point the IP at the standby and traffic
 * follows within seconds.
 *
 * Reassignment is non-destructive, so unlike a volume move it needs no guard.
 */

import type { ResourceRef } from '../framework/references.js';
import type { ResourceAdapter, UpdateOutcome } from '../framework/types.js';
import type { FloatingIpApi } from '../hcloud/resources/floating-ips.js';
import type { FloatingIp } from '../hcloud/types.js';
import type { CommonSpec, CommonStatus, ResourceDescriptor } from '../kube/api.js';
import {
    ChangeLog,
    type DnsPtrSpec,
    dnsPtrChanges,
    type ProtectionSpec,
    protectionMatches,
    toProtectionPayload,
} from './common.js';

export interface HetznerFloatingIPSpec extends CommonSpec {
    /** "ipv4" or "ipv6". Immutable. */
    type: 'ipv4' | 'ipv6';
    /** Where the IP is homed when unassigned, e.g. "nbg1". Immutable. */
    homeLocation?: string;
    description?: string;
    /** The server the IP points at. Omit to leave it unassigned. */
    serverRef?: ResourceRef;
    /** Reverse DNS entries to publish. */
    dnsPtr?: DnsPtrSpec[];
    protection?: ProtectionSpec;
}

export interface HetznerFloatingIPStatus extends CommonStatus {
    ip?: string;
    type?: string;
    homeLocation?: string;
    assignedToServerId?: number;
    assigned?: boolean;
    blocked?: boolean;
}

export const floatingIpDescriptor: ResourceDescriptor = {
    kind: 'HetznerFloatingIP',
    plural: 'hetznerfloatingips',
    shortName: 'hfip',
};

export function createFloatingIpAdapter(
    api: FloatingIpApi,
): ResourceAdapter<HetznerFloatingIPSpec, HetznerFloatingIPStatus, FloatingIp> {
    return {
        descriptor: floatingIpDescriptor,
        api,
        syncName: true,

        validate(spec) {
            const problems: string[] = [];
            if (spec.type !== 'ipv4' && spec.type !== 'ipv6') {
                problems.push(`spec.type must be "ipv4" or "ipv6", got "${spec.type}"`);
            }
            if (!spec.homeLocation && !spec.serverRef) {
                problems.push('one of spec.homeLocation or spec.serverRef is required');
            }
            return problems;
        },

        async create(context) {
            const { spec } = context;
            const serverId = spec.serverRef
                ? await context.refs.resolve('HetznerServer', spec.serverRef, context.namespace)
                : undefined;

            return api.create({
                type: spec.type,
                name: context.hetznerName,
                ...(spec.description ? { description: spec.description } : {}),
                ...(serverId !== undefined ? { serverId } : { homeLocation: spec.homeLocation }),
                labels: context.labels,
            });
        },

        async update(context, remote): Promise<UpdateOutcome> {
            const { spec } = context;
            const log = new ChangeLog();

            const desiredServerId = spec.serverRef
                ? await context.refs.resolve('HetznerServer', spec.serverRef, context.namespace)
                : undefined;
            const assignedTo = remote.server ?? undefined;

            if (desiredServerId !== assignedTo) {
                if (desiredServerId === undefined) {
                    await api.unassign(remote.id);
                    log.record(`unassigned from server ${assignedTo}`);
                } else {
                    // `assign` reassigns in place; no unassign step is needed and
                    // skipping it keeps the failover window as short as possible.
                    await api.assign(remote.id, desiredServerId);
                    log.record(`assigned to server ${desiredServerId}`);
                }
            }

            for (const entry of dnsPtrChanges(remote.dns_ptr, spec.dnsPtr)) {
                await api.changeDnsPtr(remote.id, entry.ip, entry.dnsPtr);
                log.record(`set reverse DNS for ${entry.ip} to ${entry.dnsPtr ?? '(cleared)'}`);
            }

            if (spec.description !== undefined && spec.description !== (remote.description ?? '')) {
                await api.updateDescription(remote.id, spec.description);
                log.record('updated the description');
            }

            if (!protectionMatches(remote.protection, spec.protection)) {
                await api.changeProtection(remote.id, toProtectionPayload(spec.protection ?? {}));
                log.record('updated delete protection');
            }

            return { changed: log.changed, changes: log.changes };
        },

        /** Hetzner refuses to delete an assigned floating IP. Unassign first. */
        async delete(context, remote) {
            if (remote.server) {
                context.logger.info('Unassigning the floating IP before deleting it', {
                    serverId: remote.server,
                });
                await api.unassign(remote.id);
            }
            await api.delete(remote.id);
        },

        project(remote) {
            const assignedTo = remote.server ?? undefined;
            return {
                // A floating IP is usable the moment it exists, whether or not it
                // currently points at a server.
                ready: true,
                phase: 'Ready',
                message: assignedTo
                    ? `${remote.ip} is assigned to server ${assignedTo}`
                    : `${remote.ip} exists and is not assigned to a server`,
                status: {
                    ip: remote.ip,
                    type: remote.type,
                    ...(remote.home_location?.name
                        ? { homeLocation: remote.home_location.name }
                        : {}),
                    ...(assignedTo !== undefined ? { assignedToServerId: assignedTo } : {}),
                    assigned: assignedTo !== undefined,
                    blocked: remote.blocked ?? false,
                },
            };
        },

        drift(context, remote) {
            const differences: string[] = [];
            if (remote.type && context.spec.type !== remote.type) {
                differences.push(`type: spec=${context.spec.type} actual=${remote.type}`);
            }
            const actualHome = remote.home_location?.name;
            if (
                context.spec.homeLocation &&
                actualHome &&
                context.spec.homeLocation !== actualHome
            ) {
                differences.push(
                    `homeLocation: spec=${context.spec.homeLocation} actual=${actualHome}`,
                );
            }
            if (differences.length === 0) {
                return undefined;
            }
            return (
                `Immutable fields differ from the floating IP (${differences.join(', ')}). ` +
                'Delete and recreate this HetznerFloatingIP to apply the change — the address will change with it.'
            );
        },
    };
}
