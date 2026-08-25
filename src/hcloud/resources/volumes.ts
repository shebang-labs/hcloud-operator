/**
 * Hetzner block storage volumes.
 *
 * Volumes are the resource where a careless controller destroys data, so two
 * rules are baked in here:
 *
 *   - resize is grow-only (Hetzner refuses to shrink, and so do we, earlier and
 *     with a better message);
 *   - detaching is never implied by anything; the adapter must ask for it.
 */

import type { Protection, Volume } from '../types.js';
import {
    type BaseResourceApi,
    createBaseResourceApi,
    type ResourceClientDependencies,
} from './base.js';

export interface CreateVolumeInput {
    name: string;
    /** Size in GB. Hetzner's minimum is 10. */
    size: number;
    /** Either a location, or a server to create the volume next to. */
    location?: string;
    serverId?: number;
    /** Filesystem to put on the volume. Omit to leave it raw. */
    format?: string;
    /** Only meaningful together with `serverId`. */
    automount?: boolean;
    labels?: Record<string, string>;
}

export interface VolumeApi extends BaseResourceApi<Volume> {
    create(input: CreateVolumeInput): Promise<Volume>;
    attach(id: number, serverId: number, automount?: boolean): Promise<void>;
    detach(id: number): Promise<void>;
    /** Grow-only. Throws before touching the API if asked to shrink. */
    resize(id: number, size: number, currentSize: number): Promise<void>;
    changeProtection(id: number, protection: Protection): Promise<void>;
}

export function createVolumeApi(dependencies: ResourceClientDependencies): VolumeApi {
    const base = createBaseResourceApi<Volume>(dependencies, {
        plural: 'volumes',
        singular: 'volume',
        scope: 'volumes',
    });

    return {
        ...base,

        async create(input) {
            const { resource, actions } = await base.createRaw({
                name: input.name,
                size: input.size,
                ...(input.serverId !== undefined
                    ? { server: input.serverId }
                    : { location: input.location }),
                ...(input.format ? { format: input.format } : {}),
                ...(input.automount !== undefined ? { automount: input.automount } : {}),
                ...(input.labels ? { labels: input.labels } : {}),
            });
            await base.awaitActions(actions);
            return resource;
        },

        async attach(id, serverId, automount) {
            await base.runAction(id, 'attach', {
                server: serverId,
                ...(automount !== undefined ? { automount } : {}),
            });
        },

        async detach(id) {
            await base.runAction(id, 'detach');
        },

        async resize(id, size, currentSize) {
            if (size < currentSize) {
                throw new Error(
                    `Hetzner volumes cannot shrink: volume ${id} is ${currentSize}GB, spec asks for ${size}GB. ` +
                        'Create a new volume and migrate the data instead.',
                );
            }
            if (size === currentSize) {
                return;
            }
            await base.runAction(id, 'resize', { size });
        },

        async changeProtection(id, protection) {
            await base.runAction(id, 'change_protection', {
                ...(protection.delete !== undefined ? { delete: protection.delete } : {}),
            });
        },
    };
}
