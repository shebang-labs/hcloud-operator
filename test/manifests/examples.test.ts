/**
 * Every example is validated against the CRD schema that would accept it in a
 * real cluster. Documentation that does not apply is worse than none, and an
 * example is the first thing anyone copies.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { loadAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { API_VERSION } from '../../src/kube/api.js';

interface KubernetesDocument {
    apiVersion?: string;
    kind?: string;
    metadata?: { name?: string; namespace?: string };
    spec?: unknown;
}

const CRD_DIR = join(process.cwd(), 'charts', 'hcloud-operator', 'crds');
const EXAMPLES_DIR = join(process.cwd(), 'examples');

/** A validator per kind, built from the CRD's own openAPIV3Schema. */
function buildValidators(): Map<string, ValidateFunction> {
    // `strict: false` because a CRD schema legitimately uses keywords Ajv does
    // not know (`nullable`, `x-kubernetes-*`); we are checking user documents
    // against it, not linting the schema itself.
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);

    const validators = new Map<string, ValidateFunction>();
    for (const file of readdirSync(CRD_DIR).filter((entry) => entry.endsWith('.yaml'))) {
        const [crd] = loadAll(readFileSync(join(CRD_DIR, file), 'utf8')) as Array<{
            spec: {
                names: { kind: string };
                versions: Array<{ schema: { openAPIV3Schema: object } }>;
            };
        }>;
        const schema = crd?.spec.versions[0]?.schema.openAPIV3Schema;
        if (crd && schema) {
            validators.set(crd.spec.names.kind, ajv.compile(schema));
        }
    }
    return validators;
}

function yamlFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) {
            return yamlFiles(path);
        }
        return entry.endsWith('.yaml') ? [path] : [];
    });
}

const validators = buildValidators();
const files = yamlFiles(EXAMPLES_DIR);

function documentsIn(file: string): KubernetesDocument[] {
    return (loadAll(readFileSync(file, 'utf8')) as KubernetesDocument[]).filter(Boolean);
}

describe('the examples', () => {
    it('there are some, in both the stack and single-resource directories', () => {
        expect(files.length).toBeGreaterThan(5);
        expect(files.some((file) => file.includes('stack'))).toBe(true);
        expect(files.some((file) => file.includes('single'))).toBe(true);
    });

    it.each(files.map((file) => [file.replace(`${process.cwd()}/`, ''), file] as const))(
        '%s parses and every document is addressed to this operator',
        (_label, file) => {
            const documents = documentsIn(file);
            expect(documents.length).toBeGreaterThan(0);

            for (const document of documents) {
                expect(document.kind).toBeTruthy();
                expect(document.metadata?.name).toBeTruthy();
                if (document.apiVersion?.includes('shebanglabs.io')) {
                    expect(document.apiVersion).toBe(API_VERSION);
                }
            }
        },
    );

    it.each(files.map((file) => [file.replace(`${process.cwd()}/`, ''), file] as const))(
        '%s validates against the CRD schemas',
        (_label, file) => {
            for (const document of documentsIn(file)) {
                if (document.apiVersion !== API_VERSION) {
                    continue; // A plain Namespace or Secret; not ours to validate.
                }
                const validate = validators.get(document.kind ?? '');
                expect(validate, `no CRD for kind ${document.kind}`).toBeDefined();
                if (!validate) {
                    continue;
                }

                const valid = validate(document);
                expect(
                    valid,
                    `${document.kind}/${document.metadata?.name}: ${JSON.stringify(validate.errors, null, 2)}`,
                ).toBe(true);
            }
        },
    );

    it('uses documentation placeholders, never a real hostname or key', () => {
        const text = files
            .map((file) => readFileSync(file, 'utf8'))
            .join('\n')
            // The API group is the one legitimate real domain in every file.
            .replaceAll(API_VERSION.split('/')[0] ?? '', '');

        // RFC 2606 reserves example.com for exactly this purpose. A real
        // hostname in an example is something somebody will copy verbatim.
        expect(text.replaceAll('kubernetes.io', '')).not.toMatch(/[a-z0-9-]+\.(io|dev|net|org)\b/);
        expect(text).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----\n[A-Za-z0-9+/=]{20,}/);
    });

    it('covers every kind the operator serves', () => {
        const covered = new Set(
            files.flatMap((file) =>
                documentsIn(file)
                    .filter((document) => document.apiVersion === API_VERSION)
                    .map((document) => document.kind ?? ''),
            ),
        );

        for (const kind of validators.keys()) {
            expect(covered, `no example uses ${kind}`).toContain(kind);
        }
    });
});
