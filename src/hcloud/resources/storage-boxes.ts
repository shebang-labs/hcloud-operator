/**
 * Hetzner Storage Boxes.
 *
 * They live on api.hetzner.com rather than the Cloud API's host, but the
 * collection, action and label conventions are the same, so the shared base
 * works unchanged once it is handed a client for that host.
 *
 * Two things differ from every other resource here:
 *
 *   - create requires a password. Callers that only ever log in with SSH keys
 *     still have to send one;
 *   - the SSH keys are installed once, at create. There is no endpoint that
 *     changes them afterwards.
 */

import type { Protection, StorageBox, StorageBoxAccessSettings } from '../types.js';
import {
    type BaseResourceApi,
    createBaseResourceApi,
    type ResourceClientDependencies,
} from './base.js';

export interface CreateStorageBoxInput {
    name: string;
    /** e.g. "bx11". */
    storageBoxType: string;
    /** e.g. "fsn1". */
    location: string;
    password: string;
    /** Public keys in OpenSSH format. Only honoured at create. */
    sshKeys?: string[];
    accessSettings?: StorageBoxAccessSettings;
    labels?: Record<string, string>;
}

export interface StorageBoxApi extends BaseResourceApi<StorageBox> {
    create(input: CreateStorageBoxInput): Promise<StorageBox>;
    updateAccessSettings(id: number, settings: StorageBoxAccessSettings): Promise<void>;
    changeType(id: number, storageBoxType: string): Promise<void>;
    changeProtection(id: number, protection: Protection): Promise<void>;
}

export function createStorageBoxApi(dependencies: ResourceClientDependencies): StorageBoxApi {
    const base = createBaseResourceApi<StorageBox>(dependencies, {
        plural: 'storage_boxes',
        singular: 'storage_box',
        scope: 'storage_boxes',
    });

    return {
        ...base,

        async create(input) {
            const { resource, actions } = await base.createRaw({
                name: input.name,
                storage_box_type: input.storageBoxType,
                location: input.location,
                password: input.password,
                ...(input.sshKeys?.length ? { ssh_keys: input.sshKeys } : {}),
                ...(input.accessSettings ? { access_settings: input.accessSettings } : {}),
                ...(input.labels ? { labels: input.labels } : {}),
            });
            await base.awaitActions(actions);
            return resource;
        },

        async updateAccessSettings(id, settings) {
            await base.runAction(id, 'update_access_settings', settings);
        },

        async changeType(id, storageBoxType) {
            await base.runAction(id, 'change_type', { storage_box_type: storageBoxType });
        },

        async changeProtection(id, protection) {
            await base.runAction(id, 'change_protection', {
                ...(protection.delete !== undefined ? { delete: protection.delete } : {}),
            });
        },
    };
}
