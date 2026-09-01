/**
 * The registry: every kind this operator serves.
 *
 * Adding a twelfth Hetzner resource means writing one adapter and adding one
 * line to `buildKinds` below. Nothing in `src/framework/` changes — that is the
 * whole point of the adapter contract.
 *
 * Order matters only for the startup log; the reconcile engine resolves
 * references at runtime, so a load balancer may be applied before the servers
 * it targets exist.
 */

import { defineKind, type KindRegistration } from '../framework/operator.js';
import type { HetznerCloud } from '../hcloud/index.js';
import type { SecretReader } from '../kube/secrets.js';
import { createCertificateAdapter } from './certificate.js';
import { createFirewallAdapter } from './firewall.js';
import { createFloatingIpAdapter } from './floating-ip.js';
import { createImageAdapter } from './image.js';
import { createLoadBalancerAdapter } from './load-balancer.js';
import { createNetworkAdapter } from './network.js';
import { createPlacementGroupAdapter } from './placement-group.js';
import { createPrimaryIpAdapter } from './primary-ip.js';
import { createServerAdapter } from './server/index.js';
import { createSshKeyAdapter } from './ssh-key.js';
import { createVolumeAdapter } from './volume.js';

export interface RegistryDependencies {
    hcloud: HetznerCloud;
    secrets: SecretReader;
}

export function buildKinds({ hcloud, secrets }: RegistryDependencies): KindRegistration[] {
    return [
        // Leaf resources first: nothing references anything else, so they are
        // the ones a fresh cluster can satisfy immediately.
        defineKind(createSshKeyAdapter(hcloud.sshKeys)),
        defineKind(createPlacementGroupAdapter(hcloud.placementGroups)),
        defineKind(createNetworkAdapter(hcloud.networks)),
        defineKind(createCertificateAdapter(hcloud.certificates, secrets)),

        // Servers, and everything that hangs off them.
        defineKind(createServerAdapter(hcloud.servers)),
        defineKind(createVolumeAdapter(hcloud.volumes)),
        defineKind(createFirewallAdapter(hcloud.firewalls)),
        defineKind(createFloatingIpAdapter(hcloud.floatingIps)),
        defineKind(createPrimaryIpAdapter(hcloud.primaryIps)),
        defineKind(createImageAdapter(hcloud.images, hcloud.servers)),

        // Load balancers reference servers, networks and certificates.
        defineKind(createLoadBalancerAdapter(hcloud.loadBalancers)),
    ];
}

export * from './certificate.js';
export * from './common.js';
export * from './firewall.js';
export * from './floating-ip.js';
export * from './image.js';
export * from './load-balancer.js';
export * from './network.js';
export * from './placement-group.js';
export * from './primary-ip.js';
export * from './server/index.js';
export * from './ssh-key.js';
export * from './volume.js';
