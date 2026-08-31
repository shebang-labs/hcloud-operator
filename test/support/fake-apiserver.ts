/**
 * A minimal Kubernetes API server, over plain HTTP.
 *
 * Node has no equivalent of controller-runtime's envtest, and the informer is
 * the one part of this operator that cannot be tested with an in-memory fake:
 * it does a real LIST followed by a real chunked WATCH, and reconnects on its
 * own. Stubbing `makeInformer` would leave exactly the code most likely to be
 * wrong — the watch wiring, the resync, the restart-on-error — unexercised.
 *
 * So this serves the two verbs an informer uses, well enough that the real
 * client library talks to it without knowing the difference:
 *
 *   GET  /apis/<group>/<version>/<plural>                 -> a List
 *   GET  /apis/<group>/<version>/<plural>?watch=true      -> newline-delimited events
 *
 * It also serves the namespaced paths and the `/status` subresource, so the
 * real `ResourceStore` can be pointed at it too.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { KubeConfig } from '@kubernetes/client-node';
import type { AnyManagedResource } from '../../src/kube/api.js';

export type WatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED';

interface OpenWatch {
    write(line: string): void;
    end(): void;
}

export interface FakeApiServerOptions {
    group: string;
    version: string;
    plural: string;
    kind: string;
}

export class FakeApiServer {
    private readonly server: Server;
    private readonly objects = new Map<string, AnyManagedResource>();
    private readonly watchers = new Set<OpenWatch>();
    private readonly options: FakeApiServerOptions;

    private revision = 1;
    private port = 0;

    /** Every request path the client asked for, in order. */
    readonly requests: string[] = [];
    /** Set to make the next LIST fail, simulating a missing CRD or bad RBAC. */
    failListWith?: number;

    constructor(options: FakeApiServerOptions) {
        this.options = options;
        this.server = createServer((request, response) => {
            const url = new URL(request.url ?? '/', 'http://internal');
            this.requests.push(url.pathname + url.search);

            if (!url.pathname.includes(`/${this.options.plural}`)) {
                response.writeHead(404).end('{}');
                return;
            }

            if (url.searchParams.get('watch') === 'true') {
                this.openWatch(response);
                return;
            }

            if (this.failListWith) {
                const code = this.failListWith;
                response
                    .writeHead(code, { 'Content-Type': 'application/json' })
                    .end(JSON.stringify({ kind: 'Status', code, message: 'nope' }));
                return;
            }

            const body = JSON.stringify({
                apiVersion: `${this.options.group}/${this.options.version}`,
                kind: `${this.options.kind}List`,
                metadata: { resourceVersion: String(this.revision) },
                items: [...this.objects.values()],
            });
            response.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
        });
    }

    private openWatch(response: import('node:http').ServerResponse): void {
        response.writeHead(200, {
            'Content-Type': 'application/json',
            'Transfer-Encoding': 'chunked',
        });
        // Node buffers the head until the first write. A watch may legitimately
        // send nothing for minutes, and the client will not consider the watch
        // established until the headers arrive — so flush them now.
        response.flushHeaders();
        const watcher: OpenWatch = {
            write: (line) => response.write(line),
            end: () => response.end(),
        };
        this.watchers.add(watcher);
        response.on('close', () => this.watchers.delete(watcher));
    }

    async start(): Promise<void> {
        await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
        this.port = (this.server.address() as AddressInfo).port;
    }

    async stop(): Promise<void> {
        for (const watcher of this.watchers) {
            watcher.end();
        }
        this.watchers.clear();
        this.server.closeAllConnections?.();
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }

    /** A KubeConfig the operator's own client factory would produce. */
    kubeConfig(): KubeConfig {
        const config = new KubeConfig();
        config.loadFromOptions({
            clusters: [{ name: 'fake', server: this.url, skipTLSVerify: true }],
            users: [{ name: 'fake' }],
            contexts: [{ name: 'fake', cluster: 'fake', user: 'fake' }],
            currentContext: 'fake',
        });
        return config;
    }

    get url(): string {
        return `http://127.0.0.1:${this.port}`;
    }

    /** Number of watch connections currently open. */
    get openWatches(): number {
        return this.watchers.size;
    }

    /** Puts an object into the collection without emitting a watch event. */
    seed(resource: AnyManagedResource): void {
        this.objects.set(keyOf(resource), resource);
    }

    /** Applies a change and tells every open watch about it, as the API server does. */
    emit(type: WatchEventType, resource: AnyManagedResource): void {
        this.revision += 1;
        const object = {
            ...resource,
            metadata: { ...resource.metadata, resourceVersion: String(this.revision) },
        };

        if (type === 'DELETED') {
            this.objects.delete(keyOf(object));
        } else {
            this.objects.set(keyOf(object), object);
        }

        const line = `${JSON.stringify({ type, object })}\n`;
        for (const watcher of this.watchers) {
            watcher.write(line);
        }
    }

    /** Drops every open watch, as a rolling API server upgrade would. */
    dropWatches(): void {
        for (const watcher of this.watchers) {
            watcher.end();
        }
        this.watchers.clear();
    }
}

function keyOf(resource: AnyManagedResource): string {
    return `${resource.metadata?.namespace ?? 'default'}/${resource.metadata?.name ?? ''}`;
}

/** Waits until `condition` holds, or fails the caller by timing out. */
export async function eventually(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`condition was not met within ${timeoutMs}ms`);
}
