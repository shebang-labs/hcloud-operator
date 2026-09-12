/**
 * The CRDs are the real API contract — the TypeScript types are only a
 * convenience. These tests keep the two from drifting apart, and check the
 * things a cluster would reject on `kubectl apply` but that nothing else in the
 * test suite would notice.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { createActionTracker } from '../../src/hcloud/actions.js';
import { assembleHetznerCloud } from '../../src/hcloud/index.js';
import { RateLimiter } from '../../src/hcloud/rate-limiter.js';
import { GROUP, VERSION } from '../../src/kube/api.js';
import { buildKinds } from '../../src/resources/index.js';
import { FakeHetznerApi } from '../support/fake-hcloud.js';

interface Crd {
    apiVersion: string;
    kind: string;
    metadata: { name: string };
    spec: {
        group: string;
        scope: string;
        names: { kind: string; plural: string; singular: string; shortNames: string[] };
        versions: Array<{
            name: string;
            served: boolean;
            storage: boolean;
            subresources?: { status?: unknown };
            additionalPrinterColumns?: Array<{ name: string; jsonPath: string }>;
            schema: { openAPIV3Schema: SchemaNode };
        }>;
    };
}

interface SchemaNode {
    type?: string;
    properties?: Record<string, SchemaNode>;
    items?: SchemaNode;
    required?: string[];
    enum?: unknown[];
    nullable?: boolean;
    default?: unknown;
    additionalProperties?: SchemaNode | boolean;
    oneOf?: unknown[];
    description?: string;
    format?: string;
    minimum?: number;
}

const CRD_DIR = join(process.cwd(), 'charts', 'hcloud-operator', 'crds');

const crdFiles = readdirSync(CRD_DIR).filter((file) => file.endsWith('.yaml'));

const crds: Crd[] = crdFiles.map((file) => load(readFileSync(join(CRD_DIR, file), 'utf8')) as Crd);

function registeredKinds() {
    const api = new FakeHetznerApi();
    const hcloud = assembleHetznerCloud({
        http: api,
        rateLimiter: new RateLimiter({ requestsPerHour: 3_600 }),
        actions: createActionTracker({ http: api, sleep: async () => undefined }),
    });
    return buildKinds({ hcloud, secrets: { read: async () => null } });
}

/** Walks every node of a schema, so structural rules can be checked in one go. */
function walk(node: SchemaNode, path: string, visit: (node: SchemaNode, path: string) => void) {
    visit(node, path);
    for (const [name, child] of Object.entries(node.properties ?? {})) {
        walk(child, `${path}.${name}`, visit);
    }
    if (node.items) {
        walk(node.items, `${path}[]`, visit);
    }
    if (node.additionalProperties && typeof node.additionalProperties === 'object') {
        walk(node.additionalProperties, `${path}{}`, visit);
    }
}

describe('the CRD files', () => {
    it('there is one per registered kind, and no orphans', () => {
        const fromCode = registeredKinds()
            .map((kind) => kind.descriptor.kind)
            .sort();
        const fromYaml = crds.map((crd) => crd.spec.names.kind).sort();

        expect(fromYaml).toEqual(fromCode);
    });

    it.each(crds.map((crd) => [crd.spec.names.kind, crd] as const))(
        '%s is a well-formed CustomResourceDefinition',
        (_kind, crd) => {
            expect(crd.apiVersion).toBe('apiextensions.k8s.io/v1');
            expect(crd.kind).toBe('CustomResourceDefinition');
            expect(crd.spec.scope).toBe('Namespaced');
            expect(crd.spec.group).toBe(GROUP);
            // The API server requires metadata.name to be exactly plural.group.
            expect(crd.metadata.name).toBe(`${crd.spec.names.plural}.${GROUP}`);
        },
    );

    it.each(crds.map((crd) => [crd.spec.names.kind, crd] as const))(
        '%s serves exactly one stored version with a status subresource',
        (_kind, crd) => {
            expect(crd.spec.versions).toHaveLength(1);
            const version = crd.spec.versions[0];
            expect(version?.name).toBe(VERSION);
            expect(version?.served).toBe(true);
            expect(version?.storage).toBe(true);
            // Without this, the operator's status writes would bump
            // metadata.generation and re-trigger itself forever.
            expect(version?.subresources?.status).toBeDefined();
        },
    );

    it('the descriptors in code match the names in YAML', () => {
        const byKind = new Map(crds.map((crd) => [crd.spec.names.kind, crd]));

        for (const { descriptor } of registeredKinds()) {
            const crd = byKind.get(descriptor.kind);
            expect(crd, `no CRD for ${descriptor.kind}`).toBeDefined();
            expect(crd?.spec.names.plural).toBe(descriptor.plural);
            expect(crd?.spec.names.shortNames).toContain(descriptor.shortName);
        }
    });

    it.each(crds.map((crd) => [crd.spec.names.kind, crd] as const))(
        '%s declares the fields every kind shares',
        (_kind, crd) => {
            const spec = crd.spec.versions[0]?.schema.openAPIV3Schema.properties?.spec;
            const status = crd.spec.versions[0]?.schema.openAPIV3Schema.properties?.status;

            for (const field of ['adoptExisting', 'deletionPolicy', 'labels']) {
                expect(spec?.properties?.[field], `spec.${field}`).toBeDefined();
            }
            for (const field of [
                'phase',
                'id',
                'hetznerName',
                'message',
                'observedGeneration',
                'conditions',
            ]) {
                expect(status?.properties?.[field], `status.${field}`).toBeDefined();
            }
            expect(spec?.properties?.deletionPolicy?.enum).toEqual(['Delete', 'Orphan']);
            expect(spec?.properties?.deletionPolicy?.default).toBe('Delete');
        },
    );

    it.each(crds.map((crd) => [crd.spec.names.kind, crd] as const))(
        '%s has a structural schema the API server will accept',
        (_kind, crd) => {
            const root = crd.spec.versions[0]?.schema.openAPIV3Schema;
            expect(root).toBeDefined();
            if (!root) {
                return;
            }

            walk(root, '$', (node, path) => {
                // A union type is valid OpenAPI but not a valid structural
                // schema; Kubernetes wants `type: X` plus `nullable: true`.
                expect(Array.isArray(node.type), `${path} uses a union type`).toBe(false);

                if (node.properties) {
                    expect(node.type, `${path} has properties but no type`).toBe('object');
                }
                if (node.items) {
                    expect(node.type, `${path} has items but is not an array`).toBe('array');
                }
                // An enum containing null without nullable is rejected.
                if (node.enum?.includes(null)) {
                    expect(node.nullable, `${path} has a null enum value`).toBe(true);
                }
            });
        },
    );

    it.each(crds.map((crd) => [crd.spec.names.kind, crd] as const))(
        '%s shows something useful in kubectl get',
        (_kind, crd) => {
            const columns = crd.spec.versions[0]?.additionalPrinterColumns ?? [];
            const names = columns.map((column) => column.name);

            expect(names).toContain('Phase');
            expect(names).toContain('Ready');
            expect(names).toContain('Age');
            for (const column of columns) {
                expect(column.jsonPath.startsWith('.'), column.jsonPath).toBe(true);
            }
        },
    );

    it('every reference field offers all three forms', () => {
        // A ref that accepted only `name` would make unmanaged Hetzner resources
        // unreachable, which is the main thing adoption is for.
        for (const crd of crds) {
            const root = crd.spec.versions[0]?.schema.openAPIV3Schema;
            if (!root) {
                continue;
            }
            walk(root, '$', (node, path) => {
                if (!path.endsWith('Ref') && !path.endsWith('Refs[]')) {
                    return;
                }
                // A reference to a Kubernetes Secret — secretRef,
                // userDataSecretRef — is not a reference to a Hetzner resource,
                // so it has a different shape by design.
                if (path.endsWith('.secretRef') || path.endsWith('SecretRef')) {
                    return;
                }
                expect(Object.keys(node.properties ?? {}).sort(), path).toEqual([
                    'hetznerName',
                    'id',
                    'name',
                    'namespace',
                ]);
                expect(node.oneOf, path).toHaveLength(3);
            });
        }
    });

    it('has no enum value that YAML 1.1 would turn into a boolean', () => {
        // The Kubernetes API server parses manifests as YAML 1.1, where bare
        // `On`, `Off`, `Yes`, `No`, `Y` and `N` are booleans — the "Norway
        // problem". An enum value like `On` therefore arrives as `true` and is
        // rejected with a confusing type error for every user who writes it
        // unquoted. js-yaml is YAML 1.2 and does not reproduce this, so nothing
        // else in this suite would catch it.
        const yaml11Booleans = new Set(['y', 'yes', 'n', 'no', 'true', 'false', 'on', 'off']);

        // Spec only. `status.conditions[].status` is legitimately "True" /
        // "False" — that is the Kubernetes standard — but it is written by the
        // operator and never typed into a manifest, so the trap cannot bite.
        const offenders: string[] = [];
        for (const crd of crds) {
            const spec = crd.spec.versions[0]?.schema.openAPIV3Schema.properties?.spec;
            if (!spec) {
                continue;
            }
            walk(spec, `${crd.spec.names.kind}.spec`, (node, path) => {
                for (const value of node.enum ?? []) {
                    if (typeof value === 'string' && yaml11Booleans.has(value.toLowerCase())) {
                        offenders.push(`${path} = "${value}"`);
                    }
                }
                if (
                    typeof node.default === 'string' &&
                    yaml11Booleans.has(node.default.toLowerCase())
                ) {
                    offenders.push(`${path} default = "${node.default}"`);
                }
            });
        }

        expect(offenders).toEqual([]);
    });

    it('documents what each spec field means', () => {
        // A CRD is the API documentation users actually read, through
        // `kubectl explain`. An undocumented field is a support ticket.
        const undocumented: string[] = [];
        for (const crd of crds) {
            const spec = crd.spec.versions[0]?.schema.openAPIV3Schema.properties?.spec;
            for (const [name, node] of Object.entries(spec?.properties ?? {})) {
                if (!node.description && !node.enum) {
                    undocumented.push(`${crd.spec.names.kind}.spec.${name}`);
                }
            }
        }
        expect(undocumented).toEqual([]);
    });
});

describe('HetznerImage specifically', () => {
    const crd = crds.find((entry) => entry.spec.names.kind === 'HetznerImage') as Crd;
    const status = () =>
        crd.spec.versions[0]?.schema.openAPIV3Schema.properties?.status?.properties ?? {};

    it('accepts the decimal image size Hetzner reports', () => {
        // image_size comes back as e.g. 48.36 GB. Declared as integer, the API
        // server rejected the status write with 422 for every finished snapshot
        // and the object stayed Creating although the image existed.
        expect(status().imageSize?.type).toBe('number');
        const size = crd.spec.versions[0]?.additionalPrinterColumns?.find((c) => c.name === 'Size');
        expect((size as { type?: string } | undefined)?.type).toBe('number');
    });
});

describe('HetznerServer specifically', () => {
    const crd = crds.find((entry) => entry.spec.names.kind === 'HetznerServer');
    const spec = crd?.spec.versions[0]?.schema.openAPIV3Schema.properties?.spec;

    it('requires only the fields the adapter requires', () => {
        expect(spec?.required?.sort()).toEqual(['image', 'serverType']);
    });

    it('offers every convergent operation the adapter implements', () => {
        for (const field of [
            'powerState',
            'backups',
            'rescue',
            'iso',
            'dnsPtr',
            'protection',
            'networks',
            'placementGroupRef',
        ]) {
            expect(spec?.properties?.[field], field).toBeDefined();
        }
    });

    it('offers every guard the adapter checks', () => {
        for (const field of ['allowDowntime', 'allowDataLoss', 'upgradeDisk']) {
            expect(spec?.properties?.[field], field).toBeDefined();
        }
    });

    it('has no volumeRefs or firewallRefs, which belong on the other side', () => {
        // Declaring a relationship from both ends would make two controllers
        // fight; see docs/RELATIONSHIPS.md.
        expect(spec?.properties?.volumeRefs).toBeUndefined();
        expect(spec?.properties?.firewallRefs).toBeUndefined();
    });

    it('lets spec.iso be explicitly null, which means "detach"', () => {
        expect(spec?.properties?.iso?.nullable).toBe(true);
    });
});
