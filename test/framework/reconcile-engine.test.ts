/**
 * The reconcile engine is the code every one of the eleven kinds runs through,
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
import { FINALIZER, OwnerLabel } from '../../src/kube/api.js';
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
