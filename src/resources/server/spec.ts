/**
 * The `HetznerServer` spec and status.
 *
 * ## Who owns a relationship
 *
 * Several Hetzner relationships could be declared from either end. Declaring
 * them from both would make two controllers fight: one adds the server to the
 * firewall, the other removes it, forever. So each relationship has exactly one
 * owner, and only the owner may declare it:
 *
 *   | Relationship             | Declared on            |
 *   |--------------------------|------------------------|
 *   | volume attached to server| HetznerVolume.serverRef|
 *   | firewall protects server | HetznerFirewall.applyToServerRefs |
 *   | floating IP -> server    | HetznerFloatingIP.serverRef |
 *   | primary IP -> server     | HetznerPrimaryIP.serverRef |
 *   | server in private network| HetznerServer.networks |
 *   | server in placement group| HetznerServer.placementGroupRef |
 *   | SSH keys                 | HetznerServer.sshKeyRefs (create only) |
 *
 * That is why this spec has no `volumeRefs` or `firewallRefs`: those live on
 * the other side of the relationship.
 */

import type { ResourceRef } from '../../framework/references.js';
import type { CommonSpec, CommonStatus, ResourceDescriptor } from '../../kube/api.js';
import type { DnsPtrSpec, ProtectionSpec } from '../common.js';

/**
 * Desired power state.
 *
 * Deliberately not "On"/"Off": YAML 1.1 — which the Kubernetes API server uses —
 * parses bare `On` and `Off` as booleans, so `powerState: Running` would arrive as
 * `true` and be rejected with a confusing type error. Every user who wrote it
 * unquoted would hit it. "Running"/"Stopped" also match the vocabulary Hetzner
 * and `kubectl get` already use for a server's observed state.
 */
export type PowerState = 'Running' | 'Stopped';

export interface ServerNetworkSpec {
    /** The private network to attach to. */
    networkRef: ResourceRef;
    /** Fixed private IP inside the network. Hetzner picks one when omitted. */
    ip?: string;
    /** Extra IPs this server answers for, used for keepalived-style failover. */
    aliasIps?: string[];
}

export interface UserDataSecretRef {
    /** Name of a Secret in this object's namespace. */
    name: string;
    /** Key inside that Secret. Defaults to "user-data". */
    key?: string;
}

export interface RescueSpec {
    /** Boot the Hetzner rescue system on the next start. */
    enabled: boolean;
    /** "linux64" (default) or "linux32". */
    type?: string;
    /** SSH keys authorised in the rescue system. */
    sshKeyRefs?: ResourceRef[];
}

export interface PublicNetSpec {
    /** Give the server a public IPv4. Immutable after create. */
    enableIPv4?: boolean;
    /** Give the server a public IPv6. Immutable after create. */
    enableIPv6?: boolean;
}

export interface HetznerServerSpec extends CommonSpec {
    /**
     * Hetzner server type, e.g. "cpx21".
     *
     * @deprecated Use `serverTypes`, which reads this as a single-entry list.
     * Kept for compatibility with every chart already installed; it goes in a
     * future major version.
     */
    serverType?: string;
    /**
     * Hetzner server types to try in order, e.g. `["cx53", "cx43"]`.
     *
     * Only the *creation* walks the list, and only when Hetzner says it has no
     * capacity. Once a server exists, whichever entry it landed on is where it
     * stays: see `desiredServerTypes` for why nothing pulls it back up.
     */
    serverTypes?: string[];
    /**
     * Image name or id, e.g. "ubuntu-24.04". Changing it rebuilds the server,
     * which erases its disk — so it only happens with `allowDataLoss: true`.
     */
    image: string;
    /** Hetzner location, e.g. "nbg1". Immutable. Use one of location/datacenter. */
    location?: string;
    /** Hetzner datacenter, e.g. "nbg1-dc3". Immutable. */
    datacenter?: string;
    /** SSH keys to install at first boot. Only applied at create time. */
    sshKeyRefs?: ResourceRef[];
    /** Cloud-init user data applied at first boot. Immutable. */
    userData?: string;
    /**
     * Cloud-init user data read from a Secret at create time. Use this when the
     * user data carries credentials — a join token, a registry key — that must
     * not sit in a custom resource. Mutually exclusive with `userData`.
     */
    userDataSecretRef?: UserDataSecretRef;
    /** Public IP configuration. Immutable after create. */
    publicNet?: PublicNetSpec;
    /** Private networks this server joins. */
    networks?: ServerNetworkSpec[];
    /** Placement group membership. */
    placementGroupRef?: ResourceRef;

    /* ---- Convergent operations ---- */

    /** Desired power state. Defaults to Running. */
    powerState?: PowerState;
    /**
     * How long to wait for a clean ACPI shutdown before cutting the power.
     * Defaults to 120 seconds.
     */
    gracefulShutdownTimeoutSeconds?: number;
    /** Enable Hetzner's daily backups (adds 20% to the server price). */
    backups?: boolean;
    /** Boot into the rescue system. */
    rescue?: RescueSpec;
    /** ISO to keep attached, by name. Set to null or omit to detach. */
    iso?: string | null;
    /** Reverse DNS entries for the server's addresses. */
    dnsPtr?: DnsPtrSpec[];
    protection?: ProtectionSpec;

    /* ---- Guards ---- */

    /**
     * Required before the operator will resize the server. A resize powers the
     * server off, changes its type, and powers it back on.
     */
    allowDowntime?: boolean;
    /**
     * Required before the operator will rebuild the server from a different
     * image. A rebuild erases the disk; nothing on it survives.
     */
    allowDataLoss?: boolean;
    /**
     * Grow the disk during a resize. Hetzner cannot downgrade a server whose
     * disk was enlarged, so this makes the resize one-way.
     */
    upgradeDisk?: boolean;
}

/**
 * A multi-step operation the operator is in the middle of. Only a resize needs
 * one: a rebuild is a single Hetzner action, whatever the power state.
 */
export type PendingOperation = 'Resizing';

export interface HetznerServerStatus extends CommonStatus {
    /** Hetzner's own status: running, off, starting, initializing, ... */
    serverStatus?: string;
    serverType?: string;
    image?: string;
    location?: string;
    datacenter?: string;
    ipv4?: string;
    ipv6?: string;
    /** Private IPs, one per attached network. */
    privateIps?: string[];
    /** Hetzner ids of the networks the server is attached to. */
    networkIds?: number[];
    /** Hetzner ids of the volumes attached to the server. */
    volumeIds?: number[];
    placementGroupId?: number;
    rescueEnabled?: boolean;
    backupsEnabled?: boolean;
    /** Name of the attached ISO, if any. */
    iso?: string;
    /** True while Hetzner holds a lock on the server for another action. */
    locked?: boolean;
    /** Set while the operator is part-way through a multi-step operation. */
    pendingOperation?: PendingOperation | null;
    /** When the current shutdown was requested, for the graceful timeout. */
    shutdownRequestedAt?: string | null;
}

export const serverDescriptor: ResourceDescriptor = {
    kind: 'HetznerServer',
    plural: 'hetznerservers',
    shortName: 'hsrv',
};

/**
 * The server types this spec will accept, most preferred first.
 *
 * One list whatever the user wrote, so nothing downstream has to know that the
 * singular field still exists. Entries are trimmed because a stray space in a
 * YAML list is invisible in review and would be sent to Hetzner verbatim.
 *
 * The ordering carries the whole policy. The first entry is what a fresh server
 * is created as; a later one is reached only when Hetzner has no capacity for
 * the entries before it. After that the position in the list stops mattering,
 * and deliberately so: moving a server up the list means a resize, a resize
 * that grows the disk cannot be undone, and Hetzner cannot shrink a disk at
 * all. Treating a smaller-than-preferred server as drift would therefore push
 * towards a one-way, downtime-taking change that nobody asked for, to fix a
 * node that is working.
 */
export function desiredServerTypes(spec: HetznerServerSpec): string[] {
    const declared = spec.serverTypes?.length ? spec.serverTypes : listOf(spec.serverType);
    return declared.map((entry) => entry.trim()).filter(Boolean);
}

function listOf(value: string | undefined): string[] {
    return value ? [value] : [];
}

/** Hetzner states that mean "still working on it". */
export const TRANSITIONAL_STATES = new Set([
    'initializing',
    'starting',
    'stopping',
    'migrating',
    'rebuilding',
]);

export const DEFAULT_GRACEFUL_SHUTDOWN_SECONDS = 120;
