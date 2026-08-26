/**
 * Hetzner images.
 *
 * Images are the one resource the operator cannot create directly: snapshots
 * come into being through a server's `create_image` action, and system images
 * belong to Hetzner. So this module is read/update/delete plus protection, and
 * the `HetznerImage` CRD works by taking a snapshot of a referenced server.
 */

import type { Image, Protection } from '../types.js';
import {
    type BaseResourceApi,
    createBaseResourceApi,
    type ResourceClientDependencies,
} from './base.js';

export interface ImageApi extends BaseResourceApi<Image> {
    /** Renames/re-describes a snapshot. System images cannot be updated. */
    updateImage(
        id: number,
        changes: { description?: string; type?: string; labels?: Record<string, string> },
    ): Promise<Image>;
    changeProtection(id: number, protection: Protection): Promise<void>;
    /** Snapshots and backups owned by this project, never Hetzner's own images. */
    listOwn(): Promise<Image[]>;
}

export function createImageApi(dependencies: ResourceClientDependencies): ImageApi {
    const base = createBaseResourceApi<Image>(dependencies, {
        plural: 'images',
        singular: 'image',
        scope: 'images',
    });

    return {
        ...base,

        async updateImage(id, changes) {
            const response = await base.http.put<{ image: Image }>(`/images/${id}`, changes);
            return response.image;
        },

        async changeProtection(id, protection) {
            await base.runAction(id, 'change_protection', {
                ...(protection.delete !== undefined ? { delete: protection.delete } : {}),
            });
        },

        listOwn() {
            // Without this filter the list is dominated by Hetzner's own system
            // images, which we neither own nor may touch.
            return base.list({ type: 'snapshot' });
        },
    };
}
