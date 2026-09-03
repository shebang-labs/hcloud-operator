/**
 * Load balancers have three list-shaped parts (services, targets, networks) and
 * no way to PUT a desired configuration, so the adapter diffs each one. The
 * tests below are mostly about the diff being *stable*: re-reconciling an
 * unchanged spec must issue no calls at all, or every resync would churn the
 * configuration of a live load balancer.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { LoadBalancerService, LoadBalancerTarget } from '../../src/hcloud/types.js';
import { createCertificateAdapter } from '../../src/resources/certificate.js';
import {
    countHealthyTargets,
    createLoadBalancerAdapter,
    type HetznerLoadBalancerSpec,
    servicesMatch,
    targetKey,
} from '../../src/resources/load-balancer.js';
import { createServerAdapter } from '../../src/resources/server/index.js';
import { buildResource } from '../support/fake-store.js';
import { createHarness, type Harness, type KindHarness } from '../support/harness.js';

function balancer(spec: Partial<HetznerLoadBalancerSpec> = {}, options = {}) {
    return buildResource<HetznerLoadBalancerSpec, never>(
        'HetznerLoadBalancer',
        { loadBalancerType: 'lb11', location: 'nbg1', ...spec },
        options,
    );
}

const httpService = {
    protocol: 'http' as const,
    listenPort: 80,
    destinationPort: 8080,
};

let harness: Harness;
let balancers: KindHarness;

beforeEach(() => {
    harness = createHarness();
    balancers = harness.register(createLoadBalancerAdapter(harness.hcloud.loadBalancers));
});

const only = () => harness.api.all('load_balancers')[0] as Record<string, unknown>;

describe('validation', () => {
    it.each([
        [{ loadBalancerType: '' }, /loadBalancerType is required/],
        [{ location: undefined }, /one of spec.location or spec.networkZone/],
        [{ algorithm: 'random' as never }, /algorithm must be one of/],
    ])('rejects %o', async (spec, expected) => {
        const resource = balancer(spec);
        await balancers.once(resource);
        expect(resource.status?.message).toMatch(expected);
    });

    it('rejects two services on the same listen port', async () => {
        const resource = balancer({ services: [httpService, { ...httpService }] });
        await balancers.once(resource);
        expect(resource.status?.message).toMatch(/declared twice/);
    });

    it('requires a certificate for an https service', async () => {
        const resource = balancer({
            services: [{ protocol: 'https', listenPort: 443, destinationPort: 80 }],
        });
        await balancers.once(resource);
        expect(resource.status?.message).toMatch(/sets no http.certificateRefs/);
    });

    it('rejects certificates on a non-https service', async () => {
        const resource = balancer({
            services: [{ ...httpService, http: { certificateRefs: [{ id: 1 }] } }],
        });
        await balancers.once(resource);
        expect(resource.status?.message).toMatch(/certificates only apply to https/);
    });

    it('requires exactly one of serverRef, labelSelector or ip on a target', async () => {
        const none = balancer({ targets: [{}] });
        await balancers.once(none);
        expect(none.status?.message).toMatch(/exactly one of serverRef, labelSelector or ip/);

        const both = balancer({ targets: [{ ip: '1.2.3.4', labelSelector: 'a=b' }] });
        await balancers.once(both);
        expect(both.status?.message).toMatch(/exactly one of/);
    });
});

describe('creation', () => {
    it('reports the address and becomes Ready', async () => {
        const resource = balancer({ services: [httpService] });
        await balancers.settle(resource);

        expect(resource.status).toMatchObject({
            loadBalancerType: 'lb11',
            algorithm: 'round_robin',
            serviceCount: 1,
            phase: 'Ready',
        });
        expect(resource.status?.ipv4).toBeTruthy();
    });

    it('defaults a health check so a minimal service is accepted', async () => {
        await balancers.settle(balancer({ services: [httpService] }));

        const services = only().services as LoadBalancerService[];
        expect(services[0]?.health_check).toMatchObject({
            protocol: 'tcp',
            port: 8080,
            interval: 15,
            timeout: 10,
            retries: 3,
        });
    });

    it('builds an http health check with sensible defaults', async () => {
        await balancers.settle(
            balancer({
                services: [{ ...httpService, healthCheck: { protocol: 'http', port: 8080 } }],
            }),
        );

        const services = only().services as LoadBalancerService[];
        expect(services[0]?.health_check?.http).toMatchObject({
            path: '/',
            status_codes: ['2??', '3??'],
        });
    });

    it('resolves certificate references for an https service', async () => {
        const certificates = harness.register(
            createCertificateAdapter(harness.hcloud.certificates, { read: async () => 'pem' }),
        );
        const certificate = buildResource(
            'HetznerCertificate',
            { type: 'managed' as const, domainNames: ['example.com'] },
            { name: 'tls' },
        );
        await certificates.settle(certificate);
        // A managed certificate only becomes Ready once Hetzner finishes issuance.
        const stored = harness.api.all('certificates')[0] as Record<string, unknown>;
        stored.status = { issuance: 'completed', renewal: 'scheduled', error: null };
        await certificates.settle(certificate);

        await balancers.settle(
            balancer({
                services: [
                    {
                        protocol: 'https',
                        listenPort: 443,
                        destinationPort: 80,
                        http: { certificateRefs: [{ name: 'tls' }], redirectHttp: true },
                    },
                ],
            }),
        );

        const services = only().services as LoadBalancerService[];
        expect(services[0]?.http?.certificates).toEqual([certificate.status?.id]);
        expect(services[0]?.http?.redirect_http).toBe(true);
    });

    it('creates an internal-only load balancer without a public IP', async () => {
        const resource = balancer({
            location: undefined,
            networkZone: 'eu-central',
            publicInterface: false,
            networkRef: { id: 10 },
        });

        await balancers.settle(resource);

        expect(resource.status?.privateIps).toHaveLength(1);
        // Readiness comes from the private address, not a public one it will
        // never get.
        expect(resource.status?.phase).toBe('Ready');
    });
});

describe('services', () => {
    it('adds a service that was appended', async () => {
        const resource = balancer({ services: [httpService] });
        await balancers.settle(resource);

        resource.spec.services?.push({ protocol: 'tcp', listenPort: 8443, destinationPort: 8443 });
        await balancers.settle(resource);

        expect(only().services).toHaveLength(2);
    });

    it('deletes a service that was removed', async () => {
        const resource = balancer({
            services: [httpService, { protocol: 'tcp', listenPort: 8443, destinationPort: 8443 }],
        });
        await balancers.settle(resource);

        resource.spec.services = [httpService];
        await balancers.settle(resource);

        expect(only().services).toHaveLength(1);
    });

    it('updates a service in place rather than deleting and re-adding it', async () => {
        const resource = balancer({ services: [httpService] });
        await balancers.settle(resource);
        const id = resource.status?.id;
        harness.api.reset();

        resource.spec.services = [{ ...httpService, destinationPort: 9090 }];
        await balancers.settle(resource);

        expect(harness.api.countRequests(`POST /load_balancers/${id}/actions/update_service`)).toBe(
            1,
        );
        expect(harness.api.countRequests(`POST /load_balancers/${id}/actions/delete_service`)).toBe(
            0,
        );
    });

    it('issues nothing when the services already match', async () => {
        const resource = balancer({ services: [httpService] });
        await balancers.settle(resource);
        harness.api.reset();

        await balancers.settle(resource);

        expect(harness.api.countRequests('POST /load_balancers/')).toBe(0);
    });
});

describe('targets', () => {
    it('adds a label-selector target', async () => {
        const resource = balancer({ targets: [{ labelSelector: 'role=web', usePrivateIp: true }] });
        await balancers.settle(resource);

        expect(resource.status?.targetCount).toBe(1);
    });

    it('resolves a server reference', async () => {
        const servers = harness.register(createServerAdapter(harness.hcloud.servers));
        const serverResource = buildResource(
            'HetznerServer',
            { serverType: 'cpx21', image: 'ubuntu-24.04', location: 'nbg1' },
            { name: 'web-01' },
        );
        await servers.settle(serverResource);

        await balancers.settle(balancer({ targets: [{ serverRef: { name: 'web-01' } }] }));

        const targets = only().targets as LoadBalancerTarget[];
        expect(targets[0]?.server?.id).toBe(serverResource.status?.id);
    });

    it('removes a target that left the spec', async () => {
        const resource = balancer({
            targets: [{ labelSelector: 'role=web' }, { ip: '203.0.113.9' }],
        });
        await balancers.settle(resource);

        resource.spec.targets = [{ labelSelector: 'role=web' }];
        await balancers.settle(resource);

        expect(only().targets).toHaveLength(1);
    });

    it('re-adds a target whose usePrivateIp changed', async () => {
        const resource = balancer({ targets: [{ labelSelector: 'role=web' }] });
        await balancers.settle(resource);
        const id = resource.status?.id;
        harness.api.reset();

        resource.spec.targets = [{ labelSelector: 'role=web', usePrivateIp: true }];
        await balancers.settle(resource);

        expect(harness.api.countRequests(`POST /load_balancers/${id}/actions/add_target`)).toBe(1);
        expect(only().targets).toHaveLength(1);
    });

    it('issues nothing when the targets already match', async () => {
        const resource = balancer({ targets: [{ labelSelector: 'role=web' }] });
        await balancers.settle(resource);
        harness.api.reset();

        await balancers.settle(resource);

        expect(harness.api.countRequests('POST /load_balancers/')).toBe(0);
    });
});

describe('type, algorithm and network', () => {
    it('changes the type online, with no guard needed', async () => {
        const resource = balancer();
        await balancers.settle(resource);

        resource.spec.loadBalancerType = 'lb21';
        await balancers.settle(resource);

        expect(only().load_balancer_type).toMatchObject({ name: 'lb21' });
    });

    it('changes the algorithm', async () => {
        const resource = balancer();
        await balancers.settle(resource);

        resource.spec.algorithm = 'least_connections';
        await balancers.settle(resource);

        expect(only().algorithm).toEqual({ type: 'least_connections' });
    });

    it('attaches to and detaches from a private network', async () => {
        const resource = balancer();
        await balancers.settle(resource);

        resource.spec.networkRef = { id: 10 };
        await balancers.settle(resource);
        expect(only().private_net).toHaveLength(1);

        resource.spec.networkRef = undefined;
        await balancers.settle(resource);
        expect(only().private_net).toHaveLength(0);
    });

    it('toggles the public interface', async () => {
        const resource = balancer({ networkRef: { id: 10 } });
        await balancers.settle(resource);

        resource.spec.publicInterface = false;
        await balancers.settle(resource);

        expect((only().public_net as { enabled: boolean }).enabled).toBe(false);
    });
});

describe('drift', () => {
    it('reports a location change it cannot apply', async () => {
        const resource = balancer();
        await balancers.settle(resource);

        resource.spec.location = 'fsn1';
        await balancers.once(resource);

        expect(resource.status?.message).toMatch(/IP addresses will change/);
    });
});

describe('countHealthyTargets', () => {
    it('counts a target with no health status as healthy', () => {
        // A freshly added target has not been checked yet; calling it unhealthy
        // would make a working load balancer look broken for a few seconds.
        expect(countHealthyTargets([{ type: 'server', server: { id: 1 } }])).toBe(1);
    });

    it('requires every listener to be healthy', () => {
        expect(
            countHealthyTargets([
                {
                    type: 'server',
                    server: { id: 1 },
                    health_status: [
                        { listen_port: 80, status: 'healthy' },
                        { listen_port: 443, status: 'unhealthy' },
                    ],
                },
            ]),
        ).toBe(0);
    });
});

describe('targetKey', () => {
    it.each([
        [{ type: 'server' as const, server: { id: 7 } }, 'server:7'],
        [
            { type: 'label_selector' as const, label_selector: { selector: 'a=b' } },
            'label_selector:a=b',
        ],
        [{ type: 'ip' as const, ip: { ip: '1.2.3.4' } }, 'ip:1.2.3.4'],
    ])('renders %o as %o', (target, expected) => {
        expect(targetKey(target)).toBe(expected);
    });
});

describe('servicesMatch', () => {
    const base: LoadBalancerService = {
        protocol: 'http',
        listen_port: 80,
        destination_port: 8080,
        proxyprotocol: false,
        health_check: { protocol: 'tcp', port: 8080, interval: 15, timeout: 10, retries: 3 },
        http: { certificates: [], redirect_http: false, sticky_sessions: false },
    };

    it('ignores read-only fields Hetzner adds to the response', () => {
        const fromApi = { ...base, http: { ...base.http, cookie_name: 'HCLBSTICKY' } };
        expect(servicesMatch(fromApi as LoadBalancerService, base)).toBe(true);
    });

    it('ignores certificate order', () => {
        const left = { ...base, http: { ...base.http, certificates: [2, 1] } };
        const right = { ...base, http: { ...base.http, certificates: [1, 2] } };
        expect(servicesMatch(left as LoadBalancerService, right as LoadBalancerService)).toBe(true);
    });

    it('notices a real difference', () => {
        expect(servicesMatch(base, { ...base, destination_port: 9090 })).toBe(false);
        expect(
            servicesMatch(base, {
                ...base,
                health_check: {
                    protocol: 'http',
                    port: 8080,
                    interval: 15,
                    timeout: 10,
                    retries: 3,
                },
            }),
        ).toBe(false);
    });
});
