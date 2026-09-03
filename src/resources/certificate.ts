/**
 * HetznerCertificate — TLS certificates for load balancers, in both flavours.
 *
 *   - `uploaded`: the PEM chain and private key come from a Kubernetes Secret.
 *     The key is read at create time, handed to Hetzner, and never logged,
 *     stored in status, or read back. Putting it in the spec instead would make
 *     it visible to anyone with `get` on this CRD.
 *   - `managed`: Hetzner obtains and renews a Let's Encrypt certificate. That is
 *     asynchronous and depends on DNS pointing at Hetzner, so issuance can fail
 *     minutes after the create call succeeded — which is why issuance state is
 *     projected into conditions instead of being assumed.
 */

import type { ResourceAdapter, UpdateOutcome } from '../framework/types.js';
import type { CertificateApi } from '../hcloud/resources/certificates.js';
import type { Certificate } from '../hcloud/types.js';
import type { CommonSpec, CommonStatus, ResourceDescriptor } from '../kube/api.js';
import type { SecretKeyRef, SecretReader } from '../kube/secrets.js';
import { ChangeLog, sameSet } from './common.js';

export interface CertificateSecretRef {
    /** Name of a Secret in the same namespace, usually of type kubernetes.io/tls. */
    name: string;
    /** Key holding the PEM chain. Defaults to "tls.crt". */
    certificateKey?: string;
    /** Key holding the private key. Defaults to "tls.key". */
    privateKeyKey?: string;
}

export interface HetznerCertificateSpec extends CommonSpec {
    /** "uploaded" (default) or "managed". Immutable. */
    type?: 'uploaded' | 'managed';
    /** Required for `type: uploaded`. */
    secretRef?: CertificateSecretRef;
    /** Required for `type: managed`. Immutable. */
    domainNames?: string[];
}

export interface HetznerCertificateStatus extends CommonStatus {
    type?: string;
    domainNames?: string[];
    fingerprint?: string;
    notValidBefore?: string;
    notValidAfter?: string;
    /** For managed certificates: "pending", "completed" or "failed". */
    issuanceStatus?: string;
    renewalStatus?: string;
    /** Number of load balancers currently using this certificate. */
    usedByCount?: number;
}

export const certificateDescriptor: ResourceDescriptor = {
    kind: 'HetznerCertificate',
    plural: 'hetznercertificates',
    shortName: 'hcert',
};

/** How long to wait between checks while Let's Encrypt issuance is pending. */
const REQUEUE_WHILE_ISSUING_MS = 30_000;

export function createCertificateAdapter(
    api: CertificateApi,
    secrets: SecretReader,
): ResourceAdapter<HetznerCertificateSpec, HetznerCertificateStatus, Certificate> {
    return {
        descriptor: certificateDescriptor,
        api,
        syncName: true,

        validate(spec) {
            const type = spec.type ?? 'uploaded';
            const problems: string[] = [];
            if (type !== 'uploaded' && type !== 'managed') {
                problems.push(`spec.type must be "uploaded" or "managed", got "${type}"`);
                return problems;
            }
            if (type === 'uploaded' && !spec.secretRef?.name) {
                problems.push('spec.secretRef.name is required for an uploaded certificate');
            }
            if (type === 'managed' && !spec.domainNames?.length) {
                problems.push('spec.domainNames is required for a managed certificate');
            }
            return problems;
        },

        async create(context) {
            const { spec } = context;
            if ((spec.type ?? 'uploaded') === 'managed') {
                return api.create({
                    type: 'managed',
                    name: context.hetznerName,
                    domainNames: spec.domainNames ?? [],
                    labels: context.labels,
                });
            }

            const secretRef = spec.secretRef;
            if (!secretRef) {
                // Unreachable: validate() rejects this first. Kept so a future
                // refactor cannot silently skip the check.
                throw new Error('spec.secretRef is required for an uploaded certificate');
            }

            const [certificate, privateKey] = await Promise.all([
                readRequiredSecretValue(secrets, context.namespace, {
                    name: secretRef.name,
                    key: secretRef.certificateKey ?? 'tls.crt',
                }),
                readRequiredSecretValue(secrets, context.namespace, {
                    name: secretRef.name,
                    key: secretRef.privateKeyKey ?? 'tls.key',
                }),
            ]);

            return api.create({
                type: 'uploaded',
                name: context.hetznerName,
                certificate,
                privateKey,
                labels: context.labels,
            });
        },

        async update(context, remote): Promise<UpdateOutcome> {
            const log = new ChangeLog();

            // Hetzner cannot replace the material of an uploaded certificate;
            // rotating one means creating a new HetznerCertificate and pointing
            // the load balancer at it. Only managed certificates have anything
            // to converge here.
            //
            // The guard on the *previously recorded* status is what makes the
            // failure visible: retrying immediately would flip Hetzner's state
            // back to "pending" in the same pass, and the user would never see
            // why issuance failed. So the first pass reports it, and only a
            // later one retries.
            const alreadyReported = context.resource.status?.issuanceStatus === 'failed';
            if (remote.type === 'managed' && remote.status?.issuance === 'failed') {
                if (!alreadyReported) {
                    return {
                        changed: false,
                        blocked:
                            'Hetzner could not issue the certificate: ' +
                            `${remote.status.error?.message ?? 'no detail was given'}. ` +
                            'The operator will ask it to try again on the next reconcile.',
                    };
                }
                context.logger.warn('Retrying a failed managed certificate issuance');
                // At most one retry per reconcile, so the resync period bounds
                // the rate against Let's Encrypt.
                await api.retryIssuance(remote.id);
                log.record('asked Hetzner to retry issuance');
            }

            return { changed: log.changed, changes: log.changes };
        },

        project(remote) {
            const managed = remote.type === 'managed';
            const issuance = remote.status?.issuance;
            const ready = !managed || issuance === 'completed';

            const status: Partial<HetznerCertificateStatus> = {
                type: remote.type,
                domainNames: remote.domain_names ?? [],
                ...(remote.fingerprint ? { fingerprint: remote.fingerprint } : {}),
                ...(remote.not_valid_before ? { notValidBefore: remote.not_valid_before } : {}),
                ...(remote.not_valid_after ? { notValidAfter: remote.not_valid_after } : {}),
                ...(issuance ? { issuanceStatus: issuance } : {}),
                ...(remote.status?.renewal ? { renewalStatus: remote.status.renewal } : {}),
                usedByCount: (remote.used_by ?? []).length,
            };

            if (ready) {
                return {
                    ready: true,
                    phase: 'Ready',
                    message: remote.not_valid_after
                        ? `The certificate is valid until ${remote.not_valid_after}`
                        : 'The certificate is available',
                    status,
                };
            }

            if (issuance === 'failed') {
                return {
                    ready: false,
                    phase: 'Error',
                    message: `Hetzner could not issue the certificate: ${
                        remote.status?.error?.message ?? 'no detail was given'
                    }. Check that the domains resolve to this Hetzner project.`,
                    status,
                };
            }

            return {
                ready: false,
                phase: 'Creating',
                message: 'Hetzner is still obtaining the certificate from Let’s Encrypt',
                status,
                requeueAfterMs: REQUEUE_WHILE_ISSUING_MS,
            };
        },

        drift(context, remote) {
            const desiredType = context.spec.type ?? 'uploaded';
            const differences: string[] = [];

            if (remote.type && desiredType !== remote.type) {
                differences.push(`type: spec=${desiredType} actual=${remote.type}`);
            }
            if (
                desiredType === 'managed' &&
                !sameSet(context.spec.domainNames, remote.domain_names)
            ) {
                differences.push(
                    `domainNames: spec=[${(context.spec.domainNames ?? []).join(', ')}] ` +
                        `actual=[${(remote.domain_names ?? []).join(', ')}]`,
                );
            }
            if (differences.length === 0) {
                return undefined;
            }
            return (
                `Immutable fields differ from the certificate (${differences.join('; ')}). ` +
                'Hetzner certificates cannot be re-issued in place: create a replacement ' +
                'HetznerCertificate, point the load balancer at it, then delete this one.'
            );
        },
    };
}

async function readRequiredSecretValue(
    secrets: SecretReader,
    namespace: string,
    ref: SecretKeyRef,
): Promise<string> {
    const value = await secrets.read(namespace, ref);
    if (!value) {
        throw new Error(
            `Secret "${namespace}/${ref.name}" has no key "${ref.key}". ` +
                'An uploaded certificate needs both the PEM chain and its private key.',
        );
    }
    return value;
}
