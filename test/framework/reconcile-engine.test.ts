/**
 * The reconcile engine is the code every one of the twelve kinds runs through,
 * so its guarantees are tested once, here, against a deliberately trivial
 * adapter — the SSH key. What is being checked is never "does an SSH key work",
 * it is "does the framework hold its promises":
 *
 *   - a finalizer is added before anything is created;
 *   - a crash between create and status write cannot produce two resources;
 *   - deletion waits for confirmed absence before releasing the object;
 *   - Orphan leaves the Hetzner resource alone;
 *   - an invalid spec is a permanent condition, not a retry loop;
 *   - a missing dependency is a wait, not a failure.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { HetznerApiError } from '../../src/hcloud/errors.js';
import { FINALIZER, MANAGED_BY_VALUE, OwnerLabel } from '../../src/kube/api.js';
import {
    CONDITION_DEPENDENCIES_READY,
    CONDITION_READY,
    CONDITION_SYNCED,
} from '../../src/kube/conditions.js';
import { createServerAdapter } from '../../src/resources/server/index.js';
import type { HetznerServerSpec } from '../../src/resources/server/spec.js';
import { createSshKeyAdapter, type HetznerSSHKeySpec } from '../../src/resources/ssh-key.js';
import { buildResource } from '../support/fake-store.js';
import { createHarness, type Harness, type KindHarness } from '../support/harness.js';

const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterial admin@example.com';

function sshKey(spec: Partial<HetznerSSHKeySpec> = {}, options = {}) {
    return buildResource<HetznerSSHKeySpec, never>(
        'HetznerSSHKey',
        { publicKey: PUBLIC_KEY, ...spec },
        options,
    );
}

describe('ReconcileEngine', () => {
    let harness: Harness;
    let keys: KindHarness;

    beforeEach(() => {
        harness = createHarness();
        keys = harness.register(createSshKeyAdapter(harness.hcloud.sshKeys));
    });

    describe('finalizers', () => {
        it('adds the finalizer before creating anything in Hetzner', async () => {
            const resource = sshKey({}, { finalized: false });

            const result = await keys.once(resource);

            expect(resource.metadata?.finalizers).toContain(FINALIZER);
            // The pass stops right after the finalizer patch and asks to run
            // again, so a crash here cannot leave an unowned resource behind.
            expect(result.requeueAfterMs).toBe(0);
            expect(harness.api.all('ssh_keys')).toHaveLength(0);
        });

        it('creates the resource on the pass after the finalizer exists', async () => {
            const resource = sshKey({}, { finalized: false });

            await keys.once(resource);
            await keys.once(resource);

            expect(harness.api.all('ssh_keys')).toHaveLength(1);
        });
    });

    describe('creation', () => {
        it('records the Hetzner id and stamps the ownership labels', async () => {
            const resource = sshKey({}, { name: 'ops', namespace: 'demo' });

            await keys.settle(resource);

            const created = harness.api.all('ssh_keys')[0];
            expect(created?.name).toBe('demo-ops');
            expect(created?.labels).toMatchObject({
                [OwnerLabel.Uid]: resource.metadata?.uid,
                [OwnerLabel.Namespace]: 'demo',
                [OwnerLabel.Name]: 'ops',
                [OwnerLabel.Kind]: 'HetznerSSHKey',
            });
            expect(resource.status?.id).toBe(created?.id);
            expect(resource.status?.phase).toBe('Ready');
        });

        it('carries the user labels through alongside the ownership ones', async () => {
            await keys.settle(sshKey({ labels: { team: 'platform' } }));

            expect(harness.api.all('ssh_keys')[0]?.labels).toMatchObject({
                team: 'platform',
                [OwnerLabel.Kind]: 'HetznerSSHKey',
            });
        });

        it('never lets a user label overwrite an ownership label', async () => {
            // Losing the uid label would orphan the resource permanently.
            await keys.settle(sshKey({ labels: { [OwnerLabel.Uid]: 'hijacked' } }));

            expect(harness.api.all('ssh_keys')[0]?.labels).toMatchObject({
                [OwnerLabel.Uid]: expect.not.stringContaining('hijacked'),
            });
        });

        it('sets Ready and Synced to True', async () => {
            const resource = sshKey();
            await keys.settle(resource);

            expect(keys.store.condition('default', 'example', CONDITION_READY)?.status).toBe(
                'True',
            );
            expect(keys.store.condition('default', 'example', CONDITION_SYNCED)?.status).toBe(
                'True',
            );
        });
    });

    describe('crash recovery', () => {
        it('adopts its own orphan instead of creating a second resource', async () => {
            // Simulates a crash between "Hetzner created the key" and "status was
            // written": the resource exists and carries our uid, but the object
            // has no status.id.
            const resource = sshKey();
            harness.api.seed('ssh_keys', {
                name: 'default-example',
                public_key: PUBLIC_KEY,
                labels: { [OwnerLabel.Uid]: resource.metadata?.uid ?? '' },
            });

            await keys.settle(resource);

            expect(harness.api.all('ssh_keys')).toHaveLength(1);
            expect(harness.api.countRequests('POST /ssh_keys')).toBe(0);
        });

        it('adopts after a uniqueness_error rather than failing', async () => {
            // The name is taken by our own earlier attempt, but the list call
            // that would have found it raced. Hetzner answers uniqueness_error.
            const resource = sshKey();
            const seeded = harness.api.seed('ssh_keys', {
                name: 'default-example',
                public_key: PUBLIC_KEY,
                labels: {},
            });

            // First pass: no owner label yet, so the engine tries to create and
            // hits the name clash. Stamp the label so the recovery lookup finds it.
            seeded.labels = { [OwnerLabel.Uid]: resource.metadata?.uid ?? '' };
            harness.api.failNext({
                match: 'GET /ssh_keys',
                error: new HetznerApiError({
                    status: 500,
                    code: 'server_error',
                    message: 'transient',
                    retryable: true,
                }),
            });

            await expect(keys.once(resource)).rejects.toThrow();

            // Second pass succeeds through the owner-label lookup.
            await keys.settle(resource);
            expect(harness.api.all('ssh_keys')).toHaveLength(1);
        });

        it('re-finds the resource by owner label when status.id is stale', async () => {
            const resource = sshKey();
            await keys.settle(resource);
            const realId = resource.status?.id;

            // Something wrote a bogus id into status.
            if (resource.status) {
                resource.status.id = 999_999;
            }
            harness.api.reset();

            await keys.settle(resource);

            expect(resource.status?.id).toBe(realId);
            expect(harness.api.all('ssh_keys')).toHaveLength(1);
        });
    });

    describe('adoption', () => {
        it('takes over an unmanaged resource named by spec.adoptExisting', async () => {
            harness.api.seed('ssh_keys', {
                id: 4711,
                name: 'legacy-key',
                public_key: PUBLIC_KEY,
                labels: {},
            });

            const resource = sshKey({ adoptExisting: 'legacy-key' });
            await keys.settle(resource);

            expect(resource.status?.id).toBe(4711);
            expect(harness.api.countRequests('POST /ssh_keys')).toBe(0);
            expect(harness.api.peek('ssh_keys', 4711)?.labels).toMatchObject({
                [OwnerLabel.Uid]: resource.metadata?.uid,
            });
        });

        it('accepts a numeric id as well as a name', async () => {
            harness.api.seed('ssh_keys', { id: 4712, name: 'legacy', public_key: PUBLIC_KEY });

            const resource = sshKey({ adoptExisting: '4712' });
            await keys.settle(resource);

            expect(resource.status?.id).toBe(4712);
        });

        it('refuses to adopt a resource another object already owns', async () => {
            harness.api.seed('ssh_keys', {
                id: 4713,
                name: 'taken',
                public_key: PUBLIC_KEY,
                labels: { [OwnerLabel.Uid]: 'some-other-object' },
            });

            const resource = sshKey({ adoptExisting: 'taken' });

            await expect(keys.once(resource)).rejects.toThrow(/already managed by another/);
        });

        describe('a resource stamped by an object that may no longer exist', () => {
            const FORMER_OWNER_UID = 'former-owner-uid';

            /** Seeds a key carrying a full ownership stamp, with optional changes. */
            function seedStamped(
                stamp: Record<string, string | undefined> = {},
                id = 4800,
            ): string {
                const labels: Record<string, string | undefined> = {
                    [OwnerLabel.ManagedBy]: MANAGED_BY_VALUE,
                    [OwnerLabel.Uid]: FORMER_OWNER_UID,
                    [OwnerLabel.Namespace]: 'default',
                    [OwnerLabel.Name]: 'former-owner',
                    [OwnerLabel.Kind]: 'HetznerSSHKey',
                    ...stamp,
                };
                harness.api.seed('ssh_keys', {
                    id,
                    name: `stamped-${id}`,
                    public_key: PUBLIC_KEY,
                    labels: Object.fromEntries(
                        Object.entries(labels).filter(([, value]) => value !== undefined),
                    ),
                });
                return `stamped-${id}`;
            }

            it('adopts it when no object with that uid exists any more', async () => {
                const target = seedStamped();
                const resource = sshKey({ adoptExisting: target }, { name: 'new-owner' });

                await keys.settle(resource);

                expect(resource.status?.id).toBe(4800);
                expect(harness.api.peek('ssh_keys', 4800)?.labels).toMatchObject({
                    [OwnerLabel.Uid]: resource.metadata?.uid,
                    [OwnerLabel.Name]: 'new-owner',
                });
                expect(harness.events).toContainEqual(
                    expect.objectContaining({
                        reason: 'TookOverStaleOwnership',
                        message: expect.stringContaining(FORMER_OWNER_UID),
                    }),
                );
            });

            it('adopts it when the stamped name now belongs to a recreated object', async () => {
                const target = seedStamped();
                keys.store.add(sshKey({}, { name: 'former-owner', uid: 'recreated-uid' }));
                const resource = sshKey({ adoptExisting: target }, { name: 'new-owner' });

                await keys.settle(resource);

                expect(resource.status?.id).toBe(4800);
            });

            it('still refuses it while the owner exists', async () => {
                const target = seedStamped();
                keys.store.add(sshKey({}, { name: 'former-owner', uid: FORMER_OWNER_UID }));
                const resource = sshKey({ adoptExisting: target }, { name: 'new-owner' });

                await expect(keys.once(resource)).rejects.toMatchObject({
                    status: 409,
                    code: 'already_owned',
                });
            });

            it('finds a live owner by uid when the stamped name was truncated', async () => {
                const longName = 'a'.repeat(70);
                const target = seedStamped({ [OwnerLabel.Name]: longName.slice(0, 63) });
                keys.store.add(sshKey({}, { name: longName, uid: FORMER_OWNER_UID }));
                const resource = sshKey({ adoptExisting: target }, { name: 'new-owner' });

                await expect(keys.once(resource)).rejects.toMatchObject({ code: 'already_owned' });
            });

            it('finds a live owner whose name stamp was cut shorter than 63 characters', async () => {
                // Cutting at 63 leaves a trailing dash, which sanitizing then trims.
                const longName = `${'a'.repeat(62)}-b`;
                const target = seedStamped({ [OwnerLabel.Name]: 'a'.repeat(62) });
                keys.store.add(sshKey({}, { name: longName, uid: FORMER_OWNER_UID }));
                const resource = sshKey({ adoptExisting: target }, { name: 'new-owner' });

                await expect(keys.once(resource)).rejects.toMatchObject({ code: 'already_owned' });
            });

            it('finds a live owner by uid even when the stamp has no name label', async () => {
                const target = seedStamped({ [OwnerLabel.Name]: undefined });
                keys.store.add(sshKey({}, { name: 'former-owner', uid: FORMER_OWNER_UID }));
                const resource = sshKey({ adoptExisting: target }, { name: 'new-owner' });

                await expect(keys.once(resource)).rejects.toMatchObject({ code: 'already_owned' });
            });

            it('adopts a truncated stamp when no object has that uid', async () => {
                const target = seedStamped({ [OwnerLabel.Name]: 'a'.repeat(63) });
                keys.store.add(sshKey({}, { name: 'a'.repeat(70), uid: 'unrelated-uid' }));
                const resource = sshKey({ adoptExisting: target }, { name: 'new-owner' });

                await keys.settle(resource);

                expect(resource.status?.id).toBe(4800);
            });

            it('refuses when the lookup fails, for example a 403', async () => {
                const target = seedStamped({ [OwnerLabel.Namespace]: 'locked' });
                keys.store.forbiddenNamespaces.add('locked');
                const resource = sshKey({ adoptExisting: target }, { name: 'new-owner' });

                await expect(keys.once(resource)).rejects.toMatchObject({ code: 'already_owned' });
            });

            it('refuses when the stamp has no namespace label', async () => {
                const target = seedStamped({ [OwnerLabel.Namespace]: undefined });
                const resource = sshKey({ adoptExisting: target }, { name: 'new-owner' });

                await expect(keys.once(resource)).rejects.toMatchObject({ code: 'already_owned' });
            });

            it('refuses when the stamped namespace is not watched by this operator', async () => {
                const watching = createHarness();
                const scoped = watching.register(createSshKeyAdapter(watching.hcloud.sshKeys), {
                    watchNamespace: 'default',
                });
                watching.api.seed('ssh_keys', {
                    id: 4900,
                    name: 'elsewhere',
                    public_key: PUBLIC_KEY,
                    labels: {
                        [OwnerLabel.ManagedBy]: MANAGED_BY_VALUE,
                        [OwnerLabel.Uid]: FORMER_OWNER_UID,
                        [OwnerLabel.Namespace]: 'other',
                        [OwnerLabel.Name]: 'former-owner',
                        [OwnerLabel.Kind]: 'HetznerSSHKey',
                    },
                });
                const resource = sshKey({ adoptExisting: 'elsewhere' }, { name: 'new-owner' });

                await expect(scoped.once(resource)).rejects.toMatchObject({
                    code: 'already_owned',
                });
            });

            it('refuses when the stamp is for another kind', async () => {
                const target = seedStamped({ [OwnerLabel.Kind]: 'HetznerServer' });
                const resource = sshKey({ adoptExisting: target }, { name: 'new-owner' });

                await expect(keys.once(resource)).rejects.toMatchObject({ code: 'already_owned' });
            });
        });

        it('fails clearly when spec.adoptExisting names nothing', async () => {
            const resource = sshKey({ adoptExisting: 'does-not-exist' });

            await expect(keys.once(resource)).rejects.toThrow(/does not exist/);
        });
    });

    describe('deletion', () => {
        it('deletes the Hetzner resource, then releases the object', async () => {
            const resource = sshKey();
            await keys.settle(resource);
            expect(harness.api.all('ssh_keys')).toHaveLength(1);

            resource.metadata = {
                ...resource.metadata,
                deletionTimestamp: new Date().toISOString(),
            };

            // First pass issues the delete and asks to confirm.
            const first = await keys.once(resource);
            expect(first.requeueAfterMs).toBeGreaterThan(0);
            expect(harness.api.all('ssh_keys')).toHaveLength(0);
            expect(resource.metadata?.finalizers).toContain(FINALIZER);

            // Second pass confirms absence and removes the finalizer.
            await keys.once(resource);
            expect(resource.metadata?.finalizers ?? []).not.toContain(FINALIZER);
        });

        it('leaves the Hetzner resource alone with deletionPolicy: Orphan', async () => {
            const resource = sshKey({ deletionPolicy: 'Orphan' });
            await keys.settle(resource);

            resource.metadata = {
                ...resource.metadata,
                deletionTimestamp: new Date().toISOString(),
            };
            await keys.once(resource);

            expect(harness.api.all('ssh_keys')).toHaveLength(1);
            expect(resource.metadata?.finalizers ?? []).not.toContain(FINALIZER);
        });

        describe('with deletionPolicy: Orphan', () => {
            function startDeleting(resource: ReturnType<typeof sshKey>) {
                resource.metadata = {
                    ...resource.metadata,
                    deletionTimestamp: new Date().toISOString(),
                };
            }

            it('removes the ownership labels and keeps the user labels', async () => {
                const resource = sshKey({ deletionPolicy: 'Orphan', labels: { team: 'platform' } });
                await keys.settle(resource);
                const id = resource.status?.id as number;
                expect(harness.api.peek('ssh_keys', id)?.labels).toHaveProperty([OwnerLabel.Uid]);

                startDeleting(resource);
                await keys.once(resource);

                expect(harness.api.peek('ssh_keys', id)?.labels).toEqual({ team: 'platform' });
                expect(resource.metadata?.finalizers ?? []).not.toContain(FINALIZER);
            });

            it('releases the object when the Hetzner resource is already gone', async () => {
                const resource = sshKey({ deletionPolicy: 'Orphan' });
                await keys.settle(resource);
                const id = resource.status?.id as number;
                await harness.hcloud.sshKeys.delete(id);
                startDeleting(resource);

                await keys.once(resource);

                expect(resource.metadata?.finalizers ?? []).not.toContain(FINALIZER);
            });

            it('keeps the finalizer and retries when removing the labels fails', async () => {
                const resource = sshKey({ deletionPolicy: 'Orphan' });
                await keys.settle(resource);
                const id = resource.status?.id as number;
                startDeleting(resource);
                harness.api.failNext({
                    match: 'PUT /ssh_keys',
                    error: new HetznerApiError({
                        status: 500,
                        code: 'server_error',
                        message: 'boom',
                        retryable: true,
                    }),
                });

                await expect(keys.once(resource)).rejects.toThrow(/boom/);
                expect(resource.metadata?.finalizers).toContain(FINALIZER);
                expect(harness.api.peek('ssh_keys', id)?.labels).toHaveProperty([OwnerLabel.Uid]);

                await keys.once(resource);

                expect(harness.api.peek('ssh_keys', id)?.labels).toEqual({});
                expect(resource.metadata?.finalizers ?? []).not.toContain(FINALIZER);
            });

            it('lets a new object adopt the resource afterwards', async () => {
                const first = sshKey({ deletionPolicy: 'Orphan' }, { name: 'first' });
                await keys.settle(first);
                const id = first.status?.id as number;
                startDeleting(first);
                await keys.once(first);
                keys.store.drop('default', 'first');

                const second = sshKey({ adoptExisting: String(id) }, { name: 'second' });
                await keys.settle(second);

                expect(second.status?.id).toBe(id);
                expect(harness.api.all('ssh_keys')).toHaveLength(1);
                expect(harness.api.peek('ssh_keys', id)?.labels).toMatchObject({
                    [OwnerLabel.Uid]: second.metadata?.uid,
                    [OwnerLabel.Name]: 'second',
                });
            });

            it('does not touch a resource stamped by a different object', async () => {
                const resource = sshKey({ deletionPolicy: 'Orphan' });
                await keys.settle(resource);
                const id = resource.status?.id as number;
                const labels = harness.api.peek('ssh_keys', id)?.labels as Record<string, string>;
                labels[OwnerLabel.Uid] = 'some-other-object';
                startDeleting(resource);

                await keys.once(resource);

                expect(harness.api.peek('ssh_keys', id)?.labels).toHaveProperty(
                    [OwnerLabel.Uid],
                    'some-other-object',
                );
                expect(resource.metadata?.finalizers ?? []).not.toContain(FINALIZER);
            });
        });

        it('releases immediately when the Hetzner resource is already gone', async () => {
            const resource = sshKey({}, { deleting: true });

            await keys.once(resource);

            expect(resource.metadata?.finalizers ?? []).not.toContain(FINALIZER);
        });

        it('never adopts on the way to deletion', async () => {
            // A resource matching adoptExisting exists, but the object is being
            // deleted. Adopting it would delete something we were never given.
            harness.api.seed('ssh_keys', { id: 4714, name: 'bystander', public_key: PUBLIC_KEY });

            const resource = sshKey({ adoptExisting: 'bystander' }, { deleting: true });
            await keys.once(resource);

            expect(harness.api.peek('ssh_keys', 4714)).toBeDefined();
            expect(resource.metadata?.finalizers ?? []).not.toContain(FINALIZER);
        });

        it('does nothing for an object being deleted that has no finalizer', async () => {
            const resource = sshKey({}, { deleting: true, finalized: false });

            const result = await keys.once(resource);

            expect(result).toEqual({});
            expect(harness.api.requests).toHaveLength(0);
        });
    });

    describe('invalid specs', () => {
        it('reports a permanent condition and does not retry', async () => {
            const resource = sshKey({ publicKey: 'not-a-key' });

            const result = await keys.once(resource);

            expect(result.requeueAfterMs).toBeUndefined();
            expect(resource.status?.phase).toBe('Error');
            expect(keys.store.condition('default', 'example', CONDITION_SYNCED)).toMatchObject({
                status: 'False',
                reason: 'InvalidSpec',
            });
            expect(harness.api.requests).toHaveLength(0);
        });
    });

    describe('dependencies', () => {
        it('waits rather than failing when a referenced object does not exist', async () => {
            const servers = harness.register(createServerAdapter(harness.hcloud.servers));
            const resource = buildResource<HetznerServerSpec, never>('HetznerServer', {
                serverType: 'cpx21',
                image: 'ubuntu-24.04',
                location: 'nbg1',
                sshKeyRefs: [{ name: 'missing' }],
            });

            const result = await servers.once(resource);

            expect(result.requeueAfterMs).toBeGreaterThan(0);
            expect(resource.status?.phase).toBe('Pending');
            expect(
                servers.store.condition('default', 'example', CONDITION_DEPENDENCIES_READY),
            ).toMatchObject({ status: 'False', reason: 'DependencyMissing' });
            expect(harness.api.all('servers')).toHaveLength(0);
        });

        it('waits while a referenced object exists but is not Ready', async () => {
            const servers = harness.register(createServerAdapter(harness.hcloud.servers));
            // An SSH key object that has never been reconciled: no status.id.
            keys.store.add(sshKey({}, { name: 'ops' }));

            const resource = buildResource<HetznerServerSpec, never>('HetznerServer', {
                serverType: 'cpx21',
                image: 'ubuntu-24.04',
                location: 'nbg1',
                sshKeyRefs: [{ name: 'ops' }],
            });

            await servers.once(resource);

            expect(
                servers.store.condition('default', 'example', CONDITION_DEPENDENCIES_READY),
            ).toMatchObject({ status: 'False', reason: 'WaitingForDependency' });
        });

        it('proceeds once the dependency is Ready', async () => {
            const servers = harness.register(createServerAdapter(harness.hcloud.servers));
            await keys.settle(sshKey({}, { name: 'ops' }));

            const resource = buildResource<HetznerServerSpec, never>('HetznerServer', {
                serverType: 'cpx21',
                image: 'ubuntu-24.04',
                location: 'nbg1',
                sshKeyRefs: [{ name: 'ops' }],
            });
            await servers.settle(resource);

            expect(harness.api.all('servers')).toHaveLength(1);
            const body = harness.api.lastBody('POST /servers') as { ssh_keys?: number[] };
            expect(body.ssh_keys).toHaveLength(1);
        });
    });

    describe('failures', () => {
        it('writes the Hetzner error into status and rethrows', async () => {
            const resource = sshKey();
            harness.api.failNext({
                match: 'GET /ssh_keys',
                error: new HetznerApiError({
                    status: 403,
                    code: 'forbidden',
                    message: 'the token is read-only',
                    retryable: false,
                }),
            });

            await expect(keys.once(resource)).rejects.toThrow(/read-only/);

            await keys.engine.recordFailure(
                'default',
                'example',
                new Error('the token is read-only'),
            );
            expect(resource.status?.phase).toBe('Error');
            expect(resource.status?.message).toContain('read-only');
        });

        it('survives a status write that fails', async () => {
            const resource = sshKey();
            keys.store.failNextStatusPatch = new Error('conflict');

            // The status write failing must not swallow the reconcile.
            await expect(keys.once(resource)).rejects.toThrow('conflict');
        });
    });

    describe('label drift', () => {
        it('repairs ownership labels that were removed outside the operator', async () => {
            const resource = sshKey();
            await keys.settle(resource);
            const id = resource.status?.id ?? 0;

            // Someone cleared the labels in the Hetzner console.
            const stored = harness.api.peek('ssh_keys', id);
            if (stored) {
                stored.labels = {};
            }
            harness.api.reset();

            await keys.settle(resource);

            expect(harness.api.peek('ssh_keys', id)?.labels).toMatchObject({
                [OwnerLabel.Uid]: resource.metadata?.uid,
            });
        });
    });

    describe('events', () => {
        /** Reasons of the events recorded so far, in order. */
        const reasons = () => harness.events.map((event) => event.reason);

        it('records a Normal event when a resource is created', async () => {
            await keys.settle(sshKey());

            expect(harness.events).toContainEqual(
                expect.objectContaining({ type: 'Normal', reason: 'Created' }),
            );
        });

        it('records nothing on a steady-state pass', async () => {
            const resource = sshKey();
            await keys.settle(resource);
            harness.events.length = 0;

            await keys.once(resource);

            // A healthy cluster must not produce events on every resync, or the
            // namespace's event retention fills with noise.
            expect(harness.events).toEqual([]);
        });

        it('records a Warning when the spec is invalid', async () => {
            await keys.once(sshKey({ publicKey: 'nope' }));

            expect(harness.events).toContainEqual(
                expect.objectContaining({ type: 'Warning', reason: 'InvalidSpec' }),
            );
        });

        it('records adoption, deletion and orphaning', async () => {
            harness.api.seed('ssh_keys', { id: 5000, name: 'legacy', public_key: PUBLIC_KEY });
            const adopted = sshKey({ adoptExisting: 'legacy' }, { name: 'adopted' });
            await keys.settle(adopted);
            expect(reasons()).toContain('Adopted');

            harness.events.length = 0;
            adopted.metadata = { ...adopted.metadata, deletionTimestamp: new Date().toISOString() };
            await keys.once(adopted);
            expect(reasons()).toContain('Deleting');

            harness.events.length = 0;
            const orphan = sshKey({ deletionPolicy: 'Orphan' }, { name: 'orphan' });
            await keys.settle(orphan);
            harness.events.length = 0;
            orphan.metadata = { ...orphan.metadata, deletionTimestamp: new Date().toISOString() };
            await keys.once(orphan);
            expect(harness.events).toContainEqual(
                expect.objectContaining({ type: 'Warning', reason: 'Orphaned' }),
            );
        });

        it('records a Warning when a change is blocked on a missing guard', async () => {
            const servers = harness.register(createServerAdapter(harness.hcloud.servers));
            const resource = buildResource<HetznerServerSpec, never>('HetznerServer', {
                serverType: 'cpx21',
                image: 'ubuntu-24.04',
                location: 'nbg1',
            });
            await servers.settle(resource);
            harness.events.length = 0;

            resource.spec.serverType = 'cpx31';
            await servers.once(resource);

            expect(harness.events).toContainEqual(
                expect.objectContaining({ type: 'Warning', reason: 'GuardRequired' }),
            );
        });
    });
});
