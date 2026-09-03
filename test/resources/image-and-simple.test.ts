/**
 * The three remaining kinds: images, SSH keys and placement groups.
 *
 * Images are the odd one out — they cannot be created through the images
 * endpoint at all, only as a side effect of a server's `create_image` action —
 * so that indirection is what the tests here are mostly about.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createImageAdapter, type HetznerImageSpec } from '../../src/resources/image.js';
import {
    createPlacementGroupAdapter,
    type HetznerPlacementGroupSpec,
} from '../../src/resources/placement-group.js';
import { createServerAdapter } from '../../src/resources/server/index.js';
import { createSshKeyAdapter, type HetznerSSHKeySpec } from '../../src/resources/ssh-key.js';
import { buildResource } from '../support/fake-store.js';
import { createHarness, type Harness, type KindHarness } from '../support/harness.js';

let harness: Harness;

beforeEach(() => {
    harness = createHarness();
});

describe('HetznerSSHKey', () => {
    const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample admin@example.com';

    function keys(): KindHarness {
        return harness.register(createSshKeyAdapter(harness.hcloud.sshKeys));
    }

    function sshKey(spec: Partial<HetznerSSHKeySpec> = {}) {
        return buildResource<HetznerSSHKeySpec, never>('HetznerSSHKey', {
            publicKey: KEY,
            ...spec,
        });
    }

    it.each([
        ['ssh-rsa AAAAB3 user@host'],
        ['ssh-ed25519 AAAAC3 user@host'],
        ['ecdsa-sha2-nistp256 AAAAE2 user@host'],
        ['ssh-dss AAAAB3 user@host'],
    ])('accepts %o', async (publicKey) => {
        const harnessKeys = keys();
        await harnessKeys.settle(sshKey({ publicKey }));
        expect(harness.api.all('ssh_keys')).toHaveLength(1);
    });

    it.each([[''], ['not-a-key'], ['ssh-ed25519'], ['AAAAC3 no-algorithm']])(
        'rejects %o',
        async (publicKey) => {
            const harnessKeys = keys();
            const resource = sshKey({ publicKey });
            await harnessKeys.once(resource);
            expect(resource.status?.phase).toBe('Error');
        },
    );

    it('reports the fingerprint Hetzner computed', async () => {
        const harnessKeys = keys();
        const resource = sshKey();
        await harnessKeys.settle(resource);
        expect(resource.status?.fingerprint).toBeTruthy();
    });

    it('ignores a changed comment, which Hetzner does not store', async () => {
        const harnessKeys = keys();
        const resource = sshKey();
        await harnessKeys.settle(resource);

        resource.spec.publicKey = `${KEY.split(' ').slice(0, 2).join(' ')} someone-else@laptop`;
        await harnessKeys.settle(resource);

        expect(resource.status?.phase).toBe('Ready');
        expect(resource.status?.message).not.toMatch(/immutable/i);
    });

    it('reports a genuinely different key as immutable drift', async () => {
        const harnessKeys = keys();
        const resource = sshKey();
        await harnessKeys.settle(resource);

        resource.spec.publicKey = 'ssh-ed25519 AAAADifferentMaterial admin@example.com';
        await harnessKeys.once(resource);

        expect(resource.status?.message).toMatch(/immutable/);
    });
});

describe('HetznerPlacementGroup', () => {
    function groups(): KindHarness {
        return harness.register(createPlacementGroupAdapter(harness.hcloud.placementGroups));
    }

    it('defaults to the spread strategy', async () => {
        const harnessGroups = groups();
        const resource = buildResource<HetznerPlacementGroupSpec, never>(
            'HetznerPlacementGroup',
            {},
        );

        await harnessGroups.settle(resource);

        expect(resource.status).toMatchObject({ type: 'spread', serverCount: 0, phase: 'Ready' });
    });

    it('rejects a strategy Hetzner does not have', async () => {
        const harnessGroups = groups();
        const resource = buildResource<HetznerPlacementGroupSpec, never>('HetznerPlacementGroup', {
            type: 'pack' as never,
        });

        await harnessGroups.once(resource);

        expect(resource.status?.message).toMatch(/spec.type must be one of spread/);
    });

    it('reports the servers that ended up in it', async () => {
        const harnessGroups = groups();
        const resource = buildResource<HetznerPlacementGroupSpec, never>(
            'HetznerPlacementGroup',
            {},
        );
        await harnessGroups.settle(resource);

        (harness.api.all('placement_groups')[0] as Record<string, unknown>).servers = [1, 2, 3];
        await harnessGroups.settle(resource);

        expect(resource.status).toMatchObject({ serverIds: [1, 2, 3], serverCount: 3 });
        expect(resource.status?.message).toMatch(/holds 3 server/);
    });
});

describe('HetznerImage', () => {
    function images(): KindHarness {
        return harness.register(createImageAdapter(harness.hcloud.images, harness.hcloud.servers));
    }

    async function aServer(name = 'db-01') {
        const servers = harness.register(createServerAdapter(harness.hcloud.servers));
        const resource = buildResource(
            'HetznerServer',
            { serverType: 'cpx21', image: 'ubuntu-24.04', location: 'nbg1' },
            { name },
        );
        await servers.settle(resource);
        return resource;
    }

    /**
     * The snapshot. `all('images')` also holds Hetzner's system images, which
     * are present in every real project and are not ours.
     */
    const snapshot = () =>
        harness.api.all('images').find((entry) => entry.type === 'snapshot') as
            | Record<string, unknown>
            | undefined;

    function image(spec: Partial<HetznerImageSpec> = {}) {
        return buildResource<HetznerImageSpec, never>('HetznerImage', {
            sourceServerRef: { name: 'db-01' },
            ...spec,
        });
    }

    it('rejects a reference with none of the three forms set', async () => {
        const harnessImages = images();
        const resource = image({ sourceServerRef: {} });

        await harnessImages.once(resource);

        expect(resource.status?.message).toMatch(/must set one of "name", "hetznerName" or "id"/);
    });

    it('waits for the source server to be Ready', async () => {
        // Register the kind but create no server: the reference is resolvable in
        // principle and simply has nothing to point at yet.
        harness.register(createServerAdapter(harness.hcloud.servers));
        const harnessImages = images();
        const resource = image();

        const result = await harnessImages.once(resource);

        expect(result.requeueAfterMs).toBeGreaterThan(0);
        expect(snapshot()).toBeUndefined();
    });

    it('takes the snapshot through the server’s create_image action', async () => {
        const server = await aServer();
        const harnessImages = images();

        const resource = image({ description: 'pre-upgrade' });
        await harnessImages.settle(resource);

        expect(
            harness.api.countRequests(`POST /servers/${server.status?.id}/actions/create_image`),
        ).toBe(1);
        expect(resource.status).toMatchObject({
            description: 'pre-upgrade',
            createdFromServerId: server.status?.id,
            phase: 'Ready',
        });
    });

    it('falls back to the derived name when no description is given', async () => {
        await aServer();
        const harnessImages = images();

        const resource = image();
        await harnessImages.settle(resource);

        expect(resource.status?.description).toBe('default-example');
    });

    it('waits while Hetzner is still writing the snapshot', async () => {
        await aServer();
        const harnessImages = images();
        const resource = image();
        await harnessImages.settle(resource);

        const stored = snapshot();
        if (stored) {
            stored.status = 'creating';
        }
        const result = await harnessImages.once(resource);

        expect(result.requeueAfterMs).toBeGreaterThan(0);
        expect(resource.status?.phase).toBe('Creating');
    });

    it('updates the description in place', async () => {
        await aServer();
        const harnessImages = images();
        const resource = image({ description: 'first' });
        await harnessImages.settle(resource);

        resource.spec.description = 'second';
        await harnessImages.settle(resource);

        expect(snapshot()?.description).toBe('second');
    });

    it('applies delete protection', async () => {
        await aServer();
        const harnessImages = images();

        await harnessImages.settle(image({ protection: { delete: true } }));

        expect(snapshot()?.protection).toMatchObject({ delete: true });
    });

    it('reports a changed source as drift rather than retaking the snapshot', async () => {
        const server = await aServer();
        const harnessImages = images();
        const resource = image({ sourceServerRef: { id: server.status?.id ?? 0 } });
        await harnessImages.settle(resource);
        harness.api.reset();

        resource.spec.sourceServerRef = { id: 999 };
        await harnessImages.once(resource);

        expect(resource.status?.message).toMatch(/point in time/);
        expect(harness.api.countRequests('POST /servers/')).toBe(0);
    });
});
