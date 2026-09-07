/**
 * Admission validation: catching a bad spec at `kubectl apply` time instead of
 * letting the object sit in a retry loop nobody looks at.
 *
 * Two sources of truth are consulted, in order:
 *
 *   1. The adapter's own `validate()` — the same pure function the reconcile
 *      engine runs. Sharing it means the two can never disagree about what a
 *      valid spec is.
 *   2. Hetzner's read-only catalog — server types, locations, datacenters,
 *      images, ISOs. This is the part a schema cannot express: `cpx99` is a
 *      perfectly well-formed string and a completely invalid server type.
 *
 * The catalog is advisory in one direction only. If Hetzner is unreachable the
 * webhook allows the request with a warning rather than blocking every apply in
 * the cluster on a third party's availability.
 *
 * On UPDATE only the catalog fields the change actually touches are checked.
 * Hetzner retires server types and images over time; an object created with
 * one must stay editable, or the only way to change anything about it is to
 * delete and recreate the server.
 */

import type { ResourceAdapter } from '../framework/types.js';
import type { CatalogApi } from '../hcloud/resources/catalog.js';
import type { Labelled } from '../hcloud/types.js';
import type { CommonSpec, CommonStatus } from '../kube/api.js';
import type { Logger } from '../observability/logger.js';
import { type AdmissionRequest, type AdmissionResponse, allow, deny } from './review.js';

/** The subset of a server spec the catalog can check. */
interface CatalogCheckedSpec {
    serverType?: unknown;
    image?: unknown;
    location?: unknown;
    datacenter?: unknown;
    iso?: unknown;
}

const CATALOG_CHECKED_FIELDS = [
    'serverType',
    'image',
    'location',
    'datacenter',
    'iso',
] as const satisfies readonly (keyof CatalogCheckedSpec)[];

export type AnyAdapter = ResourceAdapter<CommonSpec, CommonStatus, Labelled>;

export interface ValidatorOptions {
    /** The adapters, keyed by kind, so `validate()` is shared with the engine. */
    adapters: ReadonlyMap<string, AnyAdapter>;
    catalog: CatalogApi;
    logger: Logger;
}

export interface Validator {
    review(request: AdmissionRequest): Promise<AdmissionResponse>;
}

/** How many valid values to list back in an error message. */
const SUGGESTION_LIMIT = 12;

export function createValidator(options: ValidatorOptions): Validator {
    const { adapters, catalog, logger } = options;

    return {
        async review(request) {
            const kind = request.kind?.kind ?? '';
            const adapter = adapters.get(kind);
            const spec = request.object?.spec;

            if (!adapter || !spec || typeof spec !== 'object') {
                // Not a kind we serve, or a delete with no object. The webhook
                // registration should have excluded it; allowing is the safe
                // answer either way.
                return allow(request.uid);
            }

            const problems = adapter.validate?.(spec as CommonSpec) ?? [];
            if (problems.length > 0) {
                return deny(request.uid, `${kind} spec is invalid: ${problems.join('; ')}`);
            }

            let catalogProblems: string[] = [];
            try {
                catalogProblems = await checkAgainstCatalog(
                    catalog,
                    fieldsToCheck(request, spec as CatalogCheckedSpec),
                );
            } catch (error) {
                // Hetzner is unreachable. Blocking every apply in the cluster on
                // that would be far worse than letting a typo through to a
                // condition the reconcile loop will report anyway.
                logger.warn('Could not reach the Hetzner catalog; allowing with a warning', {
                    error,
                });
                return allow(request.uid, [
                    'The operator could not reach the Hetzner Cloud API to check server types, ' +
                        'locations and images. The spec was accepted unchecked; watch the ' +
                        'resource’s Synced condition after applying.',
                ]);
            }

            if (catalogProblems.length > 0) {
                return deny(request.uid, `${kind} spec is invalid: ${catalogProblems.join('; ')}`);
            }

            return allow(request.uid);
        },
    };
}

/**
 * Narrows the spec to the catalog fields worth checking for this request.
 *
 * A CREATE checks everything. An UPDATE checks only the fields whose value
 * differs from the stored object: a value Hetzner has since retired was valid
 * when it was accepted, and re-checking it would make the object read-only.
 * Without an old object to compare against, everything is checked.
 */
function fieldsToCheck(request: AdmissionRequest, spec: CatalogCheckedSpec): CatalogCheckedSpec {
    const previous = request.oldObject?.spec;
    if (request.operation !== 'UPDATE' || !previous || typeof previous !== 'object') {
        return spec;
    }

    const changed: CatalogCheckedSpec = {};
    for (const field of CATALOG_CHECKED_FIELDS) {
        if (spec[field] !== (previous as CatalogCheckedSpec)[field]) {
            changed[field] = spec[field];
        }
    }
    return changed;
}

/**
 * Checks the fields whose valid values live in Hetzner's catalog rather than in
 * the CRD schema. A catalog list is only fetched for a field that is present,
 * so an update that touches none of them costs no Hetzner request at all.
 */
async function checkAgainstCatalog(
    catalog: CatalogApi,
    spec: CatalogCheckedSpec,
): Promise<string[]> {
    const problems: string[] = [];

    /**
     * Checks one field, but only when the catalog actually returned something.
     *
     * An empty list means the operator could not learn what is valid — a
     * changed endpoint, a token with narrower scope. Rejecting every value
     * against an empty list would break every apply in the cluster, so an empty
     * catalog is treated as "no opinion".
     */
    async function check(
        field: string,
        value: unknown,
        load: () => Promise<(string | null | undefined)[]>,
    ): Promise<void> {
        if (typeof value !== 'string' || !value) {
            return;
        }
        const valid = (await load()).filter((name): name is string => Boolean(name));
        if (valid.length > 0 && !valid.includes(value)) {
            problems.push(unknownValue(field, value, valid));
        }
    }

    await check('spec.serverType', spec.serverType, async () =>
        (await catalog.serverTypes()).map((type) => type.name),
    );
    await check('spec.location', spec.location, async () =>
        (await catalog.locations()).map((location) => location.name),
    );
    await check('spec.datacenter', spec.datacenter, async () =>
        (await catalog.datacenters()).map((datacenter) => datacenter.name),
    );

    // A numeric image is a snapshot id, which the catalog of *system* images
    // does not list; only named images are checkable here.
    if (typeof spec.image !== 'string' || !/^\d+$/.test(spec.image)) {
        await check('spec.image', spec.image, async () =>
            (await catalog.systemImages()).map((image) => image.name),
        );
    }

    await check('spec.iso', spec.iso, async () => (await catalog.isos()).map((iso) => iso.name));

    return problems;
}

/**
 * "cpx99 is not a Hetzner server type. Valid values are: cx22, cpx21, ...".
 *
 * Listing the alternatives is the whole point: a rejection that only says "no"
 * sends the user to the Hetzner console to look it up.
 */
function unknownValue(field: string, value: string, valid: string[]): string {
    const sorted = [...valid].sort();
    const shown = sorted.slice(0, SUGGESTION_LIMIT).join(', ');
    const rest =
        sorted.length > SUGGESTION_LIMIT ? `, and ${sorted.length - SUGGESTION_LIMIT} more` : '';
    return `${field} "${value}" does not exist in this Hetzner project. Valid values: ${shown}${rest}`;
}
