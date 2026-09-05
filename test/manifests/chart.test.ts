/**
 * The Helm chart is the only supported way to install the controller, so it is
 * checked against the code rather than eyeballed.
 *
 * A missing verb in RBAC does not fail until the controller is running in a
 * real cluster and hits that one code path — usually the finalizer removal,
 * which is exactly the path where failing means leaking paid infrastructure.
 *
 * The chart is rendered with the real `helm` binary. Stubbing the template
 * engine would leave the templates themselves untested.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, loadAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { createActionTracker } from '../../src/hcloud/actions.js';
import { assembleHetznerCloud } from '../../src/hcloud/index.js';
import { RateLimiter } from '../../src/hcloud/rate-limiter.js';
import { GROUP } from '../../src/kube/api.js';
import { buildKinds } from '../../src/resources/index.js';
import { FakeHetznerApi } from '../support/fake-hcloud.js';

interface PolicyRule {
    apiGroups: string[];
    resources: string[];
    verbs: string[];
}

interface Document {
    kind?: string;
    apiVersion?: string;
    metadata?: {
        name?: string;
        namespace?: string;
        labels?: Record<string, string>;
        annotations?: Record<string, string>;
    };
    rules?: PolicyRule[];
    spec?: Record<string, unknown>;
    webhooks?: Array<Record<string, unknown>>;
    stringData?: Record<string, string>;
}

const CHART = join(process.cwd(), 'charts', 'hetzner-server-controller');
const RELEASE = 'hsc';
const NAMESPACE = 'hetzner-server-controller';

const helmAvailable = spawnSync('helm', ['version', '--short']).status === 0;

/** Renders the chart with `--set` overrides; throws with helm's own message on failure. */
function render(sets: string[] = [], { expectFailure = false } = {}): Document[] {
    const args = [
        'template',
        RELEASE,
        CHART,
        '--namespace',
        NAMESPACE,
        '--include-crds',
        ...sets.flatMap((set) => ['--set', set]),
    ];
    const result = spawnSync('helm', args, { encoding: 'utf8' });
    if (result.status !== 0) {
        if (expectFailure) {
            throw new Error(result.stderr);
        }
        throw new Error(`helm ${args.join(' ')} failed:\n${result.stderr}`);
    }
    return (loadAll(result.stdout) as Document[]).filter(Boolean);
}

function plurals(): string[] {
    const api = new FakeHetznerApi();
    const hcloud = assembleHetznerCloud({
        http: api,
        rateLimiter: new RateLimiter({ requestsPerHour: 3_600 }),
        actions: createActionTracker({ http: api, sleep: async () => undefined }),
    });
    return buildKinds({ hcloud, secrets: { read: async () => null } }).map(
        (kind) => kind.descriptor.plural,
    );
}

const only = (documents: Document[], kind: string): Document | undefined =>
    documents.find((document) => document.kind === kind);

describe.skipIf(!helmAvailable)('the Helm chart', () => {
    const defaults = render(['hetzner.token=test-token']);

    describe('rendering', () => {
        it('refuses to render without a token, and says how to provide one', () => {
            expect(() => render([], { expectFailure: true })).toThrow(/hetzner\.token/);
            expect(() => render([], { expectFailure: true })).toThrow(/hetzner\.existingSecret/);
        });

        it('refuses two replicas without leader election', () => {
            expect(() =>
                render(['hetzner.token=x', 'leaderElection.enabled=false'], {
                    expectFailure: true,
                }),
            ).toThrow(/replicaCount=1/);
        });

        it('rejects values outside the schema before anything is applied', () => {
            expect(() =>
                render(['hetzner.token=x', 'controller.logLevel=verbose'], {
                    expectFailure: true,
                }),
            ).toThrow(/logLevel/);
        });

        it('lints clean with every CI values file', () => {
            for (const file of readdirSync(join(CHART, 'ci'))) {
                const result = spawnSync('helm', ['lint', CHART, '-f', join(CHART, 'ci', file)], {
                    encoding: 'utf8',
                });
                expect(result.status, `${file}\n${result.stdout}${result.stderr}`).toBe(0);
            }
        });
    });

    describe('the CRDs', () => {
        it('are shipped for every kind the controller serves', () => {
            const shipped = defaults
                .filter((document) => document.kind === 'CustomResourceDefinition')
                .map((document) => document.metadata?.name);
            for (const plural of plurals()) {
                expect(shipped).toContain(`${plural}.${GROUP}`);
            }
        });
    });

    describe('the token', () => {
        it('is stored in a Secret the chart creates, and never as a literal', () => {
            const secret = only(defaults, 'Secret');
            expect(secret?.stringData?.token).toBe('test-token');
            expect(JSON.stringify(only(defaults, 'Deployment'))).not.toContain('test-token');
        });

        it('comes from the user’s own Secret when one is named, and none is created', () => {
            const documents = render([
                'hetzner.existingSecret=mine',
                'hetzner.existingSecretKey=hcloud',
            ]);
            expect(only(documents, 'Secret')).toBeUndefined();
            const env = containerEnv(documents);
            expect(env.HETZNER_TOKEN?.valueFrom).toEqual({
                secretKeyRef: { name: 'mine', key: 'hcloud' },
            });
        });
    });

    describe('RBAC', () => {
        const clusterRole = only(defaults, 'ClusterRole');
        const ruleFor = (resource: string, verb: string) =>
            clusterRole?.rules?.find(
                (rule) =>
                    rule.apiGroups.includes(GROUP) &&
                    rule.resources.includes(resource) &&
                    rule.verbs.includes(verb),
            );

        it('grants read, watch and update on every kind', () => {
            for (const plural of plurals()) {
                for (const verb of ['get', 'list', 'watch', 'update', 'patch']) {
                    expect(ruleFor(plural, verb), `${plural}: ${verb}`).toBeDefined();
                }
            }
        });

        it('grants status writes on every kind', () => {
            for (const plural of plurals()) {
                for (const verb of ['get', 'update', 'patch']) {
                    expect(ruleFor(`${plural}/status`, verb), `${plural}/status`).toBeDefined();
                }
            }
        });

        it('grants finalizer updates on every kind', () => {
            // Without this the controller can never release an object, and
            // every delete hangs forever with the Hetzner resource already gone.
            for (const plural of plurals()) {
                expect(ruleFor(`${plural}/finalizers`, 'update'), plural).toBeDefined();
            }
        });

        it('never grants create or delete on the custom resources', () => {
            for (const rule of clusterRole?.rules ?? []) {
                if (rule.apiGroups.includes(GROUP)) {
                    expect(rule.verbs).not.toContain('create');
                    expect(rule.verbs).not.toContain('delete');
                }
            }
        });

        it('reads one Secret by name and never enumerates them', () => {
            const secrets = clusterRole?.rules?.find(
                (rule) => rule.apiGroups.includes('') && rule.resources.includes('secrets'),
            );
            expect(secrets?.verbs).toEqual(['get']);
        });

        it('drops the Secrets grant when uploaded certificates are not used', () => {
            const documents = render(['hetzner.token=x', 'rbac.secretsAccess=false']);
            const rules = only(documents, 'ClusterRole')?.rules ?? [];
            expect(rules.some((rule) => rule.resources.includes('secrets'))).toBe(false);
        });

        it('uses no wildcards anywhere', () => {
            for (const rule of clusterRole?.rules ?? []) {
                expect(rule.verbs).not.toContain('*');
                expect(rule.resources).not.toContain('*');
                expect(rule.apiGroups).not.toContain('*');
            }
        });

        it('keeps the lease permission namespaced, next to the controller', () => {
            const role = only(defaults, 'Role');
            const leases = role?.rules?.find((rule) =>
                rule.apiGroups.includes('coordination.k8s.io'),
            );
            expect(leases?.resources).toEqual(['leases']);
            expect(leases?.verbs.sort()).toEqual(['create', 'get', 'update']);
            expect(role?.metadata?.namespace).toBe(NAMESPACE);
        });

        it('becomes a namespaced Role when confined to one namespace', () => {
            const documents = render(['hetzner.token=x', 'controller.watchNamespace=team-a']);
            expect(only(documents, 'ClusterRole')).toBeUndefined();
            expect(only(documents, 'ClusterRoleBinding')).toBeUndefined();
            const roles = documents.filter((document) => document.kind === 'Role');
            expect(roles.map((role) => role.metadata?.namespace)).toContain('team-a');
            expect(containerEnv(documents).WATCH_NAMESPACE?.value).toBe('team-a');
        });
    });

    describe('the Deployment', () => {
        const deployment = only(defaults, 'Deployment');
        const pod = podSpec(defaults);
        const container = (pod.containers as Array<Record<string, unknown>>)[0] ?? {};
        const env = containerEnv(defaults);

        it('runs two replicas, which is only safe with leader election', () => {
            expect(deployment?.spec?.replicas).toBe(2);
            expect(env.LEADER_ELECTION_ENABLED?.value).toBe('true');
            expect(only(defaults, 'PodDisruptionBudget')).toBeDefined();
        });

        it('passes the Pod identity down for the leader lease', () => {
            for (const name of ['POD_NAME', 'POD_NAMESPACE']) {
                expect(env[name]?.valueFrom, name).toBeDefined();
            }
        });

        it('sets every environment variable the controller reads', () => {
            // config/index.ts is the source of truth; a value the chart forgets
            // to pass silently falls back to the compiled-in default.
            const source = readFileSync(join(process.cwd(), 'src/config/index.ts'), 'utf8');
            const variables = new Set(
                source.match(/'[A-Z][A-Z0-9_]+'/g)?.map((v) => v.slice(1, -1)),
            );
            variables.delete('LEADER_ELECTION_IDENTITY'); // Defaults to POD_NAME on purpose.
            variables.delete('LEADER_ELECTION_NAMESPACE'); // Defaults to POD_NAMESPACE on purpose.
            for (const variable of variables) {
                if (variable.startsWith('WEBHOOK_') && variable !== 'WEBHOOK_ENABLED') {
                    continue; // Only set when the webhook is on; checked below.
                }
                expect(env[variable], variable).toBeDefined();
            }
        });

        it('uses the chart’s appVersion as the image tag', () => {
            const chart = load(readFileSync(join(CHART, 'Chart.yaml'), 'utf8')) as {
                appVersion: string;
            };
            expect(container.image).toBe(
                `shebanglabs/hetzner-server-controller:${chart.appVersion}`,
            );
        });

        it('runs unprivileged, as a non-root user, with a read-only root filesystem', () => {
            const podSecurity = pod.securityContext as Record<string, unknown>;
            const security = container.securityContext as Record<string, unknown>;
            expect(podSecurity.runAsNonRoot).toBe(true);
            expect(podSecurity.runAsUser).toBe(65532);
            expect(security.allowPrivilegeEscalation).toBe(false);
            expect(security.readOnlyRootFilesystem).toBe(true);
            expect((security.capabilities as { drop: string[] }).drop).toEqual(['ALL']);
        });

        it('probes liveness and readiness on separate endpoints', () => {
            // Conflating them restarts every standby replica in a loop.
            const liveness = container.livenessProbe as { httpGet: { path: string } };
            const readiness = container.readinessProbe as { httpGet: { path: string } };
            expect(liveness.httpGet.path).toBe('/healthz');
            expect(readiness.httpGet.path).toBe('/readyz');
        });

        it('sets a memory limit but no CPU limit', () => {
            const resources = container.resources as {
                limits: Record<string, string>;
                requests: Record<string, string>;
            };
            expect(resources.requests.cpu).toBeDefined();
            expect(resources.limits.memory).toBeDefined();
            // Throttling a reconcile loop turns a busy resync into API timeouts.
            expect(resources.limits.cpu).toBeUndefined();
        });

        it('gives reconciles time to finish before SIGKILL', () => {
            expect(Number(pod.terminationGracePeriodSeconds)).toBeGreaterThanOrEqual(30);
        });

        it('leaves the webhook off by default, since it needs cert-manager', () => {
            expect(env.WEBHOOK_ENABLED?.value).toBe('false');
            expect(pod.volumes).toBeUndefined();
            expect(only(defaults, 'ValidatingWebhookConfiguration')).toBeUndefined();
            expect(only(defaults, 'Certificate')).toBeUndefined();
        });

        it('passes enabledKinds as the comma-separated list the controller parses', () => {
            const documents = render([
                'hetzner.token=x',
                'controller.enabledKinds={HetznerServer,HetznerVolume}',
            ]);
            expect(containerEnv(documents).ENABLED_KINDS?.value).toBe(
                'HetznerServer,HetznerVolume',
            );
        });
    });

    describe('the webhook', () => {
        const documents = render(['hetzner.token=x', 'webhook.enabled=true']);
        const configuration = only(documents, 'ValidatingWebhookConfiguration');
        const webhook = configuration?.webhooks?.[0] as {
            failurePolicy: string;
            sideEffects: string;
            admissionReviewVersions: string[];
            clientConfig: { service: { name: string; path: string; namespace: string } };
            rules: Array<{ resources: string[]; operations: string[] }>;
        };

        it('fails closed, so an unchecked spec cannot create billable infrastructure', () => {
            expect(webhook.failurePolicy).toBe('Fail');
        });

        it('declares no side effects, which dry-run relies on', () => {
            expect(webhook.sideEffects).toBe('None');
            expect(webhook.admissionReviewVersions).toEqual(['v1']);
        });

        it('points at the Service and path the handler serves', () => {
            expect(webhook.clientConfig.service.path).toBe('/validate');
            const service = documents.find(
                (document) =>
                    document.kind === 'Service' &&
                    document.metadata?.name === webhook.clientConfig.service.name,
            );
            expect(service, 'webhook Service').toBeDefined();
            expect(service?.metadata?.namespace).toBe(webhook.clientConfig.service.namespace);
        });

        it('covers every kind, on create and update', () => {
            const rule = webhook.rules[0];
            expect(rule?.operations).toEqual(['CREATE', 'UPDATE']);
            for (const plural of plurals()) {
                expect(rule?.resources, plural).toContain(plural);
            }
        });

        it('lets cert-manager inject the CA and issue the serving certificate', () => {
            const certificate = only(documents, 'Certificate');
            expect(configuration?.metadata?.annotations?.['cert-manager.io/inject-ca-from']).toBe(
                `${NAMESPACE}/${certificate?.metadata?.name}`,
            );
            expect(only(documents, 'Issuer')).toBeDefined();
            const secretName = certificate?.spec?.secretName;
            const volumes = podSpec(documents).volumes as Array<{
                secret?: { secretName: string };
            }>;
            expect(volumes.some((volume) => volume.secret?.secretName === secretName)).toBe(true);
            const env = containerEnv(documents);
            expect(env.WEBHOOK_ENABLED?.value).toBe('true');
            expect(env.WEBHOOK_CERT_FILE?.value).toBe('/etc/webhook/certs/tls.crt');
        });
    });

    describe('optional integrations', () => {
        it('renders a ServiceMonitor and a NetworkPolicy only when asked', () => {
            expect(only(defaults, 'ServiceMonitor')).toBeUndefined();
            expect(only(defaults, 'NetworkPolicy')).toBeUndefined();
            const documents = render([
                'hetzner.token=x',
                'metrics.serviceMonitor.enabled=true',
                'networkPolicy.enabled=true',
            ]);
            expect(only(documents, 'ServiceMonitor')).toBeDefined();
            expect(only(documents, 'NetworkPolicy')).toBeDefined();
        });

        it('exposes metrics on a Service the helm test can reach', () => {
            const service = documents(defaults, 'Service')[0];
            expect(service?.metadata?.name).toBe(`${RELEASE}-hetzner-server-controller-metrics`);
            const test = defaults.find(
                (document) => document.metadata?.annotations?.['helm.sh/hook'] === 'test',
            );
            expect(JSON.stringify(test)).toContain(service?.metadata?.name);
        });
    });
});

function documents(all: Document[], kind: string): Document[] {
    return all.filter((document) => document.kind === kind);
}

function containerEnv(
    all: Document[],
): Record<string, { value?: string; valueFrom?: unknown } | undefined> {
    const container = (podSpec(all).containers as Array<Record<string, unknown>>)[0];
    const entries = container?.env as Array<{ name: string; value?: string; valueFrom?: unknown }>;
    return Object.fromEntries(entries.map((entry) => [entry.name, entry]));
}

/** The Pod template's spec, or an empty object so a missing Deployment fails an assertion, not a property access. */
function podSpec(all: Document[]): Record<string, unknown> {
    const template = only(all, 'Deployment')?.spec?.template as
        | { spec?: Record<string, unknown> }
        | undefined;
    return template?.spec ?? {};
}
