/**
 * An in-memory Hetzner Cloud API.
 *
 * This is the centrepiece of the test suite. It implements the transport
 * interface rather than mocking the resource modules, so every test above it
 * exercises the *real* `src/hcloud/resources/*` code — the actual request
 * paths, the actual JSON payloads, the actual response unwrapping. A test that
 * passes here would have sent the same bytes to Hetzner.
 *
 * It reproduces the semantics that matter to a controller:
 *
 *   - server-assigned ids that are never reused;
 *   - name uniqueness per resource type, answered with `uniqueness_error`;
 *   - label selectors, so ownership lookups work as they do in production;
 *   - the action lifecycle, including actions that stay `running` for a while;
 *   - pagination, so an unpaginated list shows up as a missing result;
 *   - injectable failures, for the error paths that are otherwise unreachable.
 */

import { HetznerApiError } from '../../src/hcloud/errors.js';
import type { HttpClient, QueryParams, RequestOptions } from '../../src/hcloud/http.js';
import type { Action } from '../../src/hcloud/types.js';

type Json = Record<string, unknown>;

interface Collection {
    plural: string;
    singular: string;
    items: Map<number, Json>;
}

export interface FailureRule {
    /** Matched against "METHOD /path". A string matches by prefix. */
    match: string | RegExp;
    error: HetznerApiError;
    /** Fail this many times, then stop. Defaults to once. */
    times?: number;
}

export interface FakeHetznerOptions {
    /** How many polls an action stays `running` before succeeding. */
    actionPolls?: number;
    /** Items per page, so pagination can be exercised with a handful of items. */
    pageSize?: number;
}

const COLLECTIONS: Array<[string, string]> = [
    ['servers', 'server'],
    ['ssh_keys', 'ssh_key'],
    ['volumes', 'volume'],
    ['networks', 'network'],
    ['firewalls', 'firewall'],
    ['load_balancers', 'load_balancer'],
    ['floating_ips', 'floating_ip'],
    ['primary_ips', 'primary_ip'],
    ['placement_groups', 'placement_group'],
    ['certificates', 'certificate'],
    ['images', 'image'],
];

export class FakeHetznerApi implements HttpClient {
    private readonly collections = new Map<string, Collection>();
    private readonly actions = new Map<number, { action: Action; pollsLeft: number }>();
    private readonly failures: FailureRule[] = [];

    private nextId = 1000;
    private nextActionId = 1;

    /** Every request that reached the API, as "METHOD /path". */
    readonly requests: string[] = [];
    /** The body of every mutating request, in order. */
    readonly bodies: Array<{ request: string; body: unknown }> = [];

    private readonly actionPolls: number;
    private readonly pageSize: number;

    constructor(options: FakeHetznerOptions = {}) {
        this.actionPolls = options.actionPolls ?? 0;
        this.pageSize = options.pageSize ?? 50;
        for (const [plural, singular] of COLLECTIONS) {
            this.collections.set(plural, { plural, singular, items: new Map() });
        }
        this.seedSystemImages();
    }

    /**
     * Hetzner's own images are present in every real project, and the admission
     * webhook checks `spec.image` against them. A project without them is not a
     * state that exists.
     */
    private seedSystemImages(): void {
        for (const name of [
            'ubuntu-24.04',
            'ubuntu-22.04',
            'debian-12',
            'debian-11',
            'fedora-41',
            'rocky-9',
            'centos-stream-9',
            'alma-9',
        ]) {
            this.seed('images', {
                name,
                type: 'system',
                status: 'available',
                description: name,
                os_flavor: name.split('-')[0],
                architecture: 'x86',
            });
        }
    }

    /* ------------------------------------------------------------------ */
    /* Test controls                                                       */
    /* ------------------------------------------------------------------ */

    /** Makes the next matching request(s) fail. */
    failNext(rule: FailureRule): void {
        this.failures.push({ times: 1, ...rule });
    }

    /** Puts a resource into the project without going through the API. */
    seed(plural: string, item: Json): Json {
        const collection = this.require(plural);
        const id = typeof item.id === 'number' ? item.id : this.allocateId();
        const stored = { ...item, id };
        collection.items.set(id, stored);
        return stored;
    }

    /** Reads a resource directly, bypassing the API. */
    peek(plural: string, id: number): Json | undefined {
        return this.collections.get(plural)?.items.get(id);
    }

    /** Every resource of a type, for assertions. */
    all(plural: string): Json[] {
        return [...(this.collections.get(plural)?.items.values() ?? [])];
    }

    /** How many requests matched a "METHOD /path" prefix. */
    countRequests(prefix: string): number {
        return this.requests.filter((entry) => entry.startsWith(prefix)).length;
    }

    /** The body of the last request matching a prefix. */
    lastBody(prefix: string): unknown {
        return [...this.bodies].reverse().find((entry) => entry.request.startsWith(prefix))?.body;
    }

    reset(): void {
        this.requests.length = 0;
        this.bodies.length = 0;
    }

    /* ------------------------------------------------------------------ */
    /* HttpClient                                                          */
    /* ------------------------------------------------------------------ */

    async get<T>(path: string, options?: RequestOptions): Promise<T> {
        return this.handle('GET', path, undefined, options?.params) as T;
    }

    async post<T>(path: string, body?: unknown): Promise<T> {
        return this.handle('POST', path, body) as T;
    }

    async put<T>(path: string, body?: unknown): Promise<T> {
        return this.handle('PUT', path, body) as T;
    }

    async delete<T>(path: string): Promise<T> {
        return this.handle('DELETE', path) as T;
    }

    async list<T>(path: string, key: string, options?: RequestOptions): Promise<T[]> {
        // Mirrors the real client's pagination loop so tests that seed more than
        // one page really do exercise it.
        const collected: T[] = [];
        let page: number | undefined = 1;
        while (page !== undefined) {
            const payload = (await this.handle('GET', path, undefined, {
                ...options?.params,
                page,
                per_page: this.pageSize,
            })) as Json;
            const items = payload[key];
            if (Array.isArray(items)) {
                collected.push(...(items as T[]));
            }
            const meta = payload.meta as { pagination?: { next_page?: number | null } } | undefined;
            const next = meta?.pagination?.next_page;
            page = typeof next === 'number' && next > 0 ? next : undefined;
        }
        return collected;
    }

    /* ------------------------------------------------------------------ */
    /* Routing                                                             */
    /* ------------------------------------------------------------------ */

    private handle(method: string, path: string, body?: unknown, params?: QueryParams): Json {
        const request = `${method} ${path}`;
        this.requests.push(request);
        if (method !== 'GET') {
            this.bodies.push({ request, body });
        }
        this.applyFailures(request);

        const segments = path.replace(/^\//, '').split('/');
        const [plural, second, third, fourth] = segments;

        if (plural === 'actions' && second) {
            return this.readAction(Number(second));
        }
        if (second === 'actions' && third) {
            // Per-resource action endpoint: /servers/actions/42
            return this.readAction(Number(third));
        }
        if (!plural) {
            throw notFound(path);
        }

        // Read-only catalogs.
        if (['server_types', 'locations', 'datacenters', 'isos', 'pricing'].includes(plural)) {
            return this.catalog(plural);
        }

        const collection = this.require(plural);

        if (second === undefined) {
            return method === 'POST'
                ? this.create(collection, body as Json)
                : this.listPage(collection, params ?? {});
        }

        const id = Number(second);
        const item = collection.items.get(id);

        if (third === 'actions' && fourth) {
            if (!item) {
                throw notFound(path);
            }
            return this.runAction(collection, item, fourth, (body ?? {}) as Json);
        }
        if (third === 'metrics') {
            return { metrics: { start: '', end: '', step: 60, time_series: {} } };
        }

        if (!item) {
            throw notFound(path);
        }

        switch (method) {
            case 'GET':
                return { [collection.singular]: item };
            case 'PUT':
                Object.assign(item, body as Json);
                return { [collection.singular]: item };
            case 'DELETE':
                collection.items.delete(id);
                // Servers answer a delete with an action; most others send 204.
                return collection.plural === 'servers'
                    ? { action: this.newAction('delete_server', id) }
                    : {};
            default:
                throw notFound(path);
        }
    }

    private applyFailures(request: string): void {
        const index = this.failures.findIndex((rule) =>
            typeof rule.match === 'string'
                ? request.startsWith(rule.match)
                : rule.match.test(request),
        );
        if (index < 0) {
            return;
        }
        const rule = this.failures[index];
        if (!rule) {
            return;
        }
        rule.times = (rule.times ?? 1) - 1;
        if (rule.times <= 0) {
            this.failures.splice(index, 1);
        }
        throw rule.error;
    }

    private require(plural: string): Collection {
        const collection = this.collections.get(plural);
        if (!collection) {
            throw notFound(`/${plural}`);
        }
        return collection;
    }

    private allocateId(): number {
        this.nextId += 1;
        return this.nextId;
    }

    /* ------------------------------------------------------------------ */
    /* Collection operations                                               */
    /* ------------------------------------------------------------------ */

    private listPage(collection: Collection, params: QueryParams): Json {
        let items = [...collection.items.values()];

        const selector = params.label_selector;
        if (typeof selector === 'string' && selector.length > 0) {
            items = items.filter((item) => matchesSelector(item, selector));
        }
        if (typeof params.name === 'string') {
            items = items.filter((item) => item.name === params.name);
        }
        if (typeof params.type === 'string') {
            items = items.filter((item) => item.type === params.type);
        }
        if (typeof params.fingerprint === 'string') {
            items = items.filter((item) => item.fingerprint === params.fingerprint);
        }

        const perPage = Number(params.per_page ?? this.pageSize);
        const page = Number(params.page ?? 1);
        const start = (page - 1) * perPage;
        const slice = items.slice(start, start + perPage);
        const hasMore = start + perPage < items.length;

        return {
            [collection.plural]: slice,
            meta: {
                pagination: {
                    page,
                    per_page: perPage,
                    next_page: hasMore ? page + 1 : null,
                    last_page: Math.max(1, Math.ceil(items.length / perPage)),
                    total_entries: items.length,
                },
            },
        };
    }

    private create(collection: Collection, body: Json): Json {
        const name = body.name as string | undefined;
        if (name && [...collection.items.values()].some((item) => item.name === name)) {
            throw new HetznerApiError({
                status: 409,
                code: 'uniqueness_error',
                message: `a ${collection.singular} with the name "${name}" already exists`,
                retryable: false,
            });
        }

        const id = this.allocateId();
        const item = this.materialise(collection, id, body);
        collection.items.set(id, item);

        const action = this.newAction(`create_${collection.singular}`, id);
        return { [collection.singular]: item, action, next_actions: [] };
    }

    /** Fills in the server-side fields Hetzner would compute. */
    private materialise(collection: Collection, id: number, body: Json): Json {
        const base: Json = {
            id,
            name: body.name,
            labels: (body.labels as Json) ?? {},
            created: new Date().toISOString(),
        };

        switch (collection.plural) {
            case 'servers':
                return {
                    ...base,
                    status: body.start_after_create === false ? 'off' : 'running',
                    server_type: { id: 1, name: body.server_type },
                    image: { id: 500, name: body.image },
                    datacenter: {
                        id: 2,
                        name: body.datacenter ?? `${body.location ?? 'nbg1'}-dc3`,
                        location: { id: 1, name: body.location ?? 'nbg1' },
                    },
                    public_net: {
                        ipv4: { id, ip: `203.0.113.${id % 250}`, blocked: false, dns_ptr: null },
                        ipv6: { id, ip: `2001:db8::${id.toString(16)}/64`, dns_ptr: [] },
                        floating_ips: [],
                        firewalls: [],
                    },
                    private_net: ((body.networks as number[]) ?? []).map((network, index) => ({
                        network,
                        ip: `10.0.1.${100 + index}`,
                        alias_ips: [],
                    })),
                    ...(body.placement_group !== undefined
                        ? { placement_group: { id: body.placement_group } }
                        : {}),
                    rescue_enabled: false,
                    locked: false,
                    backup_window: null,
                    protection: { delete: false, rebuild: false },
                    volumes: [],
                };
            case 'ssh_keys':
                return {
                    ...base,
                    public_key: body.public_key,
                    fingerprint: fingerprintOf(String(body.public_key ?? '')),
                };
            case 'volumes':
                return {
                    ...base,
                    status: 'available',
                    size: body.size,
                    server: body.server ?? null,
                    location: { id: 1, name: body.location ?? 'nbg1' },
                    format: body.format ?? null,
                    linux_device: `/dev/disk/by-id/scsi-0HC_Volume_${id}`,
                    protection: { delete: false },
                };
            case 'networks':
                return {
                    ...base,
                    ip_range: body.ip_range,
                    subnets: (body.subnets as Json[]) ?? [],
                    routes: (body.routes as Json[]) ?? [],
                    servers: [],
                    load_balancers: [],
                    expose_routes_to_vswitch: body.expose_routes_to_vswitch ?? false,
                    protection: { delete: false },
                };
            case 'firewalls':
                return {
                    ...base,
                    rules: (body.rules as Json[]) ?? [],
                    applied_to: (body.apply_to as Json[]) ?? [],
                };
            case 'load_balancers':
                return {
                    ...base,
                    load_balancer_type: { id: 1, name: body.load_balancer_type },
                    algorithm: (body.algorithm as Json) ?? { type: 'round_robin' },
                    location: { id: 1, name: body.location ?? 'nbg1' },
                    services: (body.services as Json[]) ?? [],
                    targets: (body.targets as Json[]) ?? [],
                    public_net: {
                        enabled: body.public_interface !== false,
                        ipv4: { ip: `203.0.113.${id % 250}`, dns_ptr: null },
                        ipv6: { ip: `2001:db8::lb${id}`, dns_ptr: null },
                    },
                    private_net:
                        body.network !== undefined
                            ? [{ network: body.network, ip: '10.0.1.250' }]
                            : [],
                    protection: { delete: false },
                };
            case 'floating_ips':
                return {
                    ...base,
                    ip: `203.0.113.${id % 250}`,
                    type: body.type ?? 'ipv4',
                    description: body.description ?? null,
                    server: body.server ?? null,
                    home_location: { id: 1, name: body.home_location ?? 'nbg1' },
                    dns_ptr: [],
                    blocked: false,
                    protection: { delete: false },
                };
            case 'primary_ips':
                return {
                    ...base,
                    ip: `203.0.113.${id % 250}`,
                    type: body.type ?? 'ipv4',
                    assignee_id: body.assignee_id ?? null,
                    assignee_type: body.assignee_type ?? 'server',
                    auto_delete: body.auto_delete ?? false,
                    datacenter: { id: 2, name: body.datacenter ?? 'nbg1-dc3' },
                    dns_ptr: [],
                    blocked: false,
                    protection: { delete: false },
                };
            case 'placement_groups':
                return { ...base, type: body.type ?? 'spread', servers: [] };
            case 'certificates':
                return {
                    ...base,
                    type: body.type ?? 'uploaded',
                    certificate: (body.certificate as string) ?? null,
                    domain_names: (body.domain_names as string[]) ?? [],
                    fingerprint: 'aa:bb:cc',
                    not_valid_before: '2026-01-01T00:00:00+00:00',
                    not_valid_after: '2026-12-31T00:00:00+00:00',
                    status:
                        body.type === 'managed'
                            ? { issuance: 'pending', renewal: 'unavailable', error: null }
                            : null,
                    used_by: [],
                };
            case 'images':
                return {
                    ...base,
                    type: 'snapshot',
                    status: 'available',
                    description: body.description,
                    image_size: 12,
                    disk_size: 40,
                    architecture: 'x86',
                    os_flavor: 'ubuntu',
                    protection: { delete: false },
                };
            default:
                return base;
        }
    }

    private catalog(plural: string): Json {
        switch (plural) {
            case 'server_types':
                return {
                    server_types: [
                        { id: 1, name: 'cx22', cores: 2, memory: 4, disk: 40 },
                        { id: 2, name: 'cpx21', cores: 3, memory: 4, disk: 80 },
                        { id: 3, name: 'cpx31', cores: 4, memory: 8, disk: 160 },
                    ],
                    meta: { pagination: { page: 1, next_page: null } },
                };
            case 'locations':
                return {
                    locations: [
                        { id: 1, name: 'nbg1', network_zone: 'eu-central' },
                        { id: 2, name: 'fsn1', network_zone: 'eu-central' },
                    ],
                    meta: { pagination: { page: 1, next_page: null } },
                };
            case 'datacenters':
                return {
                    datacenters: [{ id: 2, name: 'nbg1-dc3', location: { id: 1, name: 'nbg1' } }],
                    meta: { pagination: { page: 1, next_page: null } },
                };
            case 'isos':
                return {
                    isos: [{ id: 9, name: 'debian-12-netinst', architecture: 'x86' }],
                    meta: { pagination: { page: 1, next_page: null } },
                };
            default:
                return { pricing: { currency: 'EUR', vat_rate: '19.00' } };
        }
    }

    /* ------------------------------------------------------------------ */
    /* Actions                                                             */
    /* ------------------------------------------------------------------ */

    private newAction(
        command: string,
        resourceId: number,
        status: Action['status'] = 'success',
    ): Action {
        this.nextActionId += 1;
        const action: Action = {
            id: this.nextActionId,
            command,
            status: this.actionPolls > 0 ? 'running' : status,
            progress: this.actionPolls > 0 ? 0 : 100,
            resources: [{ id: resourceId, type: 'server' }],
            error: null,
        };
        this.actions.set(action.id, { action, pollsLeft: this.actionPolls });
        return action;
    }

    private readAction(id: number): Json {
        const entry = this.actions.get(id);
        if (!entry) {
            throw notFound(`/actions/${id}`);
        }
        if (entry.pollsLeft > 0) {
            entry.pollsLeft -= 1;
            if (entry.pollsLeft === 0) {
                entry.action.status = 'success';
                entry.action.progress = 100;
            }
        }
        return { action: entry.action };
    }

    /** Applies the effect of an action to the stored resource. */
    private runAction(collection: Collection, item: Json, name: string, body: Json): Json {
        const id = item.id as number;

        switch (name) {
            /* Servers */
            case 'poweron':
                item.status = 'running';
                break;
            case 'poweroff':
                item.status = 'off';
                break;
            case 'shutdown':
                // ACPI shutdown is not instant; the guest may ignore it. Tests
                // that need the "did not stop in time" path seed 'running' back.
                item.status = 'off';
                break;
            case 'reboot':
            case 'reset':
                item.status = 'running';
                break;
            case 'change_type':
                // Both servers and load balancers have a change_type action.
                if (collection.plural === 'load_balancers') {
                    item.load_balancer_type = { id: 9, name: body.load_balancer_type };
                } else {
                    item.server_type = { id: 9, name: body.server_type };
                }
                break;
            case 'rebuild':
                item.image = { id: 501, name: body.image };
                break;
            case 'enable_backup':
                item.backup_window = '22-02';
                break;
            case 'disable_backup':
                item.backup_window = null;
                break;
            case 'enable_rescue':
                item.rescue_enabled = true;
                break;
            case 'disable_rescue':
                item.rescue_enabled = false;
                break;
            case 'attach_iso':
                item.iso = { id: 9, name: body.iso };
                break;
            case 'detach_iso':
                item.iso = null;
                break;
            case 'create_image': {
                const images = this.require('images');
                const imageId = this.allocateId();
                const image = this.materialise(images, imageId, {
                    name: null,
                    description: body.description,
                    labels: body.labels,
                });
                image.created_from = { id, name: item.name };
                images.items.set(imageId, image);
                return { image, action: this.newAction('create_image', id) };
            }
            case 'attach_to_network': {
                const nets = (item.private_net as Json[]) ?? [];
                nets.push({
                    network: body.network,
                    ip: body.ip ?? '10.0.1.99',
                    alias_ips: body.alias_ips ?? [],
                });
                item.private_net = nets;
                break;
            }
            case 'detach_from_network':
                item.private_net = ((item.private_net as Json[]) ?? []).filter(
                    (entry) => entry.network !== body.network,
                );
                break;
            case 'change_alias_ips':
                item.private_net = ((item.private_net as Json[]) ?? []).map((entry) =>
                    entry.network === body.network
                        ? { ...entry, alias_ips: body.alias_ips }
                        : entry,
                );
                break;
            case 'add_to_placement_group':
                item.placement_group = { id: body.placement_group };
                break;
            case 'remove_from_placement_group':
                item.placement_group = null;
                break;

            /* Volumes */
            case 'attach':
                item.server = body.server;
                break;
            case 'detach':
                item.server = null;
                break;
            case 'resize':
                item.size = body.size;
                break;

            /* Networks */
            case 'add_subnet': {
                const subnets = (item.subnets as Json[]) ?? [];
                subnets.push({ ...body, gateway: '10.0.0.1' });
                item.subnets = subnets;
                break;
            }
            case 'delete_subnet':
                item.subnets = ((item.subnets as Json[]) ?? []).filter(
                    (entry) => entry.ip_range !== body.ip_range,
                );
                break;
            case 'add_route': {
                const routes = (item.routes as Json[]) ?? [];
                routes.push({ destination: body.destination, gateway: body.gateway });
                item.routes = routes;
                break;
            }
            case 'delete_route':
                item.routes = ((item.routes as Json[]) ?? []).filter(
                    (entry) =>
                        entry.destination !== body.destination || entry.gateway !== body.gateway,
                );
                break;
            case 'change_ip_range':
                item.ip_range = body.ip_range;
                break;

            /* Firewalls */
            case 'set_rules':
                item.rules = body.rules;
                return { actions: [this.newAction('set_firewall_rules', id)] };
            case 'apply_to_resources': {
                const applied = (item.applied_to as Json[]) ?? [];
                item.applied_to = [...applied, ...((body.apply_to as Json[]) ?? [])];
                return { actions: [this.newAction('apply_firewall', id)] };
            }
            case 'remove_from_resources': {
                const removing = (body.remove_from as Json[]) ?? [];
                item.applied_to = ((item.applied_to as Json[]) ?? []).filter(
                    (entry) => !removing.some((target) => sameFirewallTarget(entry, target)),
                );
                return { actions: [this.newAction('remove_firewall', id)] };
            }

            /* Load balancers */
            case 'add_service': {
                const services = (item.services as Json[]) ?? [];
                services.push(body);
                item.services = services;
                break;
            }
            case 'update_service':
                item.services = ((item.services as Json[]) ?? []).map((entry) =>
                    entry.listen_port === body.listen_port ? body : entry,
                );
                break;
            case 'delete_service':
                item.services = ((item.services as Json[]) ?? []).filter(
                    (entry) => entry.listen_port !== body.listen_port,
                );
                break;
            case 'add_target': {
                const targets = ((item.targets as Json[]) ?? []).filter(
                    (entry) => !sameLoadBalancerTarget(entry, body),
                );
                targets.push(body);
                item.targets = targets;
                break;
            }
            case 'remove_target':
                item.targets = ((item.targets as Json[]) ?? []).filter(
                    (entry) => !sameLoadBalancerTarget(entry, body),
                );
                break;
            case 'change_algorithm':
                item.algorithm = { type: body.type };
                break;
            case 'enable_public_interface':
                item.public_net = { ...(item.public_net as Json), enabled: true };
                break;
            case 'disable_public_interface':
                item.public_net = { ...(item.public_net as Json), enabled: false };
                break;

            /* IPs */
            case 'assign':
                if (collection.plural === 'primary_ips') {
                    item.assignee_id = body.assignee_id;
                    item.assignee_type = body.assignee_type ?? 'server';
                } else {
                    item.server = body.server;
                }
                break;
            case 'unassign':
                if (collection.plural === 'primary_ips') {
                    item.assignee_id = null;
                } else {
                    item.server = null;
                }
                break;
            case 'change_dns_ptr': {
                const entries = ((item.dns_ptr as Json[]) ?? []).filter(
                    (entry) => entry.ip !== body.ip,
                );
                entries.push({ ip: body.ip, dns_ptr: body.dns_ptr });
                item.dns_ptr = entries;
                if (collection.plural === 'servers') {
                    const publicNet = (item.public_net as Json) ?? {};
                    const ipv4 = publicNet.ipv4 as Json | undefined;
                    if (ipv4 && ipv4.ip === body.ip) {
                        ipv4.dns_ptr = body.dns_ptr;
                    }
                }
                break;
            }

            /* Everything */
            case 'change_protection':
                item.protection = { ...((item.protection as Json) ?? {}), ...body };
                break;
            case 'retry':
                item.status = { issuance: 'pending', renewal: 'unavailable', error: null };
                break;
            default:
                throw new HetznerApiError({
                    status: 404,
                    code: 'invalid_input',
                    message: `the fake API does not implement the action "${name}"`,
                    retryable: false,
                });
        }

        return { action: this.newAction(name, id) };
    }
}

/* ---------------------------------------------------------------------- */

function notFound(path: string): HetznerApiError {
    return new HetznerApiError({
        status: 404,
        code: 'not_found',
        message: `nothing at ${path}`,
        retryable: false,
    });
}

/** Supports the exact-match selectors the operator actually sends. */
function matchesSelector(item: Json, selector: string): boolean {
    const labels = (item.labels as Record<string, string>) ?? {};
    return selector.split(',').every((clause) => {
        const [key, value] = clause.split('=');
        return key !== undefined && labels[key] === value;
    });
}

function sameFirewallTarget(left: Json, right: Json): boolean {
    if (left.type !== right.type) {
        return false;
    }
    if (left.type === 'server') {
        return (left.server as Json)?.id === (right.server as Json)?.id;
    }
    return (left.label_selector as Json)?.selector === (right.label_selector as Json)?.selector;
}

function sameLoadBalancerTarget(left: Json, right: Json): boolean {
    if (left.type !== right.type) {
        return false;
    }
    switch (left.type) {
        case 'server':
            return (left.server as Json)?.id === (right.server as Json)?.id;
        case 'label_selector':
            return (
                (left.label_selector as Json)?.selector === (right.label_selector as Json)?.selector
            );
        default:
            return (left.ip as Json)?.ip === (right.ip as Json)?.ip;
    }
}

/** Deterministic and obviously fake — never a real fingerprint. */
function fingerprintOf(publicKey: string): string {
    let hash = 0;
    for (const character of publicKey) {
        hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    }
    return (hash.toString(16).padStart(8, '0').match(/.{2}/g) ?? []).join(':');
}
