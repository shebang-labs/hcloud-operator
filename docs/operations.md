# Operating the controller

## Reading a resource

```
$ kubectl describe hsrv web-01
...
Status:
  Conditions:
    Ready               True   ServerRunning
    Synced              True   InSync
    DependenciesReady   True   Resolved
  Id:           4711
  Hetzner Name: demo-web-01
  Phase:        Ready
Events:
  Type     Reason         Age    From                       Message
  Normal   Created        4m12s  hcloud-operator  Created Hetzner HetznerServer 4711 (demo-web-01)
  Normal   Updated        3m58s  hcloud-operator  enabled daily backups
  Warning  GuardRequired  22s    hcloud-operator  spec no longer lists "cpx21", which the server runs; the nearest listed type is "cpx31". Resizing powers the server off and back on, so set spec.allowDowntime: true to apply it.
```

| Condition           | Meaning                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `Ready`             | The Hetzner resource exists and is in a usable state.                   |
| `Synced`            | The spec is fully applied. `False` with `GuardRequired` or `InvalidSpec` means action is needed from you. |
| `DependenciesReady` | Every referenced resource exists and is `Ready`.                        |

Events are emitted on transitions only — created, adopted, changed, blocked,
failed, deleting, orphaned — so a healthy cluster produces none, and identical
events are suppressed for ten minutes so a resource stuck in a retry loop
cannot fill its namespace's event retention.

## Health and metrics

`/healthz`, `/readyz` and `/metrics` on port 8080 (`metrics.port`).

Liveness stays green for a standby replica — a non-leader is healthy, it just
has nothing to do. Readiness is green for a standby too, and for the leader
once its informers have synced. Standbys must be Ready, or a rolling update
could never retire the old leader.

```
hcloud_operator_reconcile_total{kind,outcome}
hcloud_operator_reconcile_duration_seconds{kind}
hcloud_operator_api_request_total{method,route,status}
hcloud_operator_api_request_duration_seconds{method,route}
hcloud_operator_action_total{command,outcome}
hcloud_operator_queue_depth{kind}
hcloud_operator_rate_limit_remaining
hcloud_operator_leader
```

With prometheus-operator: `--set metrics.serviceMonitor.enabled=true`.

Two alerts worth having:

```yaml
- alert: HetznerControllerNoLeader
  expr: sum(hcloud_operator_leader) == 0
  for: 5m
- alert: HetznerControllerRateLimitLow
  expr: hcloud_operator_rate_limit_remaining < 200
  for: 10m
```

## Logs

One JSON object per line. `controller.logLevel` (`debug`, `info`, `warn`,
`error`). The Hetzner token, generated root passwords and certificate private
keys are never logged.

```bash
kubectl -n hcloud-operator logs deploy/hcloud-operator -f | jq -c 'select(.level != "debug")'
```

## Replicas and leader election

Two replicas are the default and are safe: a `coordination.k8s.io` Lease decides
who reconciles, and the standby holds no informers and makes no Hetzner calls
until it wins. `PodDisruptionBudget` and a topology spread constraint keep one
replica available through node drains.

For a single replica, set both — the chart refuses `replicaCount: 2` without a
lease:

```bash
--set replicaCount=1 --set leaderElection.enabled=false
```

## Confining to one namespace

```bash
--set controller.watchNamespace=team-a
```

The chart then creates a `Role` in `team-a` instead of a `ClusterRole`, and the
webhook (if enabled) only intercepts that namespace. Install once per namespace
to give teams separate Hetzner projects.

## Reconciling only some kinds

```bash
--set 'controller.enabledKinds={HetznerServer,HetznerVolume}'
```

## Upgrading

```bash
helm repo update
helm upgrade hcloud-operator shebanglabs/hcloud-operator -n hcloud-operator
```

Helm installs CRDs but never upgrades them. When a release changes a CRD (the
changelog says so), apply them first:

```bash
kubectl apply --server-side -f https://github.com/shebang-labs/hcloud-operator/releases/download/v1.0.0/crds.yaml
```

or, from a checkout, `kubectl apply --server-side -f charts/hcloud-operator/crds/`.

## Uninstalling

```bash
helm uninstall hcloud-operator -n hcloud-operator
```

This removes the controller. It does **not** remove the CRDs or your
`Hetzner*` objects, and therefore does not touch anything in Hetzner. To tear
down the resources themselves, delete the objects first and let the controller
process them:

```bash
kubectl delete hsrv,hvol,hlb,hfip,hpip,hfw,hnet,hpg,hcert,himg,hkey --all -A
```

Objects with `deletionPolicy: Orphan` are released without deleting the Hetzner
resource. If the webhook is enabled, disable it before uninstalling (see
[webhook.md](webhook.md)).

## User data that carries credentials

`spec.userData` is part of the object: readable by anyone with `get` on
`HetznerServer`, printed by `kubectl get -o yaml`, and committed to Git if you
manage the object with GitOps. Cloud-init that holds a cluster join token or a
registry key does not belong there.

Point at a Secret in the same namespace instead:

```yaml
spec:
  serverType: cx22
  image: ubuntu-24.04
  userDataSecretRef:
    name: k3s-agent-cloud-init
    key: user-data          # the default
```

```bash
--set rbac.secretsAccess=true    # the controller needs get on Secrets
```

The document is read once, at create time — Hetzner cannot change a running
server's user data, so neither can the operator — and is never written to
status or logged. `userData` and `userDataSecretRef` are mutually exclusive.

A missing Secret or key fails the create instead of booting a server without
its user data, which would come up unconfigured and could only be fixed by
recreating it. The reconcile retries, so a Secret that is synced in a moment
later by External Secrets or the 1Password operator is fine: the server appears
once it lands.

One Secret can serve many servers. If the document needs per-node values,
prefer deriving them on the node — the hostname, the private NIC's address —
over rendering one Secret per server, which puts you back to managing a
credential per node. See
[`examples/single/user-data-from-secret.yaml`](../examples/single/user-data-from-secret.yaml).

## Environment variables

The chart sets every variable from `values.yaml`; this table is for running the
binary directly.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HETZNER_TOKEN` | *(required)* | API token |
| `HETZNER_API_URL` | `https://api.hetzner.cloud/v1` | Must be `https`, except loopback |
| `HETZNER_TIMEOUT_MS` | `30000` | Per-request timeout |
| `HETZNER_REQUESTS_PER_HOUR` | `3000` | Self-imposed budget, under Hetzner's 3600 |
| `ACTION_TIMEOUT_MS` | `600000` | How long to wait for a Hetzner action |
| `WATCH_NAMESPACE` | *(all)* | Confine to one namespace |
| `ENABLED_KINDS` | *(all)* | Comma-separated subset |
| `RESYNC_PERIOD_MS` | `300000` | Drift check interval |
| `CONCURRENCY` | `2` | Parallel reconciles per kind |
| `RETRY_BASE_DELAY_MS` | `2000` | First retry delay; doubles with jitter |
| `RETRY_MAX_DELAY_MS` | `300000` | Backoff ceiling |
| `HEALTH_PORT` | `8080` | `/healthz`, `/readyz`, `/metrics` |
| `LEADER_ELECTION_ENABLED` | `true` | Turn off only for a single replica |
| `LEADER_ELECTION_NAMESPACE` | `$POD_NAMESPACE` | Where the Lease lives |
| `LEADER_ELECTION_LEASE_NAME` | `hcloud-operator` | |
| `LEADER_ELECTION_LEASE_DURATION_MS` | `15000` | |
| `LEADER_ELECTION_IDENTITY` | `$POD_NAME` | |
| `WEBHOOK_ENABLED` | `false` | Serve the validating webhook |
| `WEBHOOK_PORT` | `9443` | |
| `WEBHOOK_CERT_FILE` / `WEBHOOK_KEY_FILE` | `/etc/webhook/certs/tls.{crt,key}` | |
| `LOG_LEVEL` | `info` | |

Every value is validated at startup; the process refuses to start on bad input
rather than run misconfigured.
