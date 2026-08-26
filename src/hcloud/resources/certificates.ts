/**
 * Hetzner certificates, in both flavours:
 *
 *   - `uploaded` — you supply the PEM chain and private key.
 *   - `managed`  — Hetzner obtains and renews a Let's Encrypt certificate for
 *     a list of domains, which is asynchronous and can fail long after the
 *     create call returned (DNS not pointing at Hetzner yet, for instance).
 *
 * The private key is write-only: it goes out in the create call and is never
 * read back, logged, or stored in Kubernetes status.
 */

import type { Certificate } from '../types.js';
import {
    type BaseResourceApi,
    createBaseResourceApi,
    type ResourceClientDependencies,
} from './base.js';

export interface CreateUploadedCertificateInput {
    type: 'uploaded';
    name: string;
    /** PEM-encoded certificate chain. */
    certificate: string;
    /** PEM-encoded private key. Never logged, never read back. */
    privateKey: string;
    labels?: Record<string, string>;
}

export interface CreateManagedCertificateInput {
    type: 'managed';
    name: string;
    domainNames: string[];
    labels?: Record<string, string>;
}

export type CreateCertificateInput = CreateUploadedCertificateInput | CreateManagedCertificateInput;

export interface CertificateApi extends BaseResourceApi<Certificate> {
    create(input: CreateCertificateInput): Promise<Certificate>;
    /** Asks Hetzner to retry issuance of a managed certificate that failed. */
    retryIssuance(id: number): Promise<void>;
}

export function createCertificateApi(dependencies: ResourceClientDependencies): CertificateApi {
    const base = createBaseResourceApi<Certificate>(dependencies, {
        plural: 'certificates',
        singular: 'certificate',
        scope: 'certificates',
    });

    return {
        ...base,

        async create(input) {
            const body =
                input.type === 'uploaded'
                    ? {
                          type: 'uploaded',
                          name: input.name,
                          certificate: input.certificate,
                          private_key: input.privateKey,
                      }
                    : {
                          type: 'managed',
                          name: input.name,
                          domain_names: input.domainNames,
                      };

            const { resource } = await base.createRaw({
                ...body,
                ...(input.labels ? { labels: input.labels } : {}),
            });
            // Deliberately not awaiting the issuance action: a managed
            // certificate can take minutes and depends on external DNS. The
            // reconciler polls `status.issuance` instead, so a slow issuance
            // shows up as a Kubernetes condition rather than a blocked worker.
            return resource;
        },

        async retryIssuance(id) {
            await base.runAction(id, 'retry');
        },
    };
}
