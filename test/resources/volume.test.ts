/**
 * Volumes are where a careless controller destroys data, so the tests lean
 * hard on the refusals: never shrink, never detach without being told to, and
 * never leave a volume attached when the object is deleted.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { CONDITION_SYNCED } from '../../src/kube/conditions.js';
import { createServerAdapter } from '../../src/resources/server/index.js';
import { createVolumeAdapter, type HetznerVolumeSpec } from '../../src/resources/volume.js';
import { buildResource } from '../support/fake-store.js';
import { createHarness, type Harness, type KindHarness } from '../support/harness.js';

function volume(spec: Partial<HetznerVolumeSpec> = {}, options = {}) {
    return buildResource<HetznerVolumeSpec, never>(
        'HetznerVolume',
        { size: 50, location: 'nbg1', ...spec },
        options,
    );
}

let harness: Harness;
let volumes: KindHarness;

beforeEach(() => {
    harness = createHarness();
    volumes = harness.register(createVolumeAdapter(harness.hcloud.volumes));
});

const only = () => harness.api.all('volumes')[0] as Record<string, unknown>;

describe('validation', () => {
    it.each([
        [{ size: 5 }, /at least 10/],
        [{ size: 10.5 }, /whole number of GB/],
        [{ format: 'btrfs' }, /"ext4" or "xfs"/],
        [{ location: undefined }, /one of spec.location or spec.serverRef/],
    ])('rejects %o', async (spec, expected) => {
        const resource = volume(spec);
        await volumes.once(resource);
        expect(resource.status?.message).toMatch(expected);
    });
});

describe('creation', () => {
    it('creates a detached volume in a location', async () => {
        const resource = volume({ format: 'ext4' });
        await volumes.settle(resource);

        expect(resource.status).toMatchObject({
            size: 50,
            location: 'nbg1',
            format: 'ext4',
            attached: false,
            phase: 'Ready',
        });
    });

    it('creates it attached when a server is referenced', async () => {
        const servers = harness.register(createServerAdapter(harness.hcloud.servers));
        const serverResource = buildResource(
            'HetznerServer',
            { serverType: 'cpx21', image: 'ubuntu-24.04', location: 'nbg1' },
            { name: 'db-01' },
        );
        await servers.settle(serverResource);

        const resource = volume({ location: undefined, serverRef: { name: 'db-01' } });
        await volumes.settle(resource);

        expect(resource.status?.attachedToServerId).toBe(serverResource.status?.id);
    });

    it('waits while Hetzner is still provisioning', async () => {
        const resource = volume();
        await volumes.settle(resource);
        only().status = 'creating';

        const result = await volumes.once(resource);

        expect(result.requeueAfterMs).toBeGreaterThan(0);
        expect(resource.status?.phase).toBe('Creating');
    });
});

describe('resizing', () => {
    it('grows without needing a guard, since growing is online and safe', async () => {
        const resource = volume();
        await volumes.settle(resource);

        resource.spec.size = 100;
        await volumes.settle(resource);

        expect(only().size).toBe(100);
    });

    it('refuses to shrink and says what to do instead', async () => {
        const resource = volume({ size: 100 });
        await volumes.settle(resource);
        harness.api.reset();

        resource.spec.size = 50;
        await volumes.once(resource);

        expect(only().size).toBe(100);
        expect(resource.status?.message).toMatch(/cannot shrink/);
        expect(volumes.store.condition('default', 'example', CONDITION_SYNCED)?.status).toBe(
            'False',
        );
    });
});

describe('attachment', () => {
    it('attaches a detached volume without a guard', async () => {
        const resource = volume();
        await volumes.settle(resource);

        resource.spec.serverRef = { id: 7 };
        await volumes.settle(resource);

        expect(only().server).toBe(7);
    });

    it('refuses to move an attached volume without allowDetach', async () => {
        const resource = volume({ serverRef: { id: 7 } });
        await volumes.settle(resource);
        harness.api.reset();

        resource.spec.serverRef = { id: 8 };
        await volumes.once(resource);

        expect(only().server).toBe(7);
        expect(resource.status?.message).toMatch(/allowDetach/);
    });

    it('moves it when allowDetach is set', async () => {
        const resource = volume({ serverRef: { id: 7 }, allowDetach: true });
        await volumes.settle(resource);

        resource.spec.serverRef = { id: 8 };
        await volumes.settle(resource);

        expect(only().server).toBe(8);
    });

    it('detaches when the reference is removed and allowDetach is set', async () => {
        const resource = volume({ serverRef: { id: 7 }, allowDetach: true });
        await volumes.settle(resource);

        resource.spec.serverRef = undefined;
        await volumes.settle(resource);

        expect(only().server).toBeNull();
    });
});

describe('deletion', () => {
    it('detaches before deleting, so Hetzner does not answer with a bare conflict', async () => {
        const resource = volume({ serverRef: { id: 7 } });
        await volumes.settle(resource);
        const id = resource.status?.id;
        harness.api.reset();

        resource.metadata = { ...resource.metadata, deletionTimestamp: new Date().toISOString() };
        await volumes.once(resource);

        expect(harness.api.countRequests(`POST /volumes/${id}/actions/detach`)).toBe(1);
        expect(harness.api.all('volumes')).toHaveLength(0);
    });

    it('keeps the volume with deletionPolicy: Orphan', async () => {
        const resource = volume({ deletionPolicy: 'Orphan' });
        await volumes.settle(resource);

        resource.metadata = { ...resource.metadata, deletionTimestamp: new Date().toISOString() };
        await volumes.once(resource);

        expect(harness.api.all('volumes')).toHaveLength(1);
    });
});

describe('protection and drift', () => {
    it('applies delete protection', async () => {
        await volumes.settle(volume({ protection: { delete: true } }));

        expect(only().protection).toMatchObject({ delete: true });
    });

    it('reports a location change it cannot apply', async () => {
        const resource = volume();
        await volumes.settle(resource);

        resource.spec.location = 'fsn1';
        await volumes.once(resource);

        expect(resource.status?.message).toMatch(/data will not survive/);
    });

    it('reports a format change it cannot apply', async () => {
        const resource = volume({ format: 'ext4' });
        await volumes.settle(resource);

        resource.spec.format = 'xfs';
        await volumes.once(resource);

        expect(resource.status?.message).toMatch(/Immutable fields differ/);
    });
});
