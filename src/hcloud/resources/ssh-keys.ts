/**
 * Hetzner SSH keys. The simplest resource in the API: no actions, fully
 * synchronous, and everything except the public key is mutable.
 */

import type { SshKey } from '../types.js';
import {
    type BaseResourceApi,
    createBaseResourceApi,
    type ResourceClientDependencies,
} from './base.js';

export interface CreateSshKeyInput {
    name: string;
    publicKey: string;
    labels?: Record<string, string>;
}

export interface SshKeyApi extends BaseResourceApi<SshKey> {
    create(input: CreateSshKeyInput): Promise<SshKey>;
    /** Looks a key up by its fingerprint, which is how Hetzner de-duplicates. */
    getByFingerprint(fingerprint: string): Promise<SshKey | null>;
}

export function createSshKeyApi(dependencies: ResourceClientDependencies): SshKeyApi {
    const base = createBaseResourceApi<SshKey>(dependencies, {
        plural: 'ssh_keys',
        singular: 'ssh_key',
    });

    return {
        ...base,

        async create(input) {
            const { resource } = await base.createRaw({
                name: input.name,
                public_key: input.publicKey,
                ...(input.labels ? { labels: input.labels } : {}),
            });
            return resource;
        },

        async getByFingerprint(fingerprint) {
            const matches = await base.list({ fingerprint });
            return matches.find((key) => key.fingerprint === fingerprint) ?? null;
        },
    };
}
