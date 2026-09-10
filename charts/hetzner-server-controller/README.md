# hetzner-server-controller

![Version: 1.0.0](https://img.shields.io/badge/Version-1.0.0-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 1.0.0](https://img.shields.io/badge/AppVersion-1.0.0-informational?style=flat-square)

A Kubernetes operator that manages Hetzner Cloud declaratively: servers, volumes, networks, firewalls, load balancers, floating and primary IPs, certificates, images, SSH keys and placement groups as custom resources.

The only required value is a Hetzner Cloud API token with Read & Write
permission (Hetzner Cloud Console → **Security → API tokens**).

## Install

```bash
helm repo add shebanglabs https://shebang-labs.github.io/hetzner-server-controller
helm install hetzner-server-controller shebanglabs/hetzner-server-controller \
  --namespace hetzner-server-controller --create-namespace \
  --set hetzner.token=<your token>
```

Or as an OCI artifact:

```bash
helm install hetzner-server-controller \
  oci://registry-1.docker.io/shebanglabs/hetzner-server-controller-chart --version 1.0.0 \
  --namespace hetzner-server-controller --create-namespace \
  --set hetzner.token=<your token>
```

To use a Secret you manage yourself (External Secrets, Sealed Secrets, SOPS):

```bash
--set hetzner.existingSecret=<name> --set hetzner.existingSecretKey=token
```

## Common configurations

| Goal | Values |
| --- | --- |
| Single replica | `replicaCount=1 leaderElection.enabled=false` |
| One namespace only (namespaced RBAC) | `controller.watchNamespace=<ns>` |
| Only some kinds | `controller.enabledKinds={HetznerServer,HetznerVolume}` |
| Reject invalid specs at apply time (needs cert-manager) | `webhook.enabled=true` |
| Prometheus Operator | `metrics.serviceMonitor.enabled=true` |
| No access to Secrets (no uploaded certificates) | `rbac.secretsAccess=false` |
| Restrict network traffic | `networkPolicy.enabled=true` |
| Pin the image by digest | `image.digest=sha256:...` |

## CRDs

The chart installs the eleven `hcloud.shebanglabs.io` CRDs from its `crds/`
directory. Helm never upgrades CRDs; when a release changes them, apply them
first with `kubectl apply --server-side -f crds/`. They are kept on
`helm uninstall` so your objects, and the Hetzner resources behind them, are
never touched by removing the controller.

## Requirements

Kubernetes: `>=1.25.0-0`

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| affinity | object | `{}` |  |
| commonLabels | object | `{}` | Extra labels added to every object the chart creates. |
| controller.concurrency | int | `2` | Parallel reconciles per kind. |
| controller.enabledKinds | list | `[]` | Reconcile only these kinds, e.g. `[HetznerServer, HetznerVolume]`. Empty means every kind the controller knows. |
| controller.logLevel | string | `"info"` | Log level: debug, info, warn or error. Logs are JSON, one object per line. |
| controller.resyncPeriodMs | int | `300000` | How often every resource is re-checked for drift, in milliseconds. |
| controller.retryBaseDelayMs | int | `2000` | First retry delay after a failed reconcile, in milliseconds. Doubles with jitter up to `retryMaxDelayMs`. |
| controller.retryMaxDelayMs | int | `300000` | Backoff ceiling, in milliseconds. |
| controller.watchNamespace | string | `""` | Confine the controller to a single namespace. Empty watches every namespace. When set, the chart creates a namespaced Role instead of a ClusterRole. |
| extraEnv | list | `[]` | Additional environment variables for the controller container. |
| extraVolumeMounts | list | `[]` |  |
| extraVolumes | list | `[]` | Additional volumes and volume mounts. |
| fullnameOverride | string | `""` |  |
| hetzner.actionTimeoutMs | int | `600000` | How long to wait for an asynchronous Hetzner action (a server create, a resize) to finish before giving up, in milliseconds. |
| hetzner.apiUrl | string | `"https://api.hetzner.cloud/v1"` | Base URL of the Hetzner Cloud API. Only change this for a local record/replay proxy; anything other than https is refused at startup. |
| hetzner.existingSecret | string | `""` | Name of an existing Secret holding the token, if you prefer to manage it yourself (for example with External Secrets or Sealed Secrets). Takes precedence over `hetzner.token`. |
| hetzner.existingSecretKey | string | `"token"` | Key inside `hetzner.existingSecret` that holds the token. |
| hetzner.requestsPerHour | int | `3000` | Self-imposed request budget per hour. Hetzner allows 3600 per project; staying under it keeps the controller from starving other users of the same token. |
| hetzner.timeoutMs | int | `30000` | Per-request timeout against the Hetzner API, in milliseconds. |
| hetzner.token | string | `""` | Hetzner Cloud API token with Read & Write permission. Create it in the Hetzner Cloud Console under Security -> API tokens. The chart stores it in a Secret. One token means one Hetzner project; run one release per project. |
| image.digest | string | `""` | Pull by digest instead of tag when set, e.g. `sha256:abc...`. |
| image.pullPolicy | string | `"IfNotPresent"` |  |
| image.repository | string | `"shebanglabs/hetzner-server-controller"` |  |
| image.tag | string | `""` | Image tag. Defaults to the chart's appVersion. |
| imagePullSecrets | list | `[]` | Pull secrets for a private mirror of the image. |
| leaderElection.enabled | bool | `true` | Contend for a coordination.k8s.io Lease before reconciling. Only turn this off with `replicaCount: 1`. |
| leaderElection.leaseDurationMs | int | `15000` | How long a lease stays valid without a renewal, in milliseconds. |
| livenessProbe.failureThreshold | int | `3` |  |
| livenessProbe.httpGet.path | string | `"/healthz"` |  |
| livenessProbe.httpGet.port | string | `"http"` |  |
| livenessProbe.initialDelaySeconds | int | `10` |  |
| livenessProbe.periodSeconds | int | `20` |  |
| livenessProbe.timeoutSeconds | int | `5` |  |
| metrics.enabled | bool | `true` | Expose Prometheus metrics on the health port via a Service. |
| metrics.port | int | `8080` |  |
| metrics.service.annotations | object | `{}` |  |
| metrics.service.type | string | `"ClusterIP"` |  |
| metrics.serviceMonitor.enabled | bool | `false` | Create a prometheus-operator ServiceMonitor. |
| metrics.serviceMonitor.interval | string | `"30s"` |  |
| metrics.serviceMonitor.labels | object | `{}` |  |
| metrics.serviceMonitor.metricRelabelings | list | `[]` |  |
| metrics.serviceMonitor.relabelings | list | `[]` |  |
| metrics.serviceMonitor.scrapeTimeout | string | `"10s"` |  |
| nameOverride | string | `""` |  |
| networkPolicy.enabled | bool | `false` | Restrict the controller Pods to the API server, DNS, the Hetzner API and incoming metrics/webhook traffic. |
| networkPolicy.extraEgress | list | `[]` | Extra egress rules, appended to the defaults. |
| networkPolicy.extraIngress | list | `[]` | Extra ingress rules, appended to the defaults. |
| nodeSelector | object | `{}` |  |
| podAnnotations | object | `{}` |  |
| podDisruptionBudget.enabled | bool | `true` | Keep one controller Pod available during node drains. |
| podDisruptionBudget.minAvailable | int | `1` |  |
| podLabels | object | `{}` |  |
| podSecurityContext.fsGroup | int | `65532` |  |
| podSecurityContext.runAsGroup | int | `65532` |  |
| podSecurityContext.runAsNonRoot | bool | `true` |  |
| podSecurityContext.runAsUser | int | `65532` |  |
| podSecurityContext.seccompProfile.type | string | `"RuntimeDefault"` |  |
| priorityClassName | string | `""` |  |
| rbac.create | bool | `true` | Create the ClusterRole/Role and bindings the controller needs. |
| rbac.secretsAccess | bool | `true` | Grant `get` on Secrets. Needed only for `HetznerCertificate` with `type: uploaded`, which reads PEM material from a Secret. This is the broadest permission the controller holds; turn it off if you do not use uploaded certificates. |
| readinessProbe.failureThreshold | int | `3` |  |
| readinessProbe.httpGet.path | string | `"/readyz"` |  |
| readinessProbe.httpGet.port | string | `"http"` |  |
| readinessProbe.initialDelaySeconds | int | `5` |  |
| readinessProbe.periodSeconds | int | `10` |  |
| readinessProbe.timeoutSeconds | int | `5` |  |
| replicaCount | int | `2` | Number of controller Pods. Two is safe: leader election ensures only one reconciles, and the standby takes over within the lease duration. |
| resources.limits.memory | string | `"512Mi"` |  |
| resources.requests.cpu | string | `"50m"` |  |
| resources.requests.memory | string | `"128Mi"` |  |
| securityContext.allowPrivilegeEscalation | bool | `false` |  |
| securityContext.capabilities.drop[0] | string | `"ALL"` |  |
| securityContext.readOnlyRootFilesystem | bool | `true` |  |
| serviceAccount.annotations | object | `{}` |  |
| serviceAccount.automountServiceAccountToken | bool | `true` |  |
| serviceAccount.create | bool | `true` |  |
| serviceAccount.name | string | `""` | Name of the ServiceAccount. Generated from the release name when empty. |
| terminationGracePeriodSeconds | int | `60` | Time for in-flight reconciles to finish before SIGKILL. A Hetzner action takes seconds, not minutes. |
| tolerations | list | `[]` |  |
| topologySpreadConstraints | list | `[{"labelSelector":{"matchLabels":{"app.kubernetes.io/instance":"{{ .Release.Name }}","app.kubernetes.io/name":"{{ include \"hetzner-server-controller.name\" . }}"}},"maxSkew":1,"topologyKey":"kubernetes.io/hostname","whenUnsatisfiable":"ScheduleAnyway"}]` | Spread the replicas across nodes so one node failure cannot take both. |
| webhook.certManager.createIssuer | bool | `true` | Create a self-signed Issuer for the webhook certificate. Set to false and fill `issuerRef` to use your own. |
| webhook.certManager.duration | string | `"2160h"` | Certificate validity. |
| webhook.certManager.issuerRef | object | `{}` | Reference to an existing cert-manager Issuer or ClusterIssuer. |
| webhook.certManager.renewBefore | string | `"360h"` |  |
| webhook.enabled | bool | `false` | Serve a validating admission webhook that rejects an invalid spec at `kubectl apply` time, with the valid alternatives in the error message. Requires cert-manager. Without it the same problem is reported on the object's `Synced` condition a few seconds later. |
| webhook.failurePolicy | string | `"Fail"` | What the API server does when the webhook is unreachable. `Fail` is the safe default: an unchecked spec would create real, billable infrastructure. Uninstall order matters, see docs/webhook.md. |
| webhook.port | int | `9443` |  |
| webhook.timeoutSeconds | int | `5` |  |

## Uninstall

```bash
helm uninstall hetzner-server-controller -n hetzner-server-controller
```

If the webhook is enabled, disable it first (`--set webhook.enabled=false`);
see [docs/webhook.md](../../docs/webhook.md).

----------------------------------------------
Autogenerated from chart metadata using [helm-docs v1.14.2](https://github.com/norwoodj/helm-docs/releases/v1.14.2)
