/**
 * HetznerPrimaryIP — the address a server is born with.
 *
 * Unlike a floating IP it is bound to a datacenter, and Hetzner only lets it be
 * reassigned while both servers are powered off. That constraint is surfaced as
 * a blocked change with an explanation rather than as a retry loop that never
 * succeeds.
 */

import type { ResourceRef } from '../framework/references.js';
import type { ResourceAdapter, UpdateOutcome } from '../framework/types.js';
import type { PrimaryIpApi } from '../hcloud/resources/primary-ips.js';
import type { PrimaryIp } from '../hcloud/types.js';
import type { CommonSpec, CommonStatus, ResourceDescriptor } from '../kube/api.js';
import {
    ChangeLog,
    type DnsPtrSpec,
    dnsPtrChanges,
    type ProtectionSpec,
    protectionMatches,
    toProtectionPayload,
} from './common.js';

export interface HetznerPrimaryIPSpec extends CommonSpec {
    /** "ipv4" or "ipv6". Immutable. */
    type: 'ipv4' | 'ipv6';
    /** Datacenter the IP lives in, e.g. "nbg1-dc3". Immutable. */
    datacenter?: string;
    /** The server the IP is assigned to. */
    serverRef?: ResourceRef;
    /** Let Hetzner delete the IP when its server goes away. */
    autoDelete?: boolean;
    dnsPtr?: DnsPtrSpec[];
    protection?: ProtectionSpec;
}

export interface HetznerPrimaryIPStatus extends CommonStatus {
    ip?: string;
    type?: string;
    datacenter?: string;
    assignedToServerId?: number;
    assigned?: boolean;
    autoDelete?: boolean;
}

export const primaryIpDescriptor: ResourceDescriptor = {
    kind: 'HetznerPrimaryIP',
    plural: 'hetznerprimaryips',
    shortName: 'hpip',
};

export function createPrimaryIpAdapter(
    api: PrimaryIpApi,
): ResourceAdapter<HetznerPrimaryIPSpec, HetznerPrimaryIPStatus, PrimaryIp> {
    return {
        descriptor: primaryIpDescriptor,
        api,
        syncName: true,

        validate(spec) {
            const problems: string[] = [];
            if (spec.type !== 'ipv4' && spec.type !== 'ipv6') {
                problems.push(`spec.type must be "ipv4" or "ipv6", got "${spec.type}"`);
            }
            if (!spec.datacenter && !spec.serverRef) {
                problems.push('one of spec.datacenter or spec.serverRef is required');
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
                ...(serverId !== undefined
                    ? { assigneeId: serverId, assigneeType: 'server' }
                    : { datacenter: spec.datacenter }),
                ...(spec.autoDelete !== undefined ? { autoDelete: spec.autoDelete } : {}),
                labels: context.labels,
            });
        },

        async update(context, remote): Promise<UpdateOutcome> {
            const { spec } = context;
            const log = new ChangeLog();
            let blocked: string | undefined;

            const desiredServerId = spec.serverRef
                ? await context.refs.resolve('HetznerServer', spec.serverRef, context.namespace)
                : undefined;
            const assignedTo = remote.assignee_id ?? undefined;

            if (desiredServerId !== assignedTo) {
                if (desiredServerId === undefined) {
                    await api.unassign(remote.id);
                    log.record(`unassigned from server ${assignedTo}`);
                } else if (assignedTo !== undefined) {
                    // Hetzner requires both servers to be off, which the operator
                    // will not do on its own: powering a server down to move an IP
                    // is a decision for a human.
                    blocked =
                        `spec.serverRef points at server ${desiredServerId} but the primary IP is ` +
                        `assigned to server ${assignedTo}. Hetzner only reassigns a primary IP while ` +
                        'both servers are powered off; stop them (spec.powerState: Stopped) and the ' +
                        'operator will complete the move.';
                } else {
                    await api.assign(remote.id, desiredServerId);
                    log.record(`assigned to server ${desiredServerId}`);
                }
            }

            for (const entry of dnsPtrChanges(remote.dns_ptr, spec.dnsPtr)) {
                await api.changeDnsPtr(remote.id, entry.ip, entry.dnsPtr);
                log.record(`set reverse DNS for ${entry.ip} to ${entry.dnsPtr ?? '(cleared)'}`);
            }

            if (
                spec.autoDelete !== undefined &&
                spec.autoDelete !== (remote.auto_delete ?? false)
            ) {
                await api.setAutoDelete(remote.id, spec.autoDelete);
                log.record(`set autoDelete to ${spec.autoDelete}`);
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

        async delete(context, remote) {
            if (remote.assignee_id) {
                context.logger.info('Unassigning the primary IP before deleting it', {
                    serverId: remote.assignee_id,
                });
                await api.unassign(remote.id);
            }
            await api.delete(remote.id);
        },

        project(remote) {
            const assignedTo = remote.assignee_id ?? undefined;
            return {
                ready: true,
                phase: 'Ready',
                message: assignedTo
                    ? `${remote.ip} is assigned to server ${assignedTo}`
                    : `${remote.ip} exists and is not assigned to a server`,
                status: {
                    ip: remote.ip,
                    type: remote.type,
                    ...(remote.datacenter?.name ? { datacenter: remote.datacenter.name } : {}),
                    ...(assignedTo !== undefined ? { assignedToServerId: assignedTo } : {}),
                    assigned: assignedTo !== undefined,
                    autoDelete: remote.auto_delete ?? false,
                },
            };
        },

        drift(context, remote) {
            const differences: string[] = [];
            if (remote.type && context.spec.type !== remote.type) {
                differences.push(`type: spec=${context.spec.type} actual=${remote.type}`);
            }
            const actualDatacenter = remote.datacenter?.name;
            if (
                context.spec.datacenter &&
                actualDatacenter &&
                context.spec.datacenter !== actualDatacenter
            ) {
                differences.push(
                    `datacenter: spec=${context.spec.datacenter} actual=${actualDatacenter}`,
                );
            }
            if (differences.length === 0) {
                return undefined;
            }
            return (
                `Immutable fields differ from the primary IP (${differences.join(', ')}). ` +
                'Delete and recreate this HetznerPrimaryIP to apply the change — the address will change with it.'
            );
        },
    };
}
