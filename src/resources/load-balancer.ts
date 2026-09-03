/**
 * HetznerLoadBalancer — services, targets, health checks and TLS.
 *
 * The most action-heavy kind: Hetzner exposes no way to PUT a desired
 * configuration, so every service and every target has its own add/update/
 * delete call. `update` therefore does the real work of a declarative
 * controller — diff the declared list against reality and issue exactly the
 * calls that close the gap, in an order that never leaves the load balancer
 * without a listener.
 *
 * Services are keyed by listen port, targets by their identity (server id,
 * label selector or IP). Both are stable across reconciles, which is what stops
 * the operator from tearing a service down and putting it back on every resync.
 */

import type { ReferenceResolver, ResourceRef } from '../framework/references.js';
import type { ResourceAdapter, UpdateOutcome } from '../framework/types.js';
import type { LoadBalancerApi } from '../hcloud/resources/load-balancers.js';
import type { LoadBalancer, LoadBalancerService, LoadBalancerTarget } from '../hcloud/types.js';
import type { CommonSpec, CommonStatus, ResourceDescriptor } from '../kube/api.js';
import {
    ChangeLog,
    deepEqual,
    type ProtectionSpec,
    protectionMatches,
    toProtectionPayload,
} from './common.js';

export const LOAD_BALANCER_ALGORITHMS = ['round_robin', 'least_connections'] as const;
export type LoadBalancerAlgorithm = (typeof LOAD_BALANCER_ALGORITHMS)[number];

export interface HealthCheckSpec {
    protocol: 'tcp' | 'http';
    port: number;
    /** Seconds between checks. */
    interval?: number;
    /** Seconds before a check counts as failed. */
    timeout?: number;
    /** Consecutive failures before a target is taken out of rotation. */
    retries?: number;
    http?: {
        domain?: string;
        path?: string;
        response?: string;
        statusCodes?: string[];
        tls?: boolean;
    };
}

export interface ServiceSpec {
    protocol: 'tcp' | 'http' | 'https';
    listenPort: number;
    destinationPort: number;
    /** Prepend the PROXY protocol header so backends see the real client IP. */
    proxyProtocol?: boolean;
    healthCheck?: HealthCheckSpec;
    http?: {
        /** Certificates to serve. Only for `protocol: https`. */
        certificateRefs?: ResourceRef[];
        redirectHttp?: boolean;
        stickySessions?: boolean;
        cookieName?: string;
        cookieLifetime?: number;
    };
}

export interface TargetSpec {
    /** A server managed by this operator, or an existing one. */
    serverRef?: ResourceRef;
    /** Every server carrying this Hetzner label selector. */
    labelSelector?: string;
    /** A plain IP address, for targets outside the Hetzner project. */
    ip?: string;
    /** Route to the target over the private network instead of the public one. */
    usePrivateIp?: boolean;
}

export interface HetznerLoadBalancerSpec extends CommonSpec {
    /** Hetzner load balancer type, e.g. "lb11". Can be changed online. */
    loadBalancerType: string;
    /** Either a location or a network zone. Immutable. */
    location?: string;
    networkZone?: string;
    algorithm?: LoadBalancerAlgorithm;
    services?: ServiceSpec[];
    targets?: TargetSpec[];
    /** Attach the load balancer to a private network. */
    networkRef?: ResourceRef;
    /** Give it a public IP. Disable for an internal-only load balancer. */
    publicInterface?: boolean;
    protection?: ProtectionSpec;
}

export interface HetznerLoadBalancerStatus extends CommonStatus {
    ipv4?: string;
    ipv6?: string;
    loadBalancerType?: string;
    algorithm?: string;
    location?: string;
    serviceCount?: number;
    targetCount?: number;
    /** Targets currently passing their health checks. */
    healthyTargets?: number;
    privateIps?: string[];
}

export const loadBalancerDescriptor: ResourceDescriptor = {
    kind: 'HetznerLoadBalancer',
    plural: 'hetznerloadbalancers',
    shortName: 'hlb',
};

export function createLoadBalancerAdapter(
    api: LoadBalancerApi,
): ResourceAdapter<HetznerLoadBalancerSpec, HetznerLoadBalancerStatus, LoadBalancer> {
    return {
        descriptor: loadBalancerDescriptor,
        api,
        syncName: true,

        validate(spec) {
            const problems: string[] = [];
            if (!spec.loadBalancerType) {
                problems.push('spec.loadBalancerType is required, e.g. "lb11"');
            }
            if (!spec.location && !spec.networkZone) {
                problems.push('one of spec.location or spec.networkZone is required');
            }
            if (spec.algorithm && !LOAD_BALANCER_ALGORITHMS.includes(spec.algorithm)) {
                problems.push(
                    `spec.algorithm must be one of ${LOAD_BALANCER_ALGORITHMS.join(', ')}, got "${spec.algorithm}"`,
                );
            }

            const ports = new Set<number>();
            for (const [index, service] of (spec.services ?? []).entries()) {
                const where = `spec.services[${index}]`;
                if (ports.has(service.listenPort)) {
                    problems.push(`${where}.listenPort ${service.listenPort} is declared twice`);
                }
                ports.add(service.listenPort);
                if (service.protocol === 'https' && !service.http?.certificateRefs?.length) {
                    problems.push(`${where} uses https but sets no http.certificateRefs`);
                }
                if (service.protocol !== 'https' && service.http?.certificateRefs?.length) {
                    problems.push(
                        `${where} sets http.certificateRefs but its protocol is "${service.protocol}"; ` +
                            'certificates only apply to https services',
                    );
                }
            }

            for (const [index, target] of (spec.targets ?? []).entries()) {
                const set = [target.serverRef, target.labelSelector, target.ip].filter(Boolean);
                if (set.length !== 1) {
                    problems.push(
                        `spec.targets[${index}] must set exactly one of serverRef, labelSelector or ip`,
                    );
                }
            }

            return problems;
        },

        async create(context) {
            const { spec } = context;
            const services = await resolveServices(spec.services, context.refs, context.namespace);
            const targets = await resolveTargets(spec.targets, context.refs, context.namespace);
            const networkId = spec.networkRef
                ? await context.refs.resolve('HetznerNetwork', spec.networkRef, context.namespace)
                : undefined;

            return api.create({
                name: context.hetznerName,
                loadBalancerType: spec.loadBalancerType,
                ...(spec.algorithm ? { algorithm: spec.algorithm } : {}),
                ...(spec.location
                    ? { location: spec.location }
                    : { networkZone: spec.networkZone }),
                services,
                targets,
                ...(spec.publicInterface !== undefined
                    ? { publicInterface: spec.publicInterface }
                    : {}),
                ...(networkId !== undefined ? { networkId } : {}),
                labels: context.labels,
            });
        },

        async update(context, remote): Promise<UpdateOutcome> {
            const { spec } = context;
            const log = new ChangeLog();

            if (spec.loadBalancerType !== remote.load_balancer_type?.name) {
                // Changing the type is online and reversible, so no guard.
                await api.changeType(remote.id, spec.loadBalancerType);
                log.record(`changed type to ${spec.loadBalancerType}`);
            }

            const desiredAlgorithm = spec.algorithm ?? 'round_robin';
            if (desiredAlgorithm !== remote.algorithm?.type) {
                await api.changeAlgorithm(remote.id, desiredAlgorithm);
                log.record(`changed algorithm to ${desiredAlgorithm}`);
            }

            await syncServices(api, remote, spec, context, log);
            await syncTargets(api, remote, spec, context, log);
            await syncNetwork(api, remote, spec, context, log);

            if (
                spec.publicInterface !== undefined &&
                spec.publicInterface !== (remote.public_net?.enabled ?? true)
            ) {
                await api.setPublicInterface(remote.id, spec.publicInterface);
                log.record(`${spec.publicInterface ? 'enabled' : 'disabled'} the public interface`);
            }

            if (!protectionMatches(remote.protection, spec.protection)) {
                await api.changeProtection(remote.id, toProtectionPayload(spec.protection ?? {}));
                log.record('updated delete protection');
            }

            return { changed: log.changed, changes: log.changes };
        },

        project(remote) {
            const ipv4 = remote.public_net?.ipv4?.ip ?? undefined;
            const ipv6 = remote.public_net?.ipv6?.ip ?? undefined;
            const privateIps = (remote.private_net ?? [])
                .map((entry) => entry.ip)
                .filter((ip): ip is string => Boolean(ip));
            const targets = remote.targets ?? [];
            const healthy = countHealthyTargets(targets);
            const publicEnabled = remote.public_net?.enabled ?? true;

            // An internal-only load balancer never gets a public IP, so requiring
            // one would leave it permanently not-ready.
            const addressed = publicEnabled ? Boolean(ipv4) : privateIps.length > 0;

            return {
                ready: addressed,
                phase: addressed ? 'Ready' : 'Creating',
                message: addressed
                    ? `The load balancer is reachable at ${ipv4 ?? privateIps[0]} with ${healthy}/${targets.length} healthy target(s)`
                    : 'Hetzner is still provisioning the load balancer',
                status: {
                    ...(ipv4 ? { ipv4 } : {}),
                    ...(ipv6 ? { ipv6 } : {}),
                    ...(remote.load_balancer_type?.name
                        ? { loadBalancerType: remote.load_balancer_type.name }
                        : {}),
                    ...(remote.algorithm?.type ? { algorithm: remote.algorithm.type } : {}),
                    ...(remote.location?.name ? { location: remote.location.name } : {}),
                    serviceCount: (remote.services ?? []).length,
                    targetCount: targets.length,
                    healthyTargets: healthy,
                    privateIps,
                },
                // Health status settles a few seconds after a target is added.
                ...(addressed && healthy < targets.length ? { requeueAfterMs: 15_000 } : {}),
                ...(addressed ? {} : { requeueAfterMs: 10_000 }),
            };
        },

        drift(context, remote) {
            const actualLocation = remote.location?.name;
            if (
                context.spec.location &&
                actualLocation &&
                context.spec.location !== actualLocation
            ) {
                return (
                    `spec.location is "${context.spec.location}" but the load balancer is in ` +
                    `"${actualLocation}". The location is immutable; delete and recreate this ` +
                    'HetznerLoadBalancer to move it — its IP addresses will change.'
                );
            }
            return undefined;
        },
    };
}

/* -------------------------------------------------------------------------- */
/* Converging the three list-shaped parts of a load balancer                   */
/* -------------------------------------------------------------------------- */

interface SyncContext {
    refs: ReferenceResolver;
    namespace: string;
}

async function syncServices(
    api: LoadBalancerApi,
    remote: LoadBalancer,
    spec: HetznerLoadBalancerSpec,
    context: SyncContext,
    log: ChangeLog,
): Promise<void> {
    const desired = await resolveServices(spec.services, context.refs, context.namespace);
    const actual = remote.services ?? [];

    const desiredByPort = new Map(desired.map((service) => [service.listen_port, service]));
    const actualByPort = new Map(actual.map((service) => [service.listen_port, service]));

    // Add and update before deleting, so a port that is only being reconfigured
    // never goes dark.
    for (const [port, service] of desiredByPort) {
        const existing = actualByPort.get(port);
        if (!existing) {
            await api.addService(remote.id, service);
            log.record(`added service on port ${port}`);
        } else if (!servicesMatch(existing, service)) {
            await api.updateService(remote.id, service);
            log.record(`updated service on port ${port}`);
        }
    }

    for (const port of actualByPort.keys()) {
        if (!desiredByPort.has(port)) {
            await api.deleteService(remote.id, port);
            log.record(`removed service on port ${port}`);
        }
    }
}

async function syncTargets(
    api: LoadBalancerApi,
    remote: LoadBalancer,
    spec: HetznerLoadBalancerSpec,
    context: SyncContext,
    log: ChangeLog,
): Promise<void> {
    const desired = await resolveTargets(spec.targets, context.refs, context.namespace);
    // Hetzner echoes the servers a label selector resolved to as nested
    // `targets`; those are not targets we declared and must not be diffed.
    const actual = (remote.targets ?? []).map(normaliseTarget);

    const desiredKeys = new Map(desired.map((target) => [targetKey(target), target]));
    const actualKeys = new Map(actual.map((target) => [targetKey(target), target]));

    for (const [key, target] of desiredKeys) {
        const existing = actualKeys.get(key);
        if (!existing) {
            await api.addTarget(remote.id, target);
            log.record(`added target ${key}`);
        } else if ((existing.use_private_ip ?? false) !== (target.use_private_ip ?? false)) {
            // There is no "update target"; re-adding replaces the entry.
            await api.addTarget(remote.id, target);
            log.record(`updated target ${key}`);
        }
    }

    for (const [key, target] of actualKeys) {
        if (!desiredKeys.has(key)) {
            await api.removeTarget(remote.id, target);
            log.record(`removed target ${key}`);
        }
    }
}

async function syncNetwork(
    api: LoadBalancerApi,
    remote: LoadBalancer,
    spec: HetznerLoadBalancerSpec,
    context: SyncContext,
    log: ChangeLog,
): Promise<void> {
    const desiredNetworkId = spec.networkRef
        ? await context.refs.resolve('HetznerNetwork', spec.networkRef, context.namespace)
        : undefined;
    const attached = (remote.private_net ?? []).map((entry) => entry.network);

    if (desiredNetworkId !== undefined && !attached.includes(desiredNetworkId)) {
        await api.attachToNetwork(remote.id, desiredNetworkId);
        log.record(`attached to network ${desiredNetworkId}`);
    }
    for (const networkId of attached) {
        if (networkId !== desiredNetworkId) {
            await api.detachFromNetwork(remote.id, networkId);
            log.record(`detached from network ${networkId}`);
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Spec -> API payload                                                         */
/* -------------------------------------------------------------------------- */

async function resolveServices(
    services: ServiceSpec[] | undefined,
    refs: ReferenceResolver,
    namespace: string,
): Promise<LoadBalancerService[]> {
    const resolved: LoadBalancerService[] = [];
    for (const service of services ?? []) {
        const certificateIds = await Promise.all(
            (service.http?.certificateRefs ?? []).map((ref) =>
                refs.resolve('HetznerCertificate', ref, namespace),
            ),
        );
        resolved.push({
            protocol: service.protocol,
            listen_port: service.listenPort,
            destination_port: service.destinationPort,
            proxyprotocol: service.proxyProtocol ?? false,
            health_check: toHealthCheckPayload(service),
            ...(service.protocol === 'tcp'
                ? {}
                : {
                      http: {
                          certificates: certificateIds,
                          redirect_http: service.http?.redirectHttp ?? false,
                          sticky_sessions: service.http?.stickySessions ?? false,
                          ...(service.http?.cookieName
                              ? { cookie_name: service.http.cookieName }
                              : {}),
                          ...(service.http?.cookieLifetime !== undefined
                              ? { cookie_lifetime: service.http.cookieLifetime }
                              : {}),
                      },
                  }),
        });
    }
    return resolved;
}

function toHealthCheckPayload(service: ServiceSpec): LoadBalancerService['health_check'] {
    const check = service.healthCheck;
    // Hetzner requires a health check on every service. Defaulting it to a TCP
    // check against the destination port is what the console does too, and it
    // keeps a minimal spec from being rejected.
    const protocol = check?.protocol ?? 'tcp';
    return {
        protocol,
        port: check?.port ?? service.destinationPort,
        interval: check?.interval ?? 15,
        timeout: check?.timeout ?? 10,
        retries: check?.retries ?? 3,
        ...(protocol === 'http'
            ? {
                  http: {
                      ...(check?.http?.domain ? { domain: check.http.domain } : { domain: null }),
                      path: check?.http?.path ?? '/',
                      ...(check?.http?.response ? { response: check.http.response } : {}),
                      status_codes: check?.http?.statusCodes ?? ['2??', '3??'],
                      tls: check?.http?.tls ?? false,
                  },
              }
            : {}),
    };
}

async function resolveTargets(
    targets: TargetSpec[] | undefined,
    refs: ReferenceResolver,
    namespace: string,
): Promise<LoadBalancerTarget[]> {
    const resolved: LoadBalancerTarget[] = [];
    for (const target of targets ?? []) {
        if (target.serverRef) {
            const id = await refs.resolve('HetznerServer', target.serverRef, namespace);
            resolved.push({
                type: 'server',
                server: { id },
                use_private_ip: target.usePrivateIp ?? false,
            });
        } else if (target.labelSelector) {
            resolved.push({
                type: 'label_selector',
                label_selector: { selector: target.labelSelector },
                use_private_ip: target.usePrivateIp ?? false,
            });
        } else if (target.ip) {
            resolved.push({ type: 'ip', ip: { ip: target.ip } });
        }
    }
    return resolved;
}

/* -------------------------------------------------------------------------- */
/* Comparison helpers                                                          */
/* -------------------------------------------------------------------------- */

export function targetKey(target: LoadBalancerTarget): string {
    switch (target.type) {
        case 'server':
            return `server:${target.server?.id}`;
        case 'label_selector':
            return `label_selector:${target.label_selector?.selector}`;
        default:
            return `ip:${target.ip?.ip}`;
    }
}

function normaliseTarget(target: LoadBalancerTarget): LoadBalancerTarget {
    return {
        type: target.type,
        ...(target.server ? { server: { id: target.server.id } } : {}),
        ...(target.label_selector ? { label_selector: target.label_selector } : {}),
        ...(target.ip ? { ip: target.ip } : {}),
        use_private_ip: target.use_private_ip ?? false,
    };
}

/**
 * Compares only the fields the operator sets. Hetzner adds read-only ones
 * (resolved certificate metadata, health status) that would otherwise make
 * every service look changed on every resync.
 */
export function servicesMatch(actual: LoadBalancerService, desired: LoadBalancerService): boolean {
    return (
        actual.protocol === desired.protocol &&
        actual.listen_port === desired.listen_port &&
        actual.destination_port === desired.destination_port &&
        (actual.proxyprotocol ?? false) === (desired.proxyprotocol ?? false) &&
        healthChecksMatch(actual.health_check, desired.health_check) &&
        httpOptionsMatch(actual.http, desired.http)
    );
}

function healthChecksMatch(
    actual: LoadBalancerService['health_check'],
    desired: LoadBalancerService['health_check'],
): boolean {
    if (!actual || !desired) {
        return actual === desired;
    }
    return (
        actual.protocol === desired.protocol &&
        actual.port === desired.port &&
        actual.interval === desired.interval &&
        actual.timeout === desired.timeout &&
        actual.retries === desired.retries &&
        deepEqual(actual.http ?? null, desired.http ?? null)
    );
}

function httpOptionsMatch(
    actual: LoadBalancerService['http'],
    desired: LoadBalancerService['http'],
): boolean {
    if (!actual || !desired) {
        return !actual === !desired;
    }
    return (
        deepEqual(
            [...(actual.certificates ?? [])].sort(),
            [...(desired.certificates ?? [])].sort(),
        ) &&
        (actual.redirect_http ?? false) === (desired.redirect_http ?? false) &&
        (actual.sticky_sessions ?? false) === (desired.sticky_sessions ?? false) &&
        (desired.cookie_name === undefined || actual.cookie_name === desired.cookie_name) &&
        (desired.cookie_lifetime === undefined ||
            actual.cookie_lifetime === desired.cookie_lifetime)
    );
}

export function countHealthyTargets(targets: LoadBalancerTarget[]): number {
    return targets.filter((target) =>
        (target.health_status ?? []).every((entry) => entry.status === 'healthy'),
    ).length;
}
