/**
 * HetznerPlacementGroup — the "spread" hint that keeps servers off the same
 * physical host.
 *
 * Membership is declared on the server (`spec.placementGroupRef`), not here, so
 * this adapter owns only the group itself and reports who ended up in it.
 */

import { noChange, type ResourceAdapter } from '../framework/types.js';
import type { PlacementGroupApi } from '../hcloud/resources/placement-groups.js';
import type { PlacementGroup } from '../hcloud/types.js';
import type { CommonSpec, CommonStatus, ResourceDescriptor } from '../kube/api.js';

/** Hetzner supports exactly one strategy today. */
export const PLACEMENT_GROUP_TYPES = ['spread'] as const;
export type PlacementGroupType = (typeof PLACEMENT_GROUP_TYPES)[number];

export interface HetznerPlacementGroupSpec extends CommonSpec {
    /** Placement strategy. Immutable. */
    type?: PlacementGroupType;
}

export interface HetznerPlacementGroupStatus extends CommonStatus {
    type?: string;
    /** Hetzner ids of the servers currently in the group. */
    serverIds?: number[];
    serverCount?: number;
}

export const placementGroupDescriptor: ResourceDescriptor = {
    kind: 'HetznerPlacementGroup',
    plural: 'hetznerplacementgroups',
    shortName: 'hpg',
};

export function createPlacementGroupAdapter(
    api: PlacementGroupApi,
): ResourceAdapter<HetznerPlacementGroupSpec, HetznerPlacementGroupStatus, PlacementGroup> {
    return {
        descriptor: placementGroupDescriptor,
        api,
        syncName: true,

        validate(spec) {
            const type = spec.type ?? 'spread';
            return PLACEMENT_GROUP_TYPES.includes(type)
                ? []
                : [`spec.type must be one of ${PLACEMENT_GROUP_TYPES.join(', ')}, got "${type}"`];
        },

        create(context) {
            return api.create({
                name: context.hetznerName,
                type: context.spec.type ?? 'spread',
                labels: context.labels,
            });
        },

        update: async () => noChange,

        project(remote) {
            const serverIds = remote.servers ?? [];
            return {
                ready: true,
                phase: 'Ready',
                message:
                    serverIds.length === 0
                        ? 'The placement group exists and holds no servers yet'
                        : `The placement group holds ${serverIds.length} server(s)`,
                status: {
                    type: remote.type,
                    serverIds,
                    serverCount: serverIds.length,
                },
            };
        },

        drift(context, remote) {
            const desired = context.spec.type ?? 'spread';
            if (remote.type && remote.type !== desired) {
                return (
                    `spec.type is "${desired}" but the placement group is "${remote.type}". ` +
                    'The type is immutable; delete and recreate this HetznerPlacementGroup to change it.'
                );
            }
            return undefined;
        },
    };
}
