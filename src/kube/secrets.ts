/**
 * Reading Kubernetes Secrets.
 *
 * Only one kind needs this: an uploaded certificate's private key. Putting a
 * private key directly in a custom resource would mean it is readable by anyone
 * with `get` on that CRD and visible in `kubectl get -o yaml`, so the spec
 * references a Secret instead and the operator reads it here.
 *
 * The value is passed straight to the Hetzner API and never logged, never
 * stored in status, and never read back.
 */

import type { CoreV1Api } from '@kubernetes/client-node';
import { isNotFoundError } from './store.js';

export interface SecretKeyRef {
    name: string;
    key: string;
    /** Defaults to the referring object's namespace. */
    namespace?: string;
}

export interface SecretReader {
    /** Returns the decoded value, or null when the Secret or key is missing. */
    read(namespace: string, ref: SecretKeyRef): Promise<string | null>;
}

export function createSecretReader(api: CoreV1Api): SecretReader {
    return {
        async read(namespace, ref) {
            try {
                const secret = await api.readNamespacedSecret({
                    name: ref.name,
                    namespace: ref.namespace ?? namespace,
                });
                const encoded = secret.data?.[ref.key];
                if (encoded === undefined) {
                    // `stringData` is write-only and never comes back, so a miss
                    // here really does mean the key is absent.
                    return null;
                }
                return Buffer.from(encoded, 'base64').toString('utf8');
            } catch (error) {
                if (isNotFoundError(error)) {
                    return null;
                }
                throw error;
            }
        },
    };
}
