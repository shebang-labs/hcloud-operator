/**
 * HetznerImage — a snapshot of a server's disk.
 *
 * The odd one out: an image cannot be created through the images endpoint at
 * all. It comes into being as a side effect of a server's `create_image`
 * action, so this adapter's `create` reaches into the servers API while
 * everything else (lookup, labels, adoption, delete, protection) goes through
 * the images endpoint like any other kind.
 *
 * A snapshot is a point in time, not a converging desired state: once taken it
 * never changes. Changing `spec.sourceServerRef` therefore reports drift rather
 * than silently replacing the image the load balancer or server is booting from.
 */

import type { ResourceRef } from '../framework/references.js';
import type { ResourceAdapter, UpdateOutcome } from '../framework/types.js';
import type { ImageApi } from '../hcloud/resources/images.js';
import type { ServerApi } from '../hcloud/resources/servers.js';
import type { Image } from '../hcloud/types.js';
import type { CommonSpec, CommonStatus, ResourceDescriptor } from '../kube/api.js';
import {
    ChangeLog,
    type ProtectionSpec,
    protectionMatches,
    toProtectionPayload,
} from './common.js';

export interface HetznerImageSpec extends CommonSpec {
    /** The server to snapshot. Immutable once the snapshot exists. */
    sourceServerRef: ResourceRef;
    /** Human description; this is what `hcloud image list` shows. */
    description?: string;
    protection?: ProtectionSpec;
}

export interface HetznerImageStatus extends CommonStatus {
    description?: string;
    type?: string;
    /** Billed size in GB, available once the snapshot has finished. */
    imageSize?: number;
    diskSize?: number;
    architecture?: string;
    osFlavor?: string;
    /** Hetzner id of the server the snapshot was taken from. */
    createdFromServerId?: number;
}

export const imageDescriptor: ResourceDescriptor = {
    kind: 'HetznerImage',
    plural: 'hetznerimages',
    shortName: 'himg',
};

/** How long to wait while Hetzner is still writing the snapshot. */
const REQUEUE_WHILE_CREATING_MS = 15_000;

export function createImageAdapter(
    api: ImageApi,
    servers: ServerApi,
): ResourceAdapter<HetznerImageSpec, HetznerImageStatus, Image> {
    return {
        descriptor: imageDescriptor,
        api,
        // Hetzner snapshots have a description, not a name; renaming is a no-op.
        syncName: false,

        validate(spec) {
            const ref = spec.sourceServerRef;
            // The CRD schema checks this too; this protects the paths that do
            // not go through kubectl (restores, other controllers).
            if (!ref || (!ref.name && !ref.hetznerName && ref.id === undefined)) {
                return ['spec.sourceServerRef must set one of "name", "hetznerName" or "id"'];
            }
            return [];
        },

        async create(context) {
            const serverId = await context.refs.resolve(
                'HetznerServer',
                context.spec.sourceServerRef,
                context.namespace,
            );

            context.logger.info('Taking a snapshot of the server', { serverId });
            return servers.createImage(serverId, {
                description: context.spec.description ?? context.hetznerName,
                type: 'snapshot',
                labels: context.labels,
            });
        },

        async update(context, remote): Promise<UpdateOutcome> {
            const { spec } = context;
            const log = new ChangeLog();

            const desiredDescription = spec.description ?? context.hetznerName;
            if (desiredDescription !== remote.description) {
                await api.updateImage(remote.id, { description: desiredDescription });
                log.record('updated the description');
            }

            if (!protectionMatches(remote.protection, spec.protection)) {
                await api.changeProtection(remote.id, toProtectionPayload(spec.protection ?? {}));
                log.record('updated delete protection');
            }

            return { changed: log.changed, changes: log.changes };
        },

        project(remote) {
            const available = remote.status === 'available';
            return {
                ready: available,
                phase: available ? 'Ready' : 'Creating',
                message: available
                    ? `The snapshot is available (${remote.image_size ?? '?'}GB)`
                    : `Hetzner is still creating the snapshot (status: ${remote.status})`,
                status: {
                    ...(remote.description ? { description: remote.description } : {}),
                    type: remote.type,
                    ...(remote.image_size !== null && remote.image_size !== undefined
                        ? { imageSize: remote.image_size }
                        : {}),
                    ...(remote.disk_size !== undefined ? { diskSize: remote.disk_size } : {}),
                    ...(remote.architecture ? { architecture: remote.architecture } : {}),
                    ...(remote.os_flavor ? { osFlavor: remote.os_flavor } : {}),
                    ...(remote.created_from?.id !== undefined
                        ? { createdFromServerId: remote.created_from.id }
                        : {}),
                },
                ...(available ? {} : { requeueAfterMs: REQUEUE_WHILE_CREATING_MS }),
            };
        },

        drift(context, remote) {
            const sourceId = remote.created_from?.id;
            const refId = context.spec.sourceServerRef.id;
            // Only comparable when the spec pins a raw id: resolving a name here
            // would mean an API call from a function that must stay pure.
            if (sourceId === undefined || refId === undefined || sourceId === refId) {
                return undefined;
            }
            return (
                `spec.sourceServerRef points at server ${refId} but this snapshot was taken from ` +
                `server ${sourceId}. A snapshot is a point in time and cannot be retaken in place; ` +
                'create a new HetznerImage instead.'
            );
        },
    };
}
