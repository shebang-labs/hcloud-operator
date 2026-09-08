/**
 * The parts of a server that are relationships to other resources: private
 * networks, placement group membership, reverse DNS and protection.
 *
 * Kept apart from `lifecycle.ts` because they have a different character —
 * these converge a *set* (which networks am I in?) rather than a state machine
 * (am I on or off?), and none of them ever reboots the server.
 */

import type { ServerApi } from '../../hcloud/resources/servers.js';
import type { Server } from '../../hcloud/types.js';
import type { ChangeLog } from '../common.js';
import { dnsPtrChanges, protectionMatches, sameSet, toProtectionPayload } from '../common.js';
import type { ServerContext, StepResult } from './lifecycle.js';

/**
 * Private networks.
 *
 * Attach anything missing, detach anything no longer declared, and fix alias
 * IPs in place. Detaching is done last so a server is never briefly cut off
 * from every network it has.
 *
 * A primary IP that differs from `spec.networks[].ip` is the one change Hetzner
 * cannot make in place: the server has to leave the network and rejoin with the
 * new address. That drops its private connectivity for the duration, which is
 * downtime for anything reaching it over that network — so it sits behind the
 * same `allowDowntime` guard as a resize rather than behind a new flag.
 */
export async function convergeNetworks(
    api: ServerApi,
    context: ServerContext,
    remote: Server,
    log: ChangeLog,
): Promise<StepResult> {
    const declared = context.spec.networks;
    if (declared === undefined) {
        // The field is absent: leave whatever attachments exist alone. An empty
        // array, by contrast, explicitly means "no networks".
        return {};
    }

    const desired = new Map<number, { ip?: string; aliasIps: string[] }>();
    for (const entry of declared) {
        const id = await context.refs.resolve(
            'HetznerNetwork',
            entry.networkRef,
            context.namespace,
        );
        desired.set(id, {
            ...(entry.ip ? { ip: entry.ip } : {}),
            aliasIps: entry.aliasIps ?? [],
        });
    }

    const attached = new Map(
        (remote.private_net ?? []).map((entry) => [entry.network, entry] as const),
    );

    const blockers: string[] = [];

    for (const [networkId, wanted] of desired) {
        const existing = attached.get(networkId);
        if (!existing) {
            await api.attachToNetwork(remote.id, networkId, wanted.ip, wanted.aliasIps);
            log.record(`attached to network ${networkId}`);
            continue;
        }
        if (wanted.ip && existing.ip !== wanted.ip) {
            if (!context.spec.allowDowntime) {
                blockers.push(
                    `spec.networks asks for IP ${wanted.ip} in network ${networkId} but the server ` +
                        `has ${existing.ip ?? 'none'}. Changing it detaches and re-attaches the server, ` +
                        'interrupting its private connectivity, so set spec.allowDowntime: true to apply it.',
                );
                continue;
            }
            await api.detachFromNetwork(remote.id, networkId);
            await api.attachToNetwork(remote.id, networkId, wanted.ip, wanted.aliasIps);
            log.record(
                `re-attached to network ${networkId} with IP ${wanted.ip} (was ${existing.ip ?? 'none'})`,
            );
            // Re-attaching set the alias IPs too.
            continue;
        }
        if (!sameSet(existing.alias_ips ?? [], wanted.aliasIps)) {
            await api.changeAliasIps(remote.id, networkId, wanted.aliasIps);
            log.record(`updated alias IPs on network ${networkId}`);
        }
    }

    for (const networkId of attached.keys()) {
        if (!desired.has(networkId)) {
            await api.detachFromNetwork(remote.id, networkId);
            log.record(`detached from network ${networkId}`);
        }
    }

    return {
        acted: log.changed,
        ...(blockers.length ? { blocked: blockers.join(' ') } : {}),
    };
}

/** Placement group membership. Hetzner requires the server to be powered off. */
export async function convergePlacementGroup(
    api: ServerApi,
    context: ServerContext,
    remote: Server,
    log: ChangeLog,
): Promise<StepResult> {
    const ref = context.spec.placementGroupRef;
    const actual = remote.placement_group?.id;

    const desired = ref
        ? await context.refs.resolve('HetznerPlacementGroup', ref, context.namespace)
        : undefined;

    if (desired === actual) {
        return {};
    }

    if (remote.status !== 'off') {
        return {
            blocked:
                `spec.placementGroupRef asks for placement group ${desired ?? 'none'} but the server ` +
                `is in ${actual ?? 'none'}. Hetzner only changes placement group membership while the ` +
                'server is powered off; set spec.powerState: Stopped and the operator will complete the move.',
        };
    }

    if (desired === undefined) {
        await api.removeFromPlacementGroup(remote.id);
        log.record(`removed from placement group ${actual}`);
    } else {
        await api.addToPlacementGroup(remote.id, desired);
        log.record(`added to placement group ${desired}`);
    }
    return { acted: true };
}

/** Reverse DNS for the server's public addresses. */
export async function convergeDnsPtr(
    api: ServerApi,
    context: ServerContext,
    remote: Server,
    log: ChangeLog,
): Promise<StepResult> {
    const declared = context.spec.dnsPtr;
    if (!declared?.length) {
        return {};
    }

    // Hetzner keeps IPv4 reverse DNS as a single string on the address and IPv6
    // as a list; flatten both into one comparable shape.
    const current: Array<{ ip: string; dns_ptr: string | null }> = [];
    const ipv4 = remote.public_net?.ipv4;
    if (ipv4?.ip) {
        current.push({ ip: ipv4.ip, dns_ptr: ipv4.dns_ptr ?? null });
    }
    for (const entry of remote.public_net?.ipv6?.dns_ptr ?? []) {
        current.push({ ip: entry.ip, dns_ptr: entry.dns_ptr });
    }

    for (const change of dnsPtrChanges(current, declared)) {
        await api.changeDnsPtr(remote.id, change.ip, change.dnsPtr);
        log.record(`set reverse DNS for ${change.ip} to ${change.dnsPtr ?? '(cleared)'}`);
    }

    return { acted: log.changed };
}

/** Delete and rebuild protection. */
export async function convergeProtection(
    api: ServerApi,
    context: ServerContext,
    remote: Server,
    log: ChangeLog,
): Promise<StepResult> {
    if (protectionMatches(remote.protection, context.spec.protection)) {
        return {};
    }
    await api.changeProtection(remote.id, toProtectionPayload(context.spec.protection ?? {}));
    log.record('updated delete/rebuild protection');
    return { acted: true };
}
