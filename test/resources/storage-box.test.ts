/**
 * HetznerStorageBox: the password nobody keeps, the SSH keys that only count
 * at create, and the settings that converge afterwards.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createSshKeyAdapter, type HetznerSSHKeySpec } from '../../src/resources/ssh-key.js';
import {
    createStorageBoxAdapter,
    generatePassword,
    type HetznerStorageBoxSpec,
} from '../../src/resources/storage-box.js';
import { buildResource } from '../support/fake-store.js';
import { createHarness, type Harness, type KindHarness } from '../support/harness.js';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample admin@example.com';

let harness: Harness;
let boxes: KindHarness;

beforeEach(() => {
    harness = createHarness();
    boxes = harness.register(
        createStorageBoxAdapter(harness.hcloud.storageBoxes, harness.hcloud.sshKeys),
    );
});

function storageBox(spec: Partial<HetznerStorageBoxSpec> = {}) {
    return buildResource<HetznerStorageBoxSpec, never>('HetznerStorageBox', {
        storageBoxType: 'bx11',
        location: 'fsn1',
        ...spec,
    });
}

describe('HetznerStorageBox', () => {
    it('creates the box with the referenced public keys and the access settings', async () => {
        const keys = harness.register(createSshKeyAdapter(harness.hcloud.sshKeys));
        await keys.settle(
            buildResource<HetznerSSHKeySpec, never>(
                'HetznerSSHKey',
                { publicKey: KEY },
                { name: 'admin' },
            ),
        );

        const resource = storageBox({
            sshKeyRefs: [{ name: 'admin' }],
            accessSettings: { sshEnabled: true, sambaEnabled: false },
        });
        await boxes.settle(resource);

        const body = harness.api.lastBody('POST /storage_boxes') as Record<string, unknown>;
        expect(body).toMatchObject({
            storage_box_type: 'bx11',
            location: 'fsn1',
            ssh_keys: [KEY],
            access_settings: { ssh_enabled: true, samba_enabled: false },
        });
        expect(resource.status?.phase).toBe('Ready');
        expect(resource.status?.server).toMatch(/your-storagebox\.de$/);
    });

    it('sends a password that meets the policy, and keeps it nowhere', async () => {
        const resource = storageBox();
        await boxes.settle(resource);

        const body = harness.api.lastBody('POST /storage_boxes') as { password: string };
        expect(body.password).toMatch(/^[A-Za-z0-9\-_.!#%+]{48}$/);
        expect(JSON.stringify(resource)).not.toContain(body.password);
    });

    it('waits for an SSH key reference that does not exist yet', async () => {
        harness.register(createSshKeyAdapter(harness.hcloud.sshKeys));
        const resource = storageBox({ sshKeyRefs: [{ name: 'missing' }] });
        await boxes.once(resource);

        expect(harness.api.all('storage_boxes')).toHaveLength(0);
        expect(resource.status?.message).toMatch(/HetznerSSHKey "default\/missing"/);
    });

    it('converges access settings, type and protection on an existing box', async () => {
        const resource = storageBox({ accessSettings: { sshEnabled: true } });
        await boxes.settle(resource);

        resource.spec.accessSettings = { sshEnabled: true, zfsEnabled: true };
        resource.spec.storageBoxType = 'bx21';
        resource.spec.protection = { delete: true };
        await boxes.settle(resource);

        const [stored] = harness.api.all('storage_boxes');
        expect(stored?.access_settings).toMatchObject({ ssh_enabled: true, zfs_enabled: true });
        expect(stored?.storage_box_type).toMatchObject({ name: 'bx21' });
        expect(stored?.protection).toEqual({ delete: true });
    });

    it('leaves settings the spec does not mention alone', async () => {
        const resource = storageBox();
        await boxes.settle(resource);
        harness.api.reset();

        await boxes.settle(resource);

        expect(harness.api.countRequests('POST /storage_boxes/')).toBe(0);
    });

    it('reports a different location as immutable drift', async () => {
        const resource = storageBox();
        await boxes.settle(resource);

        resource.spec.location = 'nbg1';
        await boxes.once(resource);

        expect(resource.status?.message).toMatch(/Immutable field differs/);
    });

    it.each([
        [{ storageBoxType: '' }, /storageBoxType is required/],
        [{ location: '' }, /location is required/],
    ])('rejects %o', async (spec, message) => {
        const resource = storageBox(spec);
        await boxes.once(resource);

        expect(resource.status?.phase).toBe('Error');
        expect(resource.status?.message).toMatch(message);
    });
});

describe('generatePassword', () => {
    it('always has a lower, an upper, a digit and a special character', () => {
        for (let run = 0; run < 200; run += 1) {
            const password = generatePassword();
            expect(password).toHaveLength(48);
            expect(password).toMatch(/[a-z]/);
            expect(password).toMatch(/[A-Z]/);
            expect(password).toMatch(/[0-9]/);
            expect(password).toMatch(/[-_.!#%+]/);
        }
    });
});
