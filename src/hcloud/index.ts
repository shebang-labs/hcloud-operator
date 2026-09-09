/**
 * The Hetzner Cloud client, assembled.
 *
 * One object holds every endpoint group, so an adapter declares exactly the
 * slice it needs (`hcloud.volumes`, `hcloud.servers`) and a test can hand it a
 * fake with the same shape. Nothing above this module ever constructs an HTTP
 * client or knows a URL.
 */

import type { OperatorMetrics } from '../observability/metrics.js';
import { type ActionTracker, createActionTracker } from './actions.js';
import { createHetznerHttpClient, type HttpClient } from './http.js';
import { RateLimiter } from './rate-limiter.js';
import { type CatalogApi, createCatalogApi } from './resources/catalog.js';
import { type CertificateApi, createCertificateApi } from './resources/certificates.js';
import { createFirewallApi, type FirewallApi } from './resources/firewalls.js';
import { createFloatingIpApi, type FloatingIpApi } from './resources/floating-ips.js';
import { createImageApi, type ImageApi } from './resources/images.js';
import { createLoadBalancerApi, type LoadBalancerApi } from './resources/load-balancers.js';
import { createNetworkApi, type NetworkApi } from './resources/networks.js';
import { createPlacementGroupApi, type PlacementGroupApi } from './resources/placement-groups.js';
import { createPrimaryIpApi, type PrimaryIpApi } from './resources/primary-ips.js';
import { createServerApi, type ServerApi } from './resources/servers.js';
import { createSshKeyApi, type SshKeyApi } from './resources/ssh-keys.js';
import { createVolumeApi, type VolumeApi } from './resources/volumes.js';

export interface HetznerCloud {
    readonly servers: ServerApi;
    readonly sshKeys: SshKeyApi;
    readonly volumes: VolumeApi;
    readonly networks: NetworkApi;
    readonly firewalls: FirewallApi;
    readonly loadBalancers: LoadBalancerApi;
    readonly floatingIps: FloatingIpApi;
    readonly primaryIps: PrimaryIpApi;
    readonly placementGroups: PlacementGroupApi;
    readonly certificates: CertificateApi;
    readonly images: ImageApi;
    readonly catalog: CatalogApi;
    /** Exposed so the metrics gauge can read the remaining request budget. */
    readonly rateLimiter: RateLimiter;
}

export interface HetznerCloudOptions {
    token: string;
    baseUrl: string;
    timeoutMs?: number;
    requestsPerHour?: number;
    actionTimeoutMs?: number;
    metrics?: OperatorMetrics;
    /** Aborted on shutdown, so waits on long-running actions give up promptly. */
    signal?: AbortSignal;
}

export function createHetznerCloud(options: HetznerCloudOptions): HetznerCloud {
    const rateLimiter = new RateLimiter({ requestsPerHour: options.requestsPerHour ?? 3_000 });

    const http = createHetznerHttpClient({
        token: options.token,
        baseUrl: options.baseUrl,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        rateLimiter,
        ...(options.metrics ? { metrics: options.metrics } : {}),
    });

    const actions = createActionTracker({
        http,
        ...(options.actionTimeoutMs !== undefined ? { timeoutMs: options.actionTimeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.metrics
            ? {
                  onSettled: (command, outcome) =>
                      options.metrics?.actionTotal.inc({ command, outcome }),
              }
            : {}),
    });

    return assembleHetznerCloud({ http, actions, rateLimiter });
}

/**
 * Wires the endpoint modules onto a transport. Split out from
 * `createHetznerCloud` so tests can assemble the real resource modules on top
 * of a fake HTTP client and exercise the actual request payloads.
 */
export function assembleHetznerCloud(dependencies: {
    http: HttpClient;
    actions: ActionTracker;
    /**
     * The limiter the transport is actually using. Required, because returning
     * a fresh one here would hand callers an object wired to nothing — the
     * metrics gauge would then report a budget that has never been spent.
     */
    rateLimiter: RateLimiter;
}): HetznerCloud {
    const { http, actions } = dependencies;
    const deps = { http, actions };

    return {
        servers: createServerApi(deps),
        sshKeys: createSshKeyApi(deps),
        volumes: createVolumeApi(deps),
        networks: createNetworkApi(deps),
        firewalls: createFirewallApi(deps),
        loadBalancers: createLoadBalancerApi(deps),
        floatingIps: createFloatingIpApi(deps),
        primaryIps: createPrimaryIpApi(deps),
        placementGroups: createPlacementGroupApi(deps),
        certificates: createCertificateApi(deps),
        images: createImageApi(deps),
        catalog: createCatalogApi({ http }),
        rateLimiter: dependencies.rateLimiter,
    };
}

export type { ActionScope, ActionTracker } from './actions.js';
export { createActionTracker, HetznerActionAbortedError } from './actions.js';
export * from './errors.js';
export type { HttpClient, QueryParams, RequestOptions } from './http.js';
export { createHetznerHttpClient, routeTemplate, toHetznerApiError } from './http.js';
export { RateLimiter } from './rate-limiter.js';
export type { BaseResourceApi } from './resources/base.js';
export { labelSelector } from './resources/base.js';
export type { CatalogApi } from './resources/catalog.js';
export type { CertificateApi, CreateCertificateInput } from './resources/certificates.js';
export type { CreateFirewallInput, FirewallApi } from './resources/firewalls.js';
export type { CreateFloatingIpInput, FloatingIpApi } from './resources/floating-ips.js';
export type { ImageApi } from './resources/images.js';
export type { CreateLoadBalancerInput, LoadBalancerApi } from './resources/load-balancers.js';
export type { CreateNetworkInput, NetworkApi } from './resources/networks.js';
export type { CreatePlacementGroupInput, PlacementGroupApi } from './resources/placement-groups.js';
export type { CreatePrimaryIpInput, PrimaryIpApi } from './resources/primary-ips.js';
export type { CreateServerInput, ServerApi } from './resources/servers.js';
export type { CreateSshKeyInput, SshKeyApi } from './resources/ssh-keys.js';
export type { CreateVolumeInput, VolumeApi } from './resources/volumes.js';
export * from './types.js';
