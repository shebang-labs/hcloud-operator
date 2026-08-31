/**
 * The operator is mostly wiring, so what is worth testing is the wiring itself:
 * that kind selection works, that every registered kind becomes a reference
 * target (otherwise cross-kind references break in ways only visible at
 * runtime), and that startup and shutdown are ordered correctly.
 */

import { describe, expect, it, vi } from 'vitest';
import type { KindRegistration } from '../../src/framework/operator.js';
import { defineKind, Operator, selectKinds } from '../../src/framework/operator.js';
import { createReferenceResolver } from '../../src/framework/references.js';
import type { RunnableController } from '../../src/framework/resource-controller.js';
import { createActionTracker } from '../../src/hcloud/actions.js';
import { assembleHetznerCloud } from '../../src/hcloud/index.js';
import { RateLimiter } from '../../src/hcloud/rate-limiter.js';
import type { KubernetesClients } from '../../src/kube/client.js';
import { nullLogger } from '../../src/observability/logger.js';
import { buildKinds } from '../../src/resources/index.js';
import { createSshKeyAdapter } from '../../src/resources/ssh-key.js';
import { FakeHetznerApi } from '../support/fake-hcloud.js';

function fakeKind(
    kind: string,
    plural: string,
    shortName: string,
    log?: string[],
): KindRegistration {
    const descriptor = { kind, plural, shortName };
    return {
        descriptor,
        build() {
            const controller: RunnableController = {
                kind,
                queueDepth: 0,
                synced: true,
                start: vi.fn(async () => {
                    log?.push(`start:${kind}`);
                }),
                stop: vi.fn(async () => {
                    log?.push(`stop:${kind}`);
                }),
            };
            return {
                controller,
                referenceTarget: {
                    descriptor,
                    get: async () => null,
                    remote: { get: async () => null, getByName: async () => null },
                },
            };
        },
    };
}

const clients = {} as KubernetesClients;

function makeOperator(kinds: KindRegistration[], enabledKinds?: string[]) {
    return new Operator({
        kinds,
        clients,
        logger: nullLogger,
        ...(enabledKinds ? { enabledKinds } : {}),
        resyncPeriodMs: 60_000,
        concurrency: 1,
        retryBaseDelayMs: 100,
        retryMaxDelayMs: 1_000,
    });
}

describe('selectKinds', () => {
    const kinds = [
        fakeKind('HetznerServer', 'hetznerservers', 'hsrv'),
        fakeKind('HetznerVolume', 'hetznervolumes', 'hvol'),
    ];

    it('returns everything when nothing is selected', () => {
        expect(selectKinds(kinds, undefined)).toHaveLength(2);
        expect(selectKinds(kinds, [])).toHaveLength(2);
    });

    it('matches on kind, plural or short name, case-insensitively', () => {
        expect(selectKinds(kinds, ['hetznerserver']).map((k) => k.descriptor.kind)).toEqual([
            'HetznerServer',
        ]);
        expect(selectKinds(kinds, ['hetznervolumes']).map((k) => k.descriptor.kind)).toEqual([
            'HetznerVolume',
        ]);
        expect(selectKinds(kinds, ['HSRV']).map((k) => k.descriptor.kind)).toEqual([
            'HetznerServer',
        ]);
    });

    it('drops names that match nothing', () => {
        expect(selectKinds(kinds, ['HetznerGhost'])).toHaveLength(0);
    });
});

describe('Operator', () => {
    it('refuses to start with no kinds selected, and says what was available', () => {
        expect(() =>
            makeOperator([fakeKind('HetznerServer', 'hetznerservers', 'hsrv')], ['Nope']),
        ).toThrow(/HetznerServer/);
    });

    it('starts controllers one at a time, so the first failure is attributable', async () => {
        const log: string[] = [];
        const operator = makeOperator([
            fakeKind('A', 'as', 'a', log),
            fakeKind('B', 'bs', 'b', log),
        ]);

        await operator.start();

        expect(log).toEqual(['start:A', 'start:B']);
        expect(operator.kinds).toEqual(['A', 'B']);
        expect(operator.synced).toBe(true);
    });

    it('is not synced before start or after stop', async () => {
        const operator = makeOperator([fakeKind('A', 'as', 'a')]);
        expect(operator.synced).toBe(false);

        await operator.start();
        expect(operator.synced).toBe(true);

        await operator.stop();
        expect(operator.synced).toBe(false);
    });

    it('stops every controller even when one of them throws', async () => {
        const log: string[] = [];
        const failing = fakeKind('Bad', 'bads', 'bad');
        const originalBuild = failing.build.bind(failing);
        failing.build = (environment) => {
            const built = originalBuild(environment);
            built.controller.stop = async () => {
                throw new Error('stubborn');
            };
            return built;
        };

        const operator = makeOperator([failing, fakeKind('Good', 'goods', 'good', log)]);
        await operator.start();

        await expect(operator.stop()).resolves.toBeUndefined();
        expect(log).toContain('stop:Good');
    });
});

describe('defineKind', () => {
    it('builds a controller and a reference target from one adapter', () => {
        const api = new FakeHetznerApi();
        const hcloud = assembleHetznerCloud({
            http: api,
            rateLimiter: new RateLimiter({ requestsPerHour: 3_600 }),
            actions: createActionTracker({ http: api, sleep: async () => undefined }),
        });
        const registration = defineKind(createSshKeyAdapter(hcloud.sshKeys));

        const built = registration.build({
            clients: { customObjects: {} } as unknown as KubernetesClients,
            logger: nullLogger,
            refs: createReferenceResolver(new Map()),
            resyncPeriodMs: 60_000,
            concurrency: 1,
            retryBaseDelayMs: 100,
            retryMaxDelayMs: 1_000,
        });

        expect(built.controller.kind).toBe('HetznerSSHKey');
        expect(built.controller.synced).toBe(false);
        expect(built.controller.queueDepth).toBe(0);
        // The reference target must expose the Hetzner API, or references to
        // unmanaged resources of this kind would fail at runtime only.
        expect(built.referenceTarget.descriptor.kind).toBe('HetznerSSHKey');
        expect(typeof built.referenceTarget.remote.getByName).toBe('function');
    });

    it('registers every kind as a reference target', () => {
        const api = new FakeHetznerApi();
        const hcloud = assembleHetznerCloud({
            http: api,
            rateLimiter: new RateLimiter({ requestsPerHour: 3_600 }),
            actions: createActionTracker({ http: api, sleep: async () => undefined }),
        });
        const registry = buildKinds({ hcloud, secrets: { read: async () => null } });

        const operator = new Operator({
            kinds: registry,
            clients: { customObjects: {} } as unknown as KubernetesClients,
            logger: nullLogger,
            resyncPeriodMs: 60_000,
            concurrency: 1,
            retryBaseDelayMs: 100,
            retryMaxDelayMs: 1_000,
        });

        // A kind missing from the resolver only shows up when something
        // references it, which may be days after the deploy.
        expect(operator.kinds).toHaveLength(registry.length);
    });
});
