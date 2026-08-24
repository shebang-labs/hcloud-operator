/**
 * The subset of the Hetzner Cloud API object model this operator reads.
 *
 * These mirror https://docs.hetzner.cloud. Fields are optional wherever the API
 * may omit them, because a controller that assumes a field exists and gets
 * `undefined` will crash-loop on exactly the one resource that lacks it.
 *
 * Naming follows the wire format (snake_case) on purpose: the mapping to
 * Kubernetes camelCase happens in `src/resources/`, and keeping it in one place
 * means a reader can diff these types against Hetzner's docs line by line.
 */

export type ActionStatus = 'running' | 'success' | 'error';

export interface Action {
    id: number;
    command: string;
    status: ActionStatus;
    progress?: number;
    started?: string;
    finished?: string | null;
    resources?: Array<{ id: number; type: string }>;
    error?: { code: string; message: string } | null;
}

export interface Protection {
    delete?: boolean;
    rebuild?: boolean;
}

export interface DnsPtr {
    ip: string;
    dns_ptr: string | null;
}

export interface LocationRef {
    id?: number;
    name?: string;
    description?: string;
    country?: string;
    city?: string;
    network_zone?: string;
}

export interface DatacenterRef {
    id?: number;
    name?: string;
    description?: string;
    location?: LocationRef;
}

export interface ServerTypeRef {
    id?: number;
    name?: string;
    description?: string;
    cores?: number;
    memory?: number;
    disk?: number;
    architecture?: string;
    cpu_type?: string;
    storage_type?: string;
    deprecated?: boolean | string | null;
}

export interface ImageRef {
    id?: number;
    name?: string | null;
    description?: string;
    type?: string;
    status?: string;
    os_flavor?: string;
    os_version?: string | null;
    architecture?: string;
}

export interface IsoRef {
    id?: number;
    name?: string | null;
    description?: string;
    type?: string;
    architecture?: string | null;
}

/**
 * Anything that carries our ownership labels.
 *
 * `name` is nullable because a snapshot image may genuinely have none — the
 * base client must not assume otherwise.
 */
export interface Labelled {
    id: number;
    name?: string | null;
    labels?: Record<string, string>;
}

export interface Server extends Labelled {
    id: number;
    name: string;
    status: string;
    created?: string;
    public_net?: {
        ipv4?: {
            id?: number;
            ip?: string | null;
            blocked?: boolean;
            dns_ptr?: string | null;
        } | null;
        ipv6?: { id?: number; ip?: string | null; blocked?: boolean; dns_ptr?: DnsPtr[] } | null;
        floating_ips?: number[];
        firewalls?: Array<{ id: number; status?: string }>;
    };
    private_net?: Array<{
        network: number;
        ip?: string | null;
        alias_ips?: string[];
        mac_address?: string;
    }>;
    server_type?: ServerTypeRef | null;
    datacenter?: DatacenterRef | null;
    image?: ImageRef | null;
    iso?: IsoRef | null;
    rescue_enabled?: boolean;
    locked?: boolean;
    backup_window?: string | null;
    primary_disk_size?: number;
    protection?: Protection;
    placement_group?: { id: number; name?: string } | null;
    volumes?: number[];
    load_balancers?: number[];
    labels?: Record<string, string>;
}

export interface SshKey extends Labelled {
    id: number;
    name: string;
    fingerprint?: string;
    public_key?: string;
    created?: string;
    labels?: Record<string, string>;
}

export interface Volume extends Labelled {
    id: number;
    name: string;
    /** `available` once usable; `creating` while Hetzner provisions it. */
    status: string;
    size: number;
    server?: number | null;
    location?: LocationRef;
    linux_device?: string;
    format?: string | null;
    protection?: Protection;
    created?: string;
    labels?: Record<string, string>;
}

export interface NetworkSubnet {
    type: string;
    ip_range?: string;
    network_zone: string;
    gateway?: string;
    vswitch_id?: number | null;
}

export interface NetworkRoute {
    destination: string;
    gateway: string;
}

export interface Network extends Labelled {
    id: number;
    name: string;
    ip_range: string;
    subnets?: NetworkSubnet[];
    routes?: NetworkRoute[];
    servers?: number[];
    load_balancers?: number[];
    expose_routes_to_vswitch?: boolean;
    protection?: Protection;
    created?: string;
    labels?: Record<string, string>;
}

export interface FirewallRule {
    direction: 'in' | 'out';
    protocol: string;
    port?: string | null;
    source_ips?: string[];
    destination_ips?: string[];
    description?: string | null;
}

export interface FirewallAppliedTo {
    type: 'server' | 'label_selector';
    server?: { id: number };
    label_selector?: { selector: string };
    applied_to_resources?: Array<{ type: string; server?: { id: number } }>;
}

export interface Firewall extends Labelled {
    id: number;
    name: string;
    rules?: FirewallRule[];
    applied_to?: FirewallAppliedTo[];
    created?: string;
    labels?: Record<string, string>;
}

export interface LoadBalancerHealthCheck {
    protocol: string;
    port: number;
    interval: number;
    timeout: number;
    retries: number;
    http?: {
        domain?: string | null;
        path?: string;
        response?: string | null;
        status_codes?: string[];
        tls?: boolean;
    } | null;
}

export interface LoadBalancerService {
    protocol: string;
    listen_port: number;
    destination_port: number;
    proxyprotocol?: boolean;
    health_check?: LoadBalancerHealthCheck;
    http?: {
        cookie_name?: string;
        cookie_lifetime?: number;
        certificates?: number[];
        redirect_http?: boolean;
        sticky_sessions?: boolean;
    } | null;
}

export interface LoadBalancerTarget {
    type: 'server' | 'label_selector' | 'ip';
    server?: { id: number };
    label_selector?: { selector: string };
    ip?: { ip: string };
    use_private_ip?: boolean;
    health_status?: Array<{ listen_port: number; status: string }>;
    targets?: LoadBalancerTarget[];
}

export interface LoadBalancer extends Labelled {
    id: number;
    name: string;
    public_net?: {
        enabled?: boolean;
        ipv4?: { ip?: string | null; dns_ptr?: string | null } | null;
        ipv6?: { ip?: string | null; dns_ptr?: string | null } | null;
    };
    private_net?: Array<{ network: number; ip?: string | null }>;
    location?: LocationRef;
    load_balancer_type?: { id?: number; name?: string } | null;
    algorithm?: { type: string };
    services?: LoadBalancerService[];
    targets?: LoadBalancerTarget[];
    protection?: Protection;
    created?: string;
    labels?: Record<string, string>;
}

export interface FloatingIp extends Labelled {
    id: number;
    name?: string;
    description?: string | null;
    ip: string;
    type: string;
    server?: number | null;
    dns_ptr?: DnsPtr[];
    home_location?: LocationRef;
    blocked?: boolean;
    protection?: Protection;
    created?: string;
    labels?: Record<string, string>;
}

export interface PrimaryIp extends Labelled {
    id: number;
    name: string;
    ip: string;
    type: string;
    assignee_id?: number | null;
    assignee_type?: string;
    auto_delete?: boolean;
    dns_ptr?: DnsPtr[];
    datacenter?: DatacenterRef;
    blocked?: boolean;
    protection?: Protection;
    created?: string;
    labels?: Record<string, string>;
}

export interface PlacementGroup extends Labelled {
    id: number;
    name: string;
    type: string;
    servers?: number[];
    created?: string;
    labels?: Record<string, string>;
}

export interface Certificate extends Labelled {
    id: number;
    name: string;
    type: string;
    certificate?: string | null;
    domain_names?: string[];
    fingerprint?: string | null;
    not_valid_before?: string | null;
    not_valid_after?: string | null;
    status?: {
        issuance?: string;
        renewal?: string;
        error?: { code: string; message: string } | null;
    } | null;
    used_by?: Array<{ id: number; type: string }>;
    created?: string;
    labels?: Record<string, string>;
}

export interface Image extends Labelled {
    id: number;
    name?: string | null;
    description?: string;
    type: string;
    status: string;
    image_size?: number | null;
    disk_size?: number;
    architecture?: string;
    os_flavor?: string;
    os_version?: string | null;
    created_from?: { id: number; name: string } | null;
    bound_to?: number | null;
    protection?: Protection;
    deprecated?: string | null;
    created?: string;
    labels?: Record<string, string>;
}

/* ---- Read-only catalogs, used by validation rather than reconciliation ---- */

export interface ServerType extends ServerTypeRef {
    id: number;
    name: string;
}

export interface Location extends LocationRef {
    id: number;
    name: string;
}

export interface Datacenter extends DatacenterRef {
    id: number;
    name: string;
    server_types?: {
        supported?: number[];
        available?: number[];
        available_for_migration?: number[];
    };
}

export interface Iso {
    id: number;
    name: string | null;
    description?: string;
    type?: string;
    architecture?: string | null;
    deprecated?: string | null;
}
