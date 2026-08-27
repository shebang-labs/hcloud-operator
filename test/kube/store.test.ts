/**
 * The real `ResourceStore`, against a stand-in for the Kubernetes API.
 *
 * Everything else in the suite runs on an in-memory fake store, so this is the
 * one place the actual API calls are checked: that status goes to the /status
 * subresource, that finalizer patches carry a resourceVersion (making them
 * compare-and-swap), and that a 404 is an answer rather than an exception.
 */

import { ApiException, type CustomObjectsApi } from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';
import { FINALIZER, GROUP, VERSION } from '../../src/kube/api.js';
import { createResourceStore, isConflictError, isNotFoundError } from '../../src/kube/store.js';

const descriptor = { kind: 'HetznerServer', plural: 'hetznerservers', shortName: 'hsrv' };

interface Call {
    method: string;
    args: Record<string, unknown>;
}

function fakeApi(overrides: Partial<Record<string, unknown>> = {}) {
    const calls: Call[] = [];
    const record =
        (method: string, result: unknown = {}) =>
        async (args: Record<string, unknown>) => {
            calls.push({ method, args });
            if (typeof result === 'function') {
                return (result as (a: Record<string, unknown>) => unknown)(args);
            }
            return result;
        };

    const api = {
        getNamespacedCustomObject: record('get', { metadata: { name: 'web-01' } }),
        listNamespacedCustomObject: record('listNamespaced', { items: [{ metadata: {} }] }),
        listCustomObjectForAllNamespaces: record('listAll', { items: [{ metadata: {} }, {}] }),
        patchNamespacedCustomObjectStatus: record('patchStatus', { metadata: {} }),
        patchNamespacedCustomObject: record('patch', {}),
        ...overrides,
    } as unknown as CustomObjectsApi;

    return { api, calls };
}

function notFound() {
    return new ApiException(404, 'not found', '', {});
}

describe('createResourceStore', () => {
    it('addresses the right group, version and plural', async () => {
        const { api, calls } = fakeApi();

        await createResourceStore(api, descriptor).get('demo', 'web-01');

        expect(calls[0]?.args).toMatchObject({
            group: GROUP,
            version: VERSION,
            plural: 'hetznerservers',
            namespace: 'demo',
            name: 'web-01',
        });
    });

    it('returns null for a missing object rather than throwing', async () => {
        const { api } = fakeApi({
            getNamespacedCustomObject: async () => {
                throw notFound();
            },
        });

        expect(await createResourceStore(api, descriptor).get('default', 'gone')).toBeNull();
    });

    it('lets a real API error through', async () => {
        const { api } = fakeApi({
            getNamespacedCustomObject: async () => {
                throw new ApiException(500, 'boom', '', {});
            },
        });

        await expect(createResourceStore(api, descriptor).get('default', 'x')).rejects.toThrow();
    });

    it('lists one namespace or all of them, depending on the argument', async () => {
        const { api, calls } = fakeApi();
        const store = createResourceStore(api, descriptor);

        await store.list('demo');
        await store.list();

        expect(calls.map((call) => call.method)).toEqual(['listNamespaced', 'listAll']);
        // The cluster-wide call uses a different parameter name in the client.
        expect(calls[1]?.args).toMatchObject({ resourcePlural: 'hetznerservers' });
    });

    it('returns an empty list when the response has no items', async () => {
        const { api } = fakeApi({ listNamespacedCustomObject: async () => ({}) });

        expect(await createResourceStore(api, descriptor).list('default')).toEqual([]);
    });

    it('writes status to the /status subresource as a merge patch', async () => {
        const { api, calls } = fakeApi();

        await createResourceStore(api, descriptor).patchStatus('default', 'web-01', {
            phase: 'Ready',
            id: 4711,
        });

        expect(calls[0]?.method).toBe('patchStatus');
        expect(calls[0]?.args).toMatchObject({ body: { status: { phase: 'Ready', id: 4711 } } });
    });

    it('returns null when the object was deleted mid-reconcile', async () => {
        const { api } = fakeApi({
            patchNamespacedCustomObjectStatus: async () => {
                throw notFound();
            },
        });

        expect(
            await createResourceStore(api, descriptor).patchStatus('default', 'x', {}),
        ).toBeNull();
    });

    describe('finalizers', () => {
        const resource = {
            metadata: {
                namespace: 'default',
                name: 'web-01',
                resourceVersion: '42',
                finalizers: [],
            },
            spec: {},
        };

        it('adds ours and keeps the ones already there', async () => {
            const { api, calls } = fakeApi();
            const store = createResourceStore(api, descriptor);

            const patched = await store.addFinalizer({
                ...resource,
                metadata: { ...resource.metadata, finalizers: ['other/finalizer'] },
            });

            expect(patched).toBe(true);
            expect(calls[0]?.args).toMatchObject({
                body: {
                    metadata: {
                        // Compare-and-swap: a concurrent writer gets a 409 and we
                        // simply reconcile again.
                        resourceVersion: '42',
                        finalizers: ['other/finalizer', FINALIZER],
                    },
                },
            });
        });

        it('does nothing when ours is already present', async () => {
            const { api, calls } = fakeApi();
            const store = createResourceStore(api, descriptor);

            const patched = await store.addFinalizer({
                ...resource,
                metadata: { ...resource.metadata, finalizers: [FINALIZER] },
            });

            expect(patched).toBe(false);
            expect(calls).toHaveLength(0);
        });

        it('removes only ours', async () => {
            const { api, calls } = fakeApi();
            const store = createResourceStore(api, descriptor);

            await store.removeFinalizer({
                ...resource,
                metadata: { ...resource.metadata, finalizers: [FINALIZER, 'other/finalizer'] },
            });

            expect(calls[0]?.args).toMatchObject({
                body: { metadata: { finalizers: ['other/finalizer'] } },
            });
        });

        it('does nothing when ours is not there', async () => {
            const { api, calls } = fakeApi();

            expect(await createResourceStore(api, descriptor).removeFinalizer(resource)).toBe(
                false,
            );
            expect(calls).toHaveLength(0);
        });

        it('treats a vanished object as nothing left to do', async () => {
            const { api } = fakeApi({
                patchNamespacedCustomObject: async () => {
                    throw notFound();
                },
            });

            const patched = await createResourceStore(api, descriptor).removeFinalizer({
                ...resource,
                metadata: { ...resource.metadata, finalizers: [FINALIZER] },
            });

            expect(patched).toBe(false);
        });

        it('refuses to patch an object with no namespace or name', async () => {
            const { api } = fakeApi();

            await expect(
                createResourceStore(api, descriptor).addFinalizer({ metadata: {}, spec: {} }),
            ).rejects.toThrow(/without namespace and name/);
        });

        it('lets a conflict through, so the caller can retry', async () => {
            const { api } = fakeApi({
                patchNamespacedCustomObject: async () => {
                    throw new ApiException(409, 'conflict', '', {});
                },
            });

            await expect(
                createResourceStore(api, descriptor).addFinalizer(resource),
            ).rejects.toThrow();
        });
    });

    it('honours a descriptor that pins its own group and version', async () => {
        const { api, calls } = fakeApi();

        await createResourceStore(api, { ...descriptor, group: 'other.io', version: 'v1' }).get(
            'default',
            'x',
        );

        expect(calls[0]?.args).toMatchObject({ group: 'other.io', version: 'v1' });
    });
});

describe('error predicates', () => {
    it('recognise 404 and 409, and nothing else', () => {
        expect(isNotFoundError(notFound())).toBe(true);
        expect(isNotFoundError(new ApiException(409, 'c', '', {}))).toBe(false);
        expect(isNotFoundError(new Error('plain'))).toBe(false);

        expect(isConflictError(new ApiException(409, 'c', '', {}))).toBe(true);
        expect(isConflictError(notFound())).toBe(false);
        expect(isConflictError(undefined)).toBe(false);
    });
});

describe('the patch content type', () => {
    it('is passed as request options, or the API server would reject the body', async () => {
        // A custom-object patch defaults to a strategic merge patch, which the
        // API server does not support for CRDs. The client expresses the
        // override as request middleware, so what is checked here is that the
        // second argument is present and carries some.
        const patch = vi.fn(async () => ({}));
        const { api } = fakeApi({ patchNamespacedCustomObject: patch });

        await createResourceStore(api, descriptor).addFinalizer({
            metadata: { namespace: 'default', name: 'x', finalizers: [] },
            spec: {},
        });

        const options = patch.mock.calls[0]?.[1] as { middleware?: unknown[] } | undefined;
        expect(options).toBeDefined();
        expect(options?.middleware?.length).toBeGreaterThan(0);
    });

    it('uses the same options object for a status patch', async () => {
        const patchStatus = vi.fn(async () => ({}));
        const { api } = fakeApi({ patchNamespacedCustomObjectStatus: patchStatus });

        await createResourceStore(api, descriptor).patchStatus('default', 'x', { phase: 'Ready' });

        expect(patchStatus.mock.calls[0]).toHaveLength(2);
    });
});
