/**
 * Reference resolution decides whether applying a whole stack at once works or
 * turns into a dependency-ordering exercise for the user. The distinction that
 * matters most is between "missing" and "not ready yet": the first is usually a
 * typo, the second is normal and must not consume a retry budget.
 */

import { describe, expect, it } from 'vitest';
import {
    createReferenceResolver,
    DependencyMissingError,
    DependencyNotReadyError,
    describeRef,
    isDependencyError,
    type ReferenceTarget,
} from '../../src/framework/references.js';
import type { AnyManagedResource } from '../../src/kube/api.js';
import { CONDITION_READY } from '../../src/kube/conditions.js';

function readyResource(id: number): AnyManagedResource {
    return {
        metadata: { name: 'prod', namespace: 'default' },
        spec: {},
        status: {
            id,
            conditions: [
                {
                    type: CONDITION_READY,
                    status: 'True',
                    reason: 'Ready',
                    message: '',
                    lastTransitionTime: '2026-01-01T00:00:00Z',
                },
            ],
        },
    };
}

function makeResolver(overrides: Partial<ReferenceTarget> = {}) {
    const targets = new Map<string, ReferenceTarget>();
    targets.set('HetznerNetwork', {
        descriptor: { kind: 'HetznerNetwork', plural: 'hetznernetworks', shortName: 'hnet' },
        get: async () => readyResource(4711),
        remote: {
            get: async (id) => ({ id }),
            getByName: async (name) => (name === 'legacy' ? { id: 9000, name } : null),
        },
        ...overrides,
    });
    return createReferenceResolver(targets);
}

describe('ReferenceResolver', () => {
    it('returns a raw id unchanged, without any lookup', async () => {
        const resolver = makeResolver({
            get: async () => {
                throw new Error('should not be called');
            },
        });

        expect(await resolver.resolve('HetznerNetwork', { id: 42 }, 'default')).toBe(42);
    });

    it('resolves an unmanaged resource by its Hetzner name', async () => {
        const resolver = makeResolver();

        expect(await resolver.resolve('HetznerNetwork', { hetznerName: 'legacy' }, 'default')).toBe(
            9000,
        );
    });

    it('resolves a custom resource by name to its Hetzner id', async () => {
        const resolver = makeResolver();

        expect(await resolver.resolve('HetznerNetwork', { name: 'prod' }, 'default')).toBe(4711);
    });

    it('reports a missing custom resource as DependencyMissingError', async () => {
        const resolver = makeResolver({ get: async () => null });

        await expect(
            resolver.resolve('HetznerNetwork', { name: 'nope' }, 'default'),
        ).rejects.toBeInstanceOf(DependencyMissingError);
    });

    it('reports a missing unmanaged resource as DependencyMissingError', async () => {
        const resolver = makeResolver();

        await expect(
            resolver.resolve('HetznerNetwork', { hetznerName: 'gone' }, 'default'),
        ).rejects.toBeInstanceOf(DependencyMissingError);
    });

    it('reports an unreconciled resource as DependencyNotReadyError', async () => {
        const resolver = makeResolver({
            get: async () => ({ metadata: { name: 'prod' }, spec: {} }),
        });

        await expect(
            resolver.resolve('HetznerNetwork', { name: 'prod' }, 'default'),
        ).rejects.toBeInstanceOf(DependencyNotReadyError);
    });

    it('reports a resource with an id but no Ready condition as not ready', async () => {
        const resolver = makeResolver({
            get: async () => ({
                metadata: { name: 'prod' },
                spec: {},
                status: { id: 1, message: 'still provisioning' },
            }),
        });

        await expect(
            resolver.resolve('HetznerNetwork', { name: 'prod' }, 'default'),
        ).rejects.toThrow(/still provisioning/);
    });

    it('honours an explicit namespace on the reference', async () => {
        const seen: string[] = [];
        const resolver = makeResolver({
            get: async (namespace) => {
                seen.push(namespace);
                return readyResource(1);
            },
        });

        await resolver.resolve('HetznerNetwork', { name: 'prod', namespace: 'other' }, 'default');
        expect(seen).toEqual(['other']);
    });

    it('resolves a list in order and reports the first failure', async () => {
        const resolver = makeResolver({
            get: async (_namespace, name) => (name === 'prod' ? readyResource(1) : null),
        });

        await expect(
            resolver.resolveAll(
                'HetznerNetwork',
                [{ name: 'prod' }, { name: 'missing-a' }, { name: 'missing-b' }],
                'default',
            ),
        ).rejects.toThrow(/missing-a/);
    });

    it('returns an empty list for an absent reference list', async () => {
        const resolver = makeResolver();
        expect(await resolver.resolveAll('HetznerNetwork', undefined, 'default')).toEqual([]);
    });

    it('fails loudly for a kind nobody registered', async () => {
        const resolver = createReferenceResolver(new Map());

        await expect(resolver.resolve('HetznerGhost', { name: 'x' }, 'default')).rejects.toThrow(
            /operator bug/,
        );
    });

    it('still resolves a raw id for an unregistered kind', async () => {
        // A raw id is already the answer, so it must not depend on the registry.
        const resolver = createReferenceResolver(new Map());

        expect(await resolver.resolve('HetznerGhost', { id: 7 }, 'default')).toBe(7);
    });

    it('rejects a reference with none of the three forms set', async () => {
        const resolver = makeResolver();

        await expect(resolver.resolve('HetznerNetwork', {}, 'default')).rejects.toThrow(
            /none of "name", "hetznerName" or "id"/,
        );
    });
});

describe('isDependencyError', () => {
    it('recognises both dependency errors and nothing else', () => {
        expect(isDependencyError(new DependencyMissingError('K', 'r'))).toBe(true);
        expect(isDependencyError(new DependencyNotReadyError('K', 'r', 'why'))).toBe(true);
        expect(isDependencyError(new Error('other'))).toBe(false);
    });
});

describe('describeRef', () => {
    it.each([
        [{ name: 'prod' }, 'prod'],
        [{ name: 'prod', namespace: 'other' }, 'other/prod'],
        [{ hetznerName: 'legacy' }, 'legacy'],
        [{ id: 42 }, '#42'],
        [{}, '<empty reference>'],
    ])('renders %o as %o', (ref, expected) => {
        expect(describeRef(ref)).toBe(expected);
    });
});
