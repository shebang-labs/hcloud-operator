# Architecture

## Layers

Five layers, each depending only downward.

```
main.ts
  ├── admission/      optional validating webhook (shares the adapters' validate())
  └── framework/      Operator, ResourceController, ReconcileEngine, WorkQueue
        └── resources/    one adapter per Hetzner resource
              └── hcloud/     typed Hetzner API client per endpoint, action polling, rate limiting
                    └── kube/, observability/, config/
```

- `framework/` knows nothing about Hetzner. It could drive any provider whose
  resources have an id, labels and a create/update/delete lifecycle.
- `hcloud/` knows nothing about Kubernetes. It is a small, typed client for the
  parts of the Hetzner Cloud API this project uses.
- `resources/` is the only place the two meet. Each adapter is one file (the
  server, being large, is a directory).

This is what lets every layer be tested without a cluster and without a token.

## The reconcile engine

`ReconcileEngine` (`src/framework/reconcile-engine.ts`) does everything that is
the same for every kind, once:

1. Read the object from the API server. Gone? Done.
2. Being deleted? Honour `spec.deletionPolicy`, delete the Hetzner resource, wait
   until it is really gone, then remove the finalizer.
3. No finalizer yet? Add it **before** creating anything. A crash between
   "server created" and "finalizer added" would otherwise leave a running server
   nobody cleans up.
4. Validate the spec. An invalid spec is a permanent condition, not a retry.
5. Resolve references. A dependency that is not `Ready` yet sets
   `DependenciesReady=False` and requeues without consuming the retry budget.
6. Find the Hetzner resource: by the id recorded in `status.id`, then by the
   owner label carrying `metadata.uid`, then by `spec.adoptExisting`.
7. Not found → create it and record the id in status immediately.
8. Found → sync ownership labels, let the adapter converge the rest, project the
   remote state into `status`.

### The adapter contract

```ts
interface ResourceAdapter<TSpec, TStatus, TRemote> {
  readonly descriptor: ResourceDescriptor;       // kind, plural, short names
  readonly api: OwnedRemoteApi<TRemote>;         // getById / findByOwner / delete
  validate?(spec: TSpec): string[];              // pure; also run by the webhook
  create(context): Promise<TRemote>;
  update(context, remote): Promise<UpdateOutcome>; // converge mutable fields
  delete?(context, remote): Promise<void>;       // only when the default is wrong
  project(remote, spec): Projection<TStatus>;    // pure: remote -> status + readiness
  drift?(context, remote): string | undefined;   // pure: immutable drift to report
}
```

`update` and `project` are separate on purpose: `project` is pure and gets
table-driven tests with no fakes at all.

### Guards

Some converge steps are destructive: a resize reboots, a rebuild erases the
disk, a volume re-attach detaches first. Each has a guard flag in the spec
(`allowDowntime`, `allowDataLoss`, `allowDetach`). Without the guard, the adapter
returns a `blocked` outcome: the engine sets `Synced=False` with reason
`GuardRequired` and emits an Event explaining exactly which flag to set. Nothing
is applied.

## Ownership

Every Hetzner resource the controller creates carries labels:

```
hcloud.shebanglabs.io/managed-by = hcloud-operator
hcloud.shebanglabs.io/uid        = <metadata.uid>
hcloud.shebanglabs.io/namespace  = <metadata.namespace>
hcloud.shebanglabs.io/name       = <metadata.name>
hcloud.shebanglabs.io/kind       = HetznerServer
```

Kubernetes never reuses a uid, so the controller can always answer "does a
resource for this object already exist?" — even after crashing before it wrote
`status.id`. Creating with a name that already exists (`uniqueness_error`) is
recovered the same way.

## Work queue

One `WorkQueue` per kind: keys are deduplicated, one reconcile runs per key at a
time, failures back off exponentially with jitter between `RETRY_BASE_DELAY_MS`
and `RETRY_MAX_DELAY_MS`, and a `Retry-After` from Hetzner is honoured. Errors
the Hetzner client classifies as permanent (a 4xx that will not change until
the spec does) are not retried on the backoff schedule; the periodic resync
still re-checks them.

The watch only enqueues when `metadata.generation` moves. Every CRD declares
`subresources.status`, so that covers spec changes and deletions but not the
status the engine itself writes on every pass — which would otherwise come back
as an event, mark the running key dirty, and cancel the delay the queue was
about to apply. Anything that changes without the generation moving is therefore
invisible to the watch and is picked up by the resync instead: drift in Hetzner,
and our own finalizer being added.

## Hetzner client

- Nearly every mutating call returns an `Action` still `running`. The client
  polls it to a terminal state; treating the `201` as done is the classic Hetzner
  bug (attach a volume, read the server back, see nothing).
- A single token bucket shared by all controllers keeps the operator under the
  project-wide limit of 3600 requests/hour, so it never starves anything else
  using the same token.
- List endpoints auto-paginate. An unpaginated "find by owner label" works
  perfectly until a project grows past 25 servers.
- Redirects are never followed and only `https` is accepted: the bearer token
  travels on every request.
- Every failure is converted to the client's own error type before it can reach
  a logger, because an axios error carries the request — headers included.

## Leader election

`coordination.k8s.io` Lease, renewed every third of the lease duration. A
transient failure to renew is retried until the lease would have expired; only
then does the replica step down and exit so Kubernetes restarts it as a
standby. On SIGTERM the operator stops reconciling first, then releases the
lease, so a rolling update never has two replicas acting at once.

## Testing strategy

- `test/support/fake-hcloud.ts` is an in-memory Hetzner API with real semantics:
  id allocation, label selectors, the action lifecycle, `uniqueness_error`,
  pagination, injectable failures. It implements the transport interface, so
  every test above it exercises the real endpoint modules and the real JSON.
- `test/support/fake-apiserver.ts` serves genuine LIST and chunked WATCH
  responses so the real `@kubernetes/client-node` informer is what gets tested —
  reconnection after a dropped watch, the resync timer, the startup preflight.
- `test/manifests/` renders the Helm chart with the real `helm` binary and
  checks RBAC covers every verb the code uses, validates every example against
  the CRD schemas, and keeps versions, names and workflow hardening consistent.
