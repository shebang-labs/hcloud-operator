/**
 * HetznerStorageBox — a Storage Box: file storage reached over SSH/SFTP/rsync,
 * Samba or WebDAV, billed by its type rather than by use.
 *
 * Two API constraints shape this adapter:
 *
 *   - Create requires a password. The operator generates a random one and
 *     never keeps it. Access is by SSH key; Hetzner's reset_password action is
 *     the way back to password login if it is ever wanted.
 *   - SSH keys are installed once, at create. The API does not return them
 *     and has no call that changes them, so `spec.sshKeyRefs` is create-only
 *     and a later edit to it does nothing.
 */

import { randomInt } from 'node:crypto';
import type { ResourceRef } from '../framework/references.js';
import type { ResourceAdapter, UpdateOutcome } from '../framework/types.js';
import type { SshKeyApi } from '../hcloud/resources/ssh-keys.js';
import type { StorageBoxApi } from '../hcloud/resources/storage-boxes.js';
import type { StorageBox, StorageBoxAccessSettings } from '../hcloud/types.js';
import type { CommonSpec, CommonStatus, ResourceDescriptor } from '../kube/api.js';
import {
    ChangeLog,
    type ProtectionSpec,
    protectionMatches,
    toProtectionPayload,
} from './common.js';

export interface StorageBoxAccessSettingsSpec {
    /** Allow access from outside Hetzner's network. */
    reachableExternally?: boolean;
    sambaEnabled?: boolean;
    sshEnabled?: boolean;
    webdavEnabled?: boolean;
    /** Show the ZFS snapshot folder. */
    zfsEnabled?: boolean;
}

export interface HetznerStorageBoxSpec extends CommonSpec {
    /** e.g. "bx11". Can be changed; Hetzner refuses a type too small for the data. */
    storageBoxType: string;
    /** e.g. "fsn1". Immutable. */
    location: string;
    /** HetznerSSHKey references whose public keys are installed at create. Create-only. */
    sshKeyRefs?: ResourceRef[];
    /** Fields left out keep whatever the Storage Box has. */
    accessSettings?: StorageBoxAccessSettingsSpec;
    /** Only `delete` applies to Storage Boxes. */
    protection?: Pick<ProtectionSpec, 'delete'>;
}

export interface HetznerStorageBoxStatus extends CommonStatus {
    storageBoxType?: string;
    location?: string;
    /** Login name, e.g. "u12345". */
    username?: string;
    /** Host to connect to, e.g. "u12345.your-storagebox.de". SSH listens on port 23. */
    server?: string;
    /** Bytes in use, snapshots included. */
    usedBytes?: number;
}

export const storageBoxDescriptor: ResourceDescriptor = {
    kind: 'HetznerStorageBox',
    plural: 'hetznerstorageboxes',
    shortName: 'hsb',
};

const ACCESS_FIELDS: Array<[keyof StorageBoxAccessSettingsSpec, keyof StorageBoxAccessSettings]> = [
    ['reachableExternally', 'reachable_externally'],
    ['sambaEnabled', 'samba_enabled'],
    ['sshEnabled', 'ssh_enabled'],
    ['webdavEnabled', 'webdav_enabled'],
    ['zfsEnabled', 'zfs_enabled'],
];

/** The spec's access settings in the API's shape, set fields only. */
function toAccessPayload(spec: StorageBoxAccessSettingsSpec | undefined): StorageBoxAccessSettings {
    const payload: StorageBoxAccessSettings = {};
    for (const [field, key] of ACCESS_FIELDS) {
        const value = spec?.[field];
        if (value !== undefined) {
            payload[key] = value;
        }
    }
    return payload;
}

export function createStorageBoxAdapter(
    api: StorageBoxApi,
    sshKeys: SshKeyApi,
): ResourceAdapter<HetznerStorageBoxSpec, HetznerStorageBoxStatus, StorageBox> {
    return {
        descriptor: storageBoxDescriptor,
        api,
        syncName: true,

        validate(spec) {
            const problems: string[] = [];
            if (!spec.storageBoxType?.trim()) {
                problems.push('spec.storageBoxType is required, e.g. "bx11"');
            }
            if (!spec.location?.trim()) {
                problems.push('spec.location is required, e.g. "fsn1"');
            }
            return problems;
        },

        async create(context) {
            const { spec } = context;
            const keyIds = await context.refs.resolveAll(
                'HetznerSSHKey',
                spec.sshKeyRefs,
                context.namespace,
            );
            const publicKeys: string[] = [];
            for (const id of keyIds) {
                const key = await sshKeys.get(id);
                if (!key?.public_key) {
                    throw new Error(`HetznerSSHKey ${id} has no public key in Hetzner`);
                }
                publicKeys.push(key.public_key);
            }
            const accessSettings = toAccessPayload(spec.accessSettings);

            return api.create({
                name: context.hetznerName,
                storageBoxType: spec.storageBoxType,
                location: spec.location,
                password: generatePassword(),
                ...(publicKeys.length ? { sshKeys: publicKeys } : {}),
                ...(Object.keys(accessSettings).length ? { accessSettings } : {}),
                labels: context.labels,
            });
        },

        async update(context, remote): Promise<UpdateOutcome> {
            const { spec } = context;
            const log = new ChangeLog();

            const actualType = remote.storage_box_type?.name;
            if (actualType && actualType !== spec.storageBoxType) {
                await api.changeType(remote.id, spec.storageBoxType);
                log.record(`changed type from ${actualType} to ${spec.storageBoxType}`);
            }

            const desired = toAccessPayload(spec.accessSettings);
            const differs = Object.entries(desired).some(
                ([key, value]) =>
                    (remote.access_settings?.[key as keyof StorageBoxAccessSettings] ?? false) !==
                    value,
            );
            if (differs) {
                await api.updateAccessSettings(remote.id, desired);
                log.record('updated access settings');
            }

            if (!protectionMatches(remote.protection, spec.protection)) {
                await api.changeProtection(remote.id, toProtectionPayload(spec.protection ?? {}));
                log.record('updated delete protection');
            }

            return { changed: log.changed, changes: log.changes };
        },

        project(remote) {
            const active = remote.status === 'active';
            return {
                ready: active,
                phase: active ? 'Ready' : 'Creating',
                message: active
                    ? `The Storage Box is active${remote.server ? ` at ${remote.server}` : ''}`
                    : `Hetzner has not finished with the Storage Box (status: ${remote.status})`,
                status: {
                    ...(remote.storage_box_type?.name
                        ? { storageBoxType: remote.storage_box_type.name }
                        : {}),
                    ...(remote.location?.name ? { location: remote.location.name } : {}),
                    ...(remote.username ? { username: remote.username } : {}),
                    ...(remote.server ? { server: remote.server } : {}),
                    ...(remote.stats?.size !== undefined ? { usedBytes: remote.stats.size } : {}),
                },
                ...(active ? {} : { requeueAfterMs: 10_000 }),
            };
        },

        drift(context, remote) {
            const actual = remote.location?.name;
            if (!actual || actual === context.spec.location) {
                return undefined;
            }
            return (
                `Immutable field differs from the Storage Box (location: spec=${context.spec.location} ` +
                `actual=${actual}). Delete and recreate this HetznerStorageBox to move it — the data ` +
                'will not survive it.'
            );
        },
    };
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const SPECIAL = '-_.!#%+';

/**
 * 48 random characters with at least one of each class Hetzner's password
 * policy demands. Never stored: it only satisfies the create call.
 */
export function generatePassword(length = 48): string {
    const pick = (alphabet: string) => alphabet.charAt(randomInt(alphabet.length));
    const all = LOWER + UPPER + DIGITS + SPECIAL;
    const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SPECIAL)];
    while (chars.length < length) {
        chars.push(pick(all));
    }
    // Fisher-Yates, so the guaranteed classes are not always in front.
    for (let index = chars.length - 1; index > 0; index -= 1) {
        const other = randomInt(index + 1);
        [chars[index], chars[other]] = [chars[other] as string, chars[index] as string];
    }
    return chars.join('');
}
