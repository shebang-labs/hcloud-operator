/**
 * HetznerSSHKey — an SSH public key in the Hetzner project.
 *
 * The simplest adapter in the codebase, and a good place to see the shape of
 * one: a spec, a status, and the five methods the engine calls. Everything else
 * — finalizers, adoption, conditions, retries — is the framework's job.
 */

import { noChange, type ResourceAdapter } from '../framework/types.js';
import type { SshKeyApi } from '../hcloud/resources/ssh-keys.js';
import type { SshKey } from '../hcloud/types.js';
import type { CommonSpec, CommonStatus, ResourceDescriptor } from '../kube/api.js';

export interface HetznerSSHKeySpec extends CommonSpec {
    /** The public key in OpenSSH format. Immutable in Hetzner. */
    publicKey: string;
}

export interface HetznerSSHKeyStatus extends CommonStatus {
    /** MD5 fingerprint Hetzner computed for the key. */
    fingerprint?: string;
}

export const sshKeyDescriptor: ResourceDescriptor = {
    kind: 'HetznerSSHKey',
    plural: 'hetznersshkeys',
    shortName: 'hkey',
};

export function createSshKeyAdapter(
    api: SshKeyApi,
): ResourceAdapter<HetznerSSHKeySpec, HetznerSSHKeyStatus, SshKey> {
    return {
        descriptor: sshKeyDescriptor,
        api,
        syncName: true,

        validate(spec) {
            const problems: string[] = [];
            const key = spec.publicKey?.trim();
            if (!key) {
                problems.push('spec.publicKey is required');
            } else if (!/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-\S+)\s+\S+/.test(key)) {
                problems.push(
                    'spec.publicKey does not look like an OpenSSH public key ' +
                        '(expected e.g. "ssh-ed25519 AAAA... comment")',
                );
            }
            return problems;
        },

        create(context) {
            return api.create({
                name: context.hetznerName,
                publicKey: context.spec.publicKey.trim(),
                labels: context.labels,
            });
        },

        // Nothing beyond name and labels is mutable, and the engine syncs both.
        update: async () => noChange,

        project(remote) {
            return {
                ready: true,
                phase: 'Ready',
                message: 'The SSH key is registered in the Hetzner project',
                status: {
                    ...(remote.fingerprint ? { fingerprint: remote.fingerprint } : {}),
                },
            };
        },

        drift(context, remote) {
            // Hetzner stores the key normalised (no trailing comment changes),
            // so compare only the algorithm and the key material.
            const desired = keyMaterial(context.spec.publicKey);
            const actual = keyMaterial(remote.public_key ?? '');
            if (!actual || !desired || actual === desired) {
                return undefined;
            }
            return (
                'spec.publicKey differs from the registered key. Hetzner SSH keys are immutable; ' +
                'delete and recreate this HetznerSSHKey to publish a different key.'
            );
        },
    };
}

/** "ssh-ed25519 AAAA... user@host" -> "ssh-ed25519 AAAA...". */
function keyMaterial(publicKey: string): string {
    const [algorithm, material] = publicKey.trim().split(/\s+/);
    return algorithm && material ? `${algorithm} ${material}` : '';
}
