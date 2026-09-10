# hetzner-server-controller

[![CI](https://github.com/shebang-labs/hetzner-server-controller/actions/workflows/ci.yaml/badge.svg)](https://github.com/shebang-labs/hetzner-server-controller/actions/workflows/ci.yaml)
[![Release](https://img.shields.io/github/v/release/shebang-labs/hetzner-server-controller?sort=semver)](https://github.com/shebang-labs/hetzner-server-controller/releases)
[![Docker pulls](https://img.shields.io/docker/pulls/shebanglabs/hetzner-server-controller)](https://hub.docker.com/r/shebanglabs/hetzner-server-controller)
[![Artifact Hub](https://img.shields.io/endpoint?url=https://artifacthub.io/badge/repository/hetzner-server-controller)](https://artifacthub.io/packages/search?repo=hetzner-server-controller)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Kubernetes operator that manages a whole [Hetzner Cloud](https://www.hetzner.com/cloud)
project declaratively. Servers, volumes, networks, firewalls, load balancers,
IPs, certificates, images, SSH keys and placement groups — all of them applied
the same way you apply a Deployment.

```yaml
apiVersion: hcloud.shebanglabs.io/v1alpha1
kind: HetznerServer
metadata:
  name: web-01
spec:
  serverType: cpx21
  image: ubuntu-24.04
  location: nbg1
  powerState: Running
  backups: true
```

```
$ kubectl get hsrv
NAME     STATUS    TYPE    IPV4             PHASE   READY   AGE
web-01   running   cpx21   203.0.113.42     Ready   True    2m
```

## Install

You need a Hetzner Cloud API token with **Read & Write** permission (Hetzner
Cloud Console → your project → **Security → API tokens**). That is the only
required input.

```bash
helm repo add shebanglabs https://shebang-labs.github.io/hetzner-server-controller
helm install hetzner-server-controller shebanglabs/hetzner-server-controller \
  --namespace hetzner-server-controller --create-namespace \
  --set hetzner.token=<your token>
```

The same chart is also published as an OCI artifact:

```bash
helm install hetzner-server-controller \
  oci://registry-1.docker.io/shebanglabs/hetzner-server-controller-chart --version 1.0.0 \
  --namespace hetzner-server-controller --create-namespace \
  --set hetzner.token=<your token>
```

Prefer to manage the Secret yourself (External Secrets, Sealed Secrets, SOPS)?
Point the chart at it instead:

```bash
kubectl -n hetzner-server-controller create secret generic hcloud --from-literal=token=<your token>
helm install hetzner-server-controller shebanglabs/hetzner-server-controller \
  --namespace hetzner-server-controller \
  --set hetzner.existingSecret=hcloud
```

Then try the whole stack — a network, a placement group, servers, a volume, a
firewall, a certificate, a load balancer and a floating IP, applied in one go
and in any order:

```bash
kubectl apply -f https://raw.githubusercontent.com/shebang-labs/hetzner-server-controller/main/examples/stack/00-namespace.yaml
kubectl apply -f examples/stack/
kubectl -n demo get hsrv,hvol,hnet,hfw,hlb
```

<details>
<summary>Argo CD</summary>

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: hetzner-server-controller
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://shebang-labs.github.io/hetzner-server-controller
    chart: hetzner-server-controller
    targetRevision: 1.0.0
    helm:
      valuesObject:
        hetzner:
          existingSecret: hcloud
  destination:
    server: https://kubernetes.default.svc
    namespace: hetzner-server-controller
  syncPolicy:
    syncOptions: [CreateNamespace=true, ServerSideApply=true]
```
</details>

<details>
<summary>Flux</summary>

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: shebanglabs
  namespace: flux-system
spec:
  interval: 1h
  url: https://shebang-labs.github.io/hetzner-server-controller
---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: hetzner-server-controller
  namespace: hetzner-server-controller
spec:
  interval: 30m
  chart:
    spec:
      chart: hetzner-server-controller
      version: 1.x
      sourceRef:
        kind: HelmRepository
        name: shebanglabs
        namespace: flux-system
  values:
    hetzner:
      existingSecret: hcloud
```
</details>

One token means one Hetzner project. To manage several projects, install the
chart once per project, each in its own namespace with `controller.watchNamespace`
set. Every chart option is documented in
[`charts/hetzner-server-controller/README.md`](charts/hetzner-server-controller/README.md).

Images are multi-arch (`linux/amd64`, `linux/arm64`), signed with cosign and
published to Docker Hub as
[`shebanglabs/hetzner-server-controller`](https://hub.docker.com/r/shebanglabs/hetzner-server-controller).
Tags: `1.2.3` (a release), `latest` (the newest release), `dev` (tip of `main`),
`<commit-sha>` (every build, immutable).

## What it manages

| Kind                    | Short   | Covers                                                                         |
| ----------------------- | ------- | ------------------------------------------------------------------------------ |
| `HetznerServer`         | `hsrv`  | Power state, resize, rebuild, backups, rescue, ISO, reverse DNS, networks, placement group, protection |
| `HetznerVolume`         | `hvol`  | Size (grow-only), attachment, filesystem, protection                           |
| `HetznerNetwork`        | `hnet`  | IP range, subnets, routes, vSwitch exposure, protection                        |
| `HetznerFirewall`       | `hfw`   | Rules, applied to servers or Hetzner label selectors                           |
| `HetznerLoadBalancer`   | `hlb`   | Services, health checks, TLS, targets, algorithm, private network              |
| `HetznerFloatingIP`     | `hfip`  | Assignment, reverse DNS, protection                                            |
| `HetznerPrimaryIP`      | `hpip`  | Assignment, auto-delete, reverse DNS, protection                               |
| `HetznerSSHKey`         | `hkey`  | Public keys in the project                                                     |
| `HetznerPlacementGroup` | `hpg`   | Spread groups                                                                  |
| `HetznerCertificate`    | `hcert` | Uploaded (from a Secret) and Hetzner-managed Let's Encrypt                     |
| `HetznerImage`          | `himg`  | Snapshots of a server's disk                                                   |

`kubectl explain hetznerserver.spec` shows every field with its documentation;
the CRDs are the source of truth. Working examples for every kind are in
[`examples/`](examples/).

## Imperative operations as desired state

Hetzner's API is imperative: you *call* `poweroff`, you *call* `change_type`.
The controller turns each of those into a field you set and forget.

| Set this                       | The controller does                                  | Guard needed    |
| ------------------------------ | ---------------------------------------------------- | --------------- |
| `powerState: Stopped`          | ACPI shutdown, then power off after the grace period | —               |
| `serverType: cpx31`            | Power off → change type → power back on              | `allowDowntime` |
| `image: debian-12`             | Rebuild — **erases the disk**                        | `allowDataLoss` |
| `backups: true`                | Enable daily backups                                 | —               |
| `rescue: { enabled: true }`    | Arm the rescue system for the next boot              | —               |
| `iso: debian-12-netinst`       | Attach the ISO (`null` detaches)                     | —               |
| `protection: { delete: true }` | Refuse deletion until turned off                     | —               |
| `dnsPtr: [...]`                | Publish reverse DNS                                  | —               |

Without its guard flag, a destructive change is **reported, not applied**: the
`Synced` condition goes False with an explanation, and nothing reboots.

```
$ kubectl describe hsrv web-01
...
  Synced   False   GuardRequired   spec.serverType is "cpx31" but the server runs
                                   "cpx21". Resizing powers the server off and back
                                   on, so set spec.allowDowntime: true to apply it.
```

## Adopting what you already have

`spec.adoptExisting` takes over a Hetzner resource that predates the controller
instead of creating a new one, and `deletionPolicy: Orphan` guarantees that
deleting the Kubernetes object leaves the real thing running:

```yaml
spec:
  adoptExisting: web-old-01
  deletionPolicy: Orphan
```

See [docs/adoption.md](docs/adoption.md).

## References and ordering

Resources refer to each other by name, and no ordering is required. A reference
to something that does not exist yet sets `DependenciesReady=False` and requeues
— a wait, not a failure. Every reference takes one of three forms:

```yaml
networkRef: { name: prod }          # a HetznerNetwork in this namespace
networkRef: { hetznerName: legacy } # something unmanaged, already in Hetzner
networkRef: { id: 4711 }            # a raw Hetzner id
```

Each relationship is declared from exactly one side, so two controllers can
never fight over it. [docs/relationships.md](docs/relationships.md) says which.

## Rejecting typos at apply time

An optional validating admission webhook turns a bad spec into an immediate
rejection, with the valid alternatives in the message:

```
$ kubectl apply -f server.yaml
Error from server: admission webhook "validate.hcloud.shebanglabs.io" denied
the request: HetznerServer spec is invalid: spec.serverType "cpx99" does not
exist in this Hetzner project. Valid values: cax11, cax21, ccx13, cpx11,
cpx21, cpx31, cx22, cx32, and 9 more
```

It needs cert-manager and is off by default: `--set webhook.enabled=true`.
Without it the same typo lands on the object's `Synced` condition a few seconds
later. See [docs/webhook.md](docs/webhook.md).

## Operating it

- **Events** explain what the controller did; **conditions** (`Ready`, `Synced`,
  `DependenciesReady`) explain what state a resource is in. `kubectl describe`
  shows both.
- **Metrics** in Prometheus format on `/metrics` (port 8080), with an optional
  `ServiceMonitor`. **Logs** are JSON, one object per line.
- **Two replicas by default.** Leader election uses a `coordination.k8s.io`
  Lease; the standby holds no informers and touches no Hetzner API until it wins.
- **Least privilege.** No `create` or `delete` on the custom resources, no
  wildcards, one `get` on Secrets that you can turn off, a lease Role scoped to
  the controller's namespace.
- **The token never leaves the Pod except to `api.hetzner.cloud`.** The API URL
  must be `https`, redirects are never followed, and the client emits its own
  sanitized error type so an `Authorization` header can never reach a log line.

Everything above is covered in detail in [docs/operations.md](docs/operations.md)
and [SECURITY.md](SECURITY.md).

## How it works

Five layers, each depending only downward. `framework/` knows nothing about
Hetzner; `hcloud/` knows nothing about Kubernetes. The adapters are the only
place the two meet, which is why every layer is testable without a cluster and
without an API token.

```
main.ts
  ├── admission/    optional validating webhook, sharing the adapters' validate()
  └── framework/    Operator, ResourceController, ReconcileEngine, WorkQueue
        └── resources/   11 adapters — the only Hetzner-specific reconcile logic
              └── hcloud/    typed API client per endpoint + action polling
                    └── kube/, observability/, config/
```

The reconcile engine does everything generic once, for all eleven kinds: add
the finalizer *before* creating anything, gate on dependencies, find the remote
resource by recorded id, then by owner label, then by adoption, create or
converge, project reality into status. An adapter contributes only what
genuinely differs per resource:

```ts
interface ResourceAdapter<TSpec, TStatus, TRemote> {
  readonly descriptor: ResourceDescriptor;
  readonly api: OwnedRemoteApi<TRemote>;
  validate?(spec): string[];                       // pure
  create(context): Promise<TRemote>;
  update(context, remote): Promise<UpdateOutcome>;
  project(remote, spec): Projection<TStatus>;      // pure
  drift?(context, remote): string | undefined;     // pure
}
```

Adding a twelfth Hetzner resource is one file in `src/resources/`, one CRD, one
line in the registry. [docs/architecture.md](docs/architecture.md) has the
details and the design decisions behind them.

## Development

```bash
npm install
npm run verify        # lint + typecheck + tests
npm run chart:lint    # helm lint
```

No cluster and no Hetzner account are needed. The test suite runs against an
in-memory Hetzner API with real semantics — id allocation, label selectors, the
action lifecycle, pagination, injectable failures — and a fake Kubernetes API
server that serves genuine LIST and chunked WATCH responses to the real
informer. See [CONTRIBUTING.md](CONTRIBUTING.md).

To run against a real cluster from your laptop, using `~/.kube/config`:

```bash
HETZNER_TOKEN=... LEADER_ELECTION_ENABLED=false npm run build && npm start
```

## Contributing and security

Pull requests are welcome; [CONTRIBUTING.md](CONTRIBUTING.md) is short.
Security issues go to [SECURITY.md](SECURITY.md), privately.

## License

[MIT](LICENSE) © Shebang Labs.
