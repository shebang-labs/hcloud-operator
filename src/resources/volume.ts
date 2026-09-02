/**
 * HetznerVolume — block storage.
 *
 * The kind where a careless controller destroys data, so the conservative
 * choices are explicit:
 *
 *   - shrinking is refused before the API is ever called;
 *   - growing needs no guard (it is online and non-destructive) but is never
 *     reversible, so it is logged as a change;
 *   - moving a volume between servers detaches it, which the guest OS notices,
 *     so it needs `spec.allowDetach`.
 */

import type { ResourceRef } from '../framework/references.js';
import type { ResourceAdapter, UpdateOutcome } from '../framework/types.js';
import type { VolumeApi } from '../hcloud/resources/volumes.js';
import type { Volume } from '../hcloud/types.js';
import type { CommonSpec, CommonStatus, ResourceDescriptor } from '../kube/api.js';
import {
    ChangeLog,
    type ProtectionSpec,
    protectionMatches,
    toProtectionPayload,
} from './common.js';

/** Hetzner's smallest volume. */
export const MIN_VOLUME_SIZE_GB = 10;

export interface HetznerVolumeSpec extends CommonSpec {
    /** Size in GB. May grow, never shrink. */
    size: number;
    /** Where to create the volume, e.g. "nbg1". Immutable. */
    location?: string;
    /** Filesystem Hetzner should create: "ext4" or "xfs". Immutable. */
    format?: string;
    /** The server to attach the volume to. Omit to leave it detached. */
    serverRef?: ResourceRef;
    /** Ask Hetzner to mount the volume on attach. Only honoured on first attach. */
    automount?: boolean;
    protection?: ProtectionSpec;
    /**
     * Moving the volume to a different server, or detaching it, interrupts the
     * workload using it. Required for any change that detaches.
     */
    allowDetach?: boolean;
}

export interface HetznerVolumeStatus extends CommonStatus {
    size?: number;
    location?: string;
    format?: string;
    /** Device path inside the guest, e.g. "/dev/disk/by-id/scsi-0HC_Volume_4711". */
    linuxDevice?: string;
    /** Hetzner id of the server the volume is attached to. */
    attachedToServerId?: number;
    attached?: boolean;
}

export const volumeDescriptor: ResourceDescriptor = {
    kind: 'HetznerVolume',
    plural: 'hetznervolumes',
    shortName: 'hvol',
};

export function createVolumeAdapter(
    api: VolumeApi,
): ResourceAdapter<HetznerVolumeSpec, HetznerVolumeStatus, Volume> {
    return {
        descriptor: volumeDescriptor,
        api,
        syncName: true,

        validate(spec) {
            const problems: string[] = [];
            if (!Number.isInteger(spec.size) || spec.size < MIN_VOLUME_SIZE_GB) {
                problems.push(
                    `spec.size must be a whole number of GB and at least ${MIN_VOLUME_SIZE_GB}, got ${spec.size}`,
                );
            }
            if (spec.format && !['ext4', 'xfs'].includes(spec.format)) {
                problems.push(`spec.format must be "ext4" or "xfs", got "${spec.format}"`);
            }
            if (!spec.location && !spec.serverRef) {
                problems.push('one of spec.location or spec.serverRef is required');
            }
            return problems;
        },

        async create(context) {
            const { spec } = context;
            const serverId = spec.serverRef
                ? await context.refs.resolve('HetznerServer', spec.serverRef, context.namespace)
                : undefined;

            return api.create({
                name: context.hetznerName,
                size: spec.size,
                ...(serverId !== undefined ? { serverId } : { location: spec.location }),
                ...(spec.format ? { format: spec.format } : {}),
                ...(spec.automount !== undefined ? { automount: spec.automount } : {}),
                labels: context.labels,
            });
        },

        async update(context, remote): Promise<UpdateOutcome> {
            const { spec } = context;
            const log = new ChangeLog();
            const blockers: string[] = [];

            if (spec.size > remote.size) {
                await api.resize(remote.id, spec.size, remote.size);
                log.record(`grew from ${remote.size}GB to ${spec.size}GB`);
            } else if (spec.size < remote.size) {
                blockers.push(
                    `spec.size is ${spec.size}GB but the volume is ${remote.size}GB. ` +
                        'Hetzner volumes cannot shrink; create a new volume and migrate the data.',
                );
            }

            const desiredServerId = spec.serverRef
                ? await context.refs.resolve('HetznerServer', spec.serverRef, context.namespace)
                : undefined;
            const attachedTo = remote.server ?? undefined;

            if (desiredServerId !== attachedTo) {
                const needsDetach = attachedTo !== undefined;
                if (needsDetach && !spec.allowDetach) {
                    blockers.push(
                        `the volume is attached to server ${attachedTo} but the spec asks for ` +
                            `${desiredServerId ?? 'no server'}. Detaching interrupts the workload using it, ` +
                            'so set spec.allowDetach: true to apply this.',
                    );
                } else {
                    if (needsDetach) {
                        await api.detach(remote.id);
                        log.record(`detached from server ${attachedTo}`);
                    }
                    if (desiredServerId !== undefined) {
                        await api.attach(remote.id, desiredServerId, spec.automount);
                        log.record(`attached to server ${desiredServerId}`);
                    }
                }
            }

            if (!protectionMatches(remote.protection, spec.protection)) {
                await api.changeProtection(remote.id, toProtectionPayload(spec.protection ?? {}));
                log.record('updated delete protection');
            }

            return {
                changed: log.changed,
                changes: log.changes,
                ...(blockers.length ? { blocked: blockers.join(' ') } : {}),
            };
        },

        /**
         * A volume that is still attached cannot be deleted, and Hetzner returns
         * a bare `conflict` for it. Detaching first turns a confusing retry loop
         * into an ordinary delete.
         */
        async delete(context, remote) {
            if (remote.server) {
                context.logger.info('Detaching the volume before deleting it', {
                    serverId: remote.server,
                });
                await api.detach(remote.id);
            }
            await api.delete(remote.id);
        },

        project(remote) {
            const available = remote.status === 'available';
            const attachedTo = remote.server ?? undefined;
            return {
                ready: available,
                phase: available ? 'Ready' : 'Creating',
                message: available
                    ? attachedTo
                        ? `The ${remote.size}GB volume is attached to server ${attachedTo}`
                        : `The ${remote.size}GB volume is available and not attached`
                    : `Hetzner is still provisioning the volume (status: ${remote.status})`,
                status: {
                    size: remote.size,
                    ...(remote.location?.name ? { location: remote.location.name } : {}),
                    ...(remote.format ? { format: remote.format } : {}),
                    ...(remote.linux_device ? { linuxDevice: remote.linux_device } : {}),
                    ...(attachedTo !== undefined ? { attachedToServerId: attachedTo } : {}),
                    attached: attachedTo !== undefined,
                },
                ...(available ? {} : { requeueAfterMs: 5_000 }),
            };
        },

        drift(context, remote) {
            const differences: string[] = [];
            const actualLocation = remote.location?.name;
            if (
                context.spec.location &&
                actualLocation &&
                context.spec.location !== actualLocation
            ) {
                differences.push(
                    `location: spec=${context.spec.location} actual=${actualLocation}`,
                );
            }
            if (context.spec.format && remote.format && context.spec.format !== remote.format) {
                differences.push(`format: spec=${context.spec.format} actual=${remote.format}`);
            }
            if (differences.length === 0) {
                return undefined;
            }
            return (
                `Immutable fields differ from the volume (${differences.join(', ')}). ` +
                'Delete and recreate this HetznerVolume to apply the change — the data will not survive it.'
            );
        },
    };
}
