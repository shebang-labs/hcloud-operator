/**
 * The `HetznerServer` adapter.
 *
 * This file is deliberately thin: it decides *what order* to converge things
 * in and how to describe the result, while the individual operations live in
 * `lifecycle.ts` and `attachments.ts`.
 *
 * The ordering matters and is the one piece of real judgement here:
 *
 *   1. resize and rebuild first — both may power the server off, and running
 *      anything else against a server that is about to stop wastes API calls;
 *   2. power state next, so a resize that finished can start the server again;
 *   3. everything cheap and non-disruptive last.
 *
 * If a disruptive step acted, the pass stops there and asks to be called again.
 * Hetzner locks a server for the duration of an action, so continuing would
 * only collect `locked` errors.
 */

import type { ResourceAdapter, UpdateOutcome } from '../../framework/types.js';
import { HetznerApiError } from '../../hcloud/errors.js';
import type { ServerApi } from '../../hcloud/resources/servers.js';
import type { Server } from '../../hcloud/types.js';
import type { Phase } from '../../kube/api.js';
import { ChangeLog } from '../common.js';
import {
    convergeDnsPtr,
    convergeNetworks,
    convergePlacementGroup,
    convergeProtection,
} from './attachments.js';
import {
    convergeBackups,
    convergeImage,
    convergeIso,
    convergePowerState,
    convergeRescue,
    convergeServerType,
    describeImage,
    desiredPowerState,
    type StepResult,
} from './lifecycle.js';
import {
    type HetznerServerSpec,
    type HetznerServerStatus,
    serverDescriptor,
    TRANSITIONAL_STATES,
} from './spec.js';

/** How long to wait while Hetzner is working on the server. */
const REQUEUE_WHILE_TRANSITIONING_MS = 10_000;
/** How long to wait when the server exists but is not running. */
const REQUEUE_WHILE_NOT_RUNNING_MS = 60_000;

export function createServerAdapter(
    api: ServerApi,
): ResourceAdapter<HetznerServerSpec, HetznerServerStatus, Server> {
    return {
        descriptor: serverDescriptor,
        api,
        syncName: true,

        validate(spec) {
            const problems: string[] = [];
            if (!spec.serverType) {
                problems.push('spec.serverType is required, e.g. "cpx21"');
            }
            if (!spec.image) {
                problems.push('spec.image is required, e.g. "ubuntu-24.04"');
            }
            if (!spec.location && !spec.datacenter) {
                problems.push('one of spec.location or spec.datacenter is required');
            }
            if (spec.location && spec.datacenter) {
                problems.push(
                    'spec.location and spec.datacenter are mutually exclusive; a datacenter already implies its location',
                );
            }
            if (spec.powerState && spec.powerState !== 'Running' && spec.powerState !== 'Stopped') {
                problems.push(
                    `spec.powerState must be "Running" or "Stopped", got "${spec.powerState}"`,
                );
            }
            if (
                spec.gracefulShutdownTimeoutSeconds !== undefined &&
                spec.gracefulShutdownTimeoutSeconds < 0
            ) {
                problems.push('spec.gracefulShutdownTimeoutSeconds must not be negative');
            }
            if (spec.publicNet?.enableIPv4 === false && spec.publicNet?.enableIPv6 === false) {
                if (!spec.networks?.length) {
                    problems.push(
                        'spec.publicNet disables both IPv4 and IPv6, but spec.networks is empty: ' +
                            'the server would have no address at all and be unreachable',
                    );
                }
            }
            return problems;
        },

        async create(context) {
            const { spec } = context;
            const sshKeyIds = await context.refs.resolveAll(
                'HetznerSSHKey',
                spec.sshKeyRefs,
                context.namespace,
            );
            const networkIds = await context.refs.resolveAll(
                'HetznerNetwork',
                (spec.networks ?? []).map((entry) => entry.networkRef),
                context.namespace,
            );
            const placementGroupId = spec.placementGroupRef
                ? await context.refs.resolve(
                      'HetznerPlacementGroup',
                      spec.placementGroupRef,
                      context.namespace,
                  )
                : undefined;

            return api.create({
                name: context.hetznerName,
                serverType: spec.serverType,
                image: spec.image,
                ...(spec.datacenter
                    ? { datacenter: spec.datacenter }
                    : { location: spec.location }),
                sshKeyIds,
                networkIds,
                ...(placementGroupId !== undefined ? { placementGroupId } : {}),
                ...(spec.userData ? { userData: spec.userData } : {}),
                // Create the server in the state the spec asks for rather than
                // starting it and immediately stopping it again.
                startAfterCreate: desiredPowerState(spec) === 'Running',
                ...(spec.publicNet
                    ? {
                          publicNet: {
                              ...(spec.publicNet.enableIPv4 !== undefined
                                  ? { enableIpv4: spec.publicNet.enableIPv4 }
                                  : {}),
                              ...(spec.publicNet.enableIPv6 !== undefined
                                  ? { enableIpv6: spec.publicNet.enableIPv6 }
                                  : {}),
                          },
                      }
                    : {}),
                labels: context.labels,
            });
        },

        async update(context, remote): Promise<UpdateOutcome> {
            const log = new ChangeLog();

            // Hetzner holds a lock for the duration of an action. Trying to
            // start another one only produces `locked` errors, so wait it out.
            if (remote.locked) {
                context.logger.debug('The server is locked by another action; waiting');
                return { changed: false, requeueAfterMs: REQUEUE_WHILE_TRANSITIONING_MS };
            }

            const blockers: string[] = [];
            const statusPatch: Record<string, unknown> = {};
            let requeueAfterMs: number | undefined;

            /** Runs one step and folds its result into the pass. */
            const apply = (result: StepResult): boolean => {
                if (result.blocked) {
                    blockers.push(result.blocked);
                }
                if (result.statusPatch) {
                    Object.assign(statusPatch, result.statusPatch);
                }
                if (result.requeueAfterMs !== undefined) {
                    requeueAfterMs = Math.min(
                        requeueAfterMs ?? Number.POSITIVE_INFINITY,
                        result.requeueAfterMs,
                    );
                }
                return result.acted ?? false;
            };

            // Disruptive steps first, and only one of them per pass.
            const resized = apply(await convergeServerType(api, context, remote, log));
            if (!resized) {
                const rebuilt = apply(await convergeImage(api, context, remote, log));
                if (!rebuilt) {
                    apply(await convergePowerState(api, context, remote, log));
                }
            }

            // The cheap, non-disruptive steps run every pass. They are safe even
            // while a power transition is in flight.
            apply(await convergeBackups(api, context, remote, log));
            apply(await convergeRescue(api, context, remote, log));
            apply(await convergeIso(api, context, remote, log));
            apply(await convergeNetworks(api, context, remote, log));
            apply(await convergePlacementGroup(api, context, remote, log));
            apply(await convergeDnsPtr(api, context, remote, log));
            apply(await convergeProtection(api, context, remote, log));

            return {
                changed: log.changed,
                changes: log.changes,
                ...(blockers.length ? { blocked: blockers.join(' ') } : {}),
                ...(requeueAfterMs !== undefined ? { requeueAfterMs } : {}),
                ...(Object.keys(statusPatch).length ? { statusPatch } : {}),
            };
        },

        /**
         * Delete protection produces a bare `protected` error that says nothing
         * about how to fix it. Replace it with an instruction.
         */
        async delete(_context, remote) {
            try {
                await api.delete(remote.id);
            } catch (error) {
                if (error instanceof HetznerApiError && error.isProtected) {
                    throw new HetznerApiError({
                        status: error.status,
                        code: error.code,
                        message:
                            `Server ${remote.id} has delete protection enabled. Set ` +
                            'spec.protection.delete: false and apply, then delete this HetznerServer.',
                        retryable: false,
                    });
                }
                throw error;
            }
        },

        project(remote, spec) {
            const { phase, ready, message } = describeServerState(remote);
            // A server that is off is only a problem when the spec asked for it
            // to be on. When `powerState: Stopped` is what was requested, the object
            // has reached its desired state and must stop asking to be looked at
            // again — otherwise a deliberately stopped server re-reconciles
            // every minute, forever, for no reason.
            const atDesiredPowerState =
                (desiredPowerState(spec) === 'Stopped') === (remote.status === 'off');
            const privateIps = (remote.private_net ?? [])
                .map((entry) => entry.ip)
                .filter((ip): ip is string => Boolean(ip));

            return {
                ready,
                phase,
                message,
                status: {
                    serverStatus: remote.status,
                    ...(remote.server_type?.name ? { serverType: remote.server_type.name } : {}),
                    image: describeImage(remote),
                    ...(remote.datacenter?.location?.name
                        ? { location: remote.datacenter.location.name }
                        : {}),
                    ...(remote.datacenter?.name ? { datacenter: remote.datacenter.name } : {}),
                    ...(remote.public_net?.ipv4?.ip ? { ipv4: remote.public_net.ipv4.ip } : {}),
                    ...(remote.public_net?.ipv6?.ip ? { ipv6: remote.public_net.ipv6.ip } : {}),
                    privateIps,
                    networkIds: (remote.private_net ?? []).map((entry) => entry.network),
                    volumeIds: remote.volumes ?? [],
                    ...(remote.placement_group?.id !== undefined
                        ? { placementGroupId: remote.placement_group.id }
                        : {}),
                    rescueEnabled: remote.rescue_enabled ?? false,
                    backupsEnabled: Boolean(remote.backup_window),
                    ...(remote.iso?.name ? { iso: remote.iso.name } : {}),
                    locked: remote.locked ?? false,
                },
                ...(TRANSITIONAL_STATES.has(remote.status)
                    ? { requeueAfterMs: REQUEUE_WHILE_TRANSITIONING_MS }
                    : ready || atDesiredPowerState
                      ? {}
                      : { requeueAfterMs: REQUEUE_WHILE_NOT_RUNNING_MS }),
            };
        },

        drift(context, remote) {
            const differences: string[] = [];
            const actualLocation = remote.datacenter?.location?.name;
            const actualDatacenter = remote.datacenter?.name;

            if (
                context.spec.location &&
                actualLocation &&
                context.spec.location !== actualLocation
            ) {
                differences.push(
                    `location: spec=${context.spec.location} actual=${actualLocation}`,
                );
            }
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
                `Immutable fields differ from the running server (${differences.join(', ')}). ` +
                'A server cannot move between locations; delete and recreate this HetznerServer ' +
                'to apply the change.'
            );
        },
    };
}

/**
 * Maps a Hetzner server state to a phase, readiness and a human message.
 *
 * Pure, exported, and exhaustively tested: this is what users actually read in
 * `kubectl get hsrv`, so it is worth getting the wording right.
 */
export function describeServerState(server: Server): {
    phase: Phase;
    ready: boolean;
    message: string;
} {
    switch (server.status) {
        case 'running':
            return { phase: 'Ready', ready: true, message: 'The server is running' };
        case 'initializing':
        case 'starting':
            return { phase: 'Creating', ready: false, message: `The server is ${server.status}` };
        case 'migrating':
        case 'rebuilding':
            return { phase: 'Updating', ready: false, message: `The server is ${server.status}` };
        case 'stopping':
            return { phase: 'Updating', ready: false, message: 'The server is shutting down' };
        case 'off':
            // Not an error: `spec.powerState: Stopped` is a legitimate desired state.
            // The Synced condition, not Ready, reports whether that was asked for.
            return { phase: 'Ready', ready: false, message: 'The server is powered off' };
        case 'deleting':
            return { phase: 'Deleting', ready: false, message: 'The server is being deleted' };
        default:
            return {
                phase: 'Error',
                ready: false,
                message: `The server is ${server.status || 'in an unknown state'}`,
            };
    }
}
