/**
 * Hetzner placement groups: the "spread" hint that keeps servers off the same
 * physical host. Membership is controlled from the *server* side, so this
 * module only owns the group itself.
 */

import type { PlacementGroup } from '../types.js';
import {
    type BaseResourceApi,
    createBaseResourceApi,
    type ResourceClientDependencies,
} from './base.js';

export interface CreatePlacementGroupInput {
    name: string;
    /** Hetzner only supports "spread" today. */
    type: string;
    labels?: Record<string, string>;
}

export interface PlacementGroupApi extends BaseResourceApi<PlacementGroup> {
    create(input: CreatePlacementGroupInput): Promise<PlacementGroup>;
}

export function createPlacementGroupApi(
    dependencies: ResourceClientDependencies,
): PlacementGroupApi {
    const base = createBaseResourceApi<PlacementGroup>(dependencies, {
        plural: 'placement_groups',
        singular: 'placement_group',
        scope: 'placement_groups',
    });

    return {
        ...base,

        async create(input) {
            const { resource, actions } = await base.createRaw({
                name: input.name,
                type: input.type,
                ...(input.labels ? { labels: input.labels } : {}),
            });
            await base.awaitActions(actions);
            return resource;
        },
    };
}
