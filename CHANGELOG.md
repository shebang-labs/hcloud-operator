# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The public contract covered by that versioning is: the CRD schemas, the Helm
chart values, the environment variables, the status conditions and their
reasons, the metric names, and the Hetzner labels the controller writes.
Internal package layout is not part of it.

## [Unreleased]

## [1.2.0] — 2026-09-21

### Added

- `HetznerServer.spec.serverTypes` takes an ordered list of server types and
  creates the server as the first one Hetzner can place. Hetzner answers
  `412 resource_unavailable` when a type has no capacity in a location, and
  retrying does not help — one observed incident took 149 refusals across 31
  minutes while the next size down placed on the first try. Only a capacity
  error advances the list; any other failure stops on the first entry. When no
  entry can be placed the failure is retryable, so the work queue backs off and
  comes back. The type it landed on is reported in `status.serverType` and in a
  one-off `Normal` `ServerTypeFallback` event.

### Changed

- A `HetznerServer` is in sync with *any* type listed in `spec.serverTypes`, not
  only the first. A server that fell back to a smaller type is never resized
  back up: a resize means downtime for a working node, and Hetzner cannot shrink
  a disk that a resize grew. A type that has left the list entirely is still
  drift and still needs `allowDowntime`.
- `HetznerServer.spec.serverType` is deprecated in favour of `serverTypes` and
  is read as a single-entry list. It keeps working and will be removed in a
  future major version.
- The `HetznerServer` CRD gains a field, so apply the CRDs before upgrading:
  Helm installs them but never upgrades them. Existing objects are unaffected.

### Fixed

- The controller no longer reconciles on its own status writes. Each write came
  back through the watch as an event, and while a reconcile was running that
  cancelled the delay the work queue was about to apply — so the exponential
  backoff was never reached. A `HetznerServer` that Hetzner could not place for
  lack of capacity retried `POST /servers` for 31 minutes without backing off,
  and an object waiting on a missing reference retried roughly every 1.2s
  instead of every 15s. The watch now enqueues only when `metadata.generation`
  changes; drift in Hetzner is still picked up by the periodic resync.

## [1.1.2] — 2026-09-13

### Fixed

- The `HetznerCertificate`, `HetznerFirewall` and `HetznerPlacementGroup` CRDs
  no longer declare an empty `required: []` on their spec. The API server drops
  the empty list on admission, so a GitOps controller comparing the chart with
  the cluster (ArgoCD) reported those three CRDs `OutOfSync` after every sync.

## [1.1.1] — 2026-09-12

### Fixed

- `HetznerImage.status.imageSize` is now a `number`. Hetzner reports
  `image_size` with a fractional part (`48.36` GB); the integer schema made the
  API server reject every status write for a finished snapshot with 422, so the
  object stayed `Creating` (`Synced=False ReconcileError: HTTP-Code: 422`)
  although the snapshot existed and was available. Apply the CRDs before
  upgrading; a `HetznerImage` already stuck this way recovers on its next
  reconcile.

## [1.1.0] — 2026-09-11

### Added

- `HetznerServer.spec.userDataSecretRef` reads the cloud-init user data from a
  Secret in the object's namespace instead of inlining it, so user data that
  carries credentials — a cluster join token, a registry key — does not have to
  live in a custom resource or in Git. Read once at create time, never written
  to status, and mutually exclusive with `spec.userData`. Needs the controller's
  optional Secret read permission (`rbac.secretsAccess=true`); without it the
  create fails with that instruction rather than booting a server whose user
  data never arrived.

### Changed

- The `HetznerServer` CRD gains a field, so apply the CRDs before upgrading:
  Helm installs them but never upgrades them. Existing objects are unaffected.

## [1.0.0] — 2026-09-10

First public release.

### Added

- Eleven managed resources under `hcloud.shebanglabs.io/v1alpha1`:
  `HetznerServer`, `HetznerSSHKey`, `HetznerVolume`, `HetznerNetwork`,
  `HetznerFirewall`, `HetznerLoadBalancer`, `HetznerFloatingIP`,
  `HetznerPrimaryIP`, `HetznerPlacementGroup`, `HetznerCertificate` and
  `HetznerImage`.
- Imperative Hetzner server operations expressed as desired state: power state,
  resize, rebuild, backups, rescue mode, ISO attachment, reverse DNS, protection,
  private networks (including a requested private IP) and placement group
  membership. Destructive changes require an explicit guard (`allowDowntime`,
  `allowDataLoss`, `allowDetach`) and are reported on the `Synced` condition
  until it is set.
- `spec.adoptExisting` to take over Hetzner resources that predate the
  controller, and `spec.deletionPolicy: Orphan` to leave them running when the
  object is deleted.
- Cross-resource references by object name, by unmanaged Hetzner name or by raw
  id, with dependency gating so manifests apply in any order.
- A Helm chart (`charts/hcloud-operator`) as the supported install:
  token from a value or an existing Secret, cluster-wide or single-namespace
  RBAC, optional validating webhook via cert-manager, ServiceMonitor,
  PodDisruptionBudget, NetworkPolicy, a values schema and `helm test`.
- Lease-based leader election with a renewal grace period, so two replicas are
  safe and a single API-server hiccup does not restart the controller.
- Prometheus metrics, structured JSON logging, Kubernetes Events, and
  `/healthz`, `/readyz` and `/metrics` endpoints.
- An optional validating admission webhook that rejects unknown server types,
  locations, datacenters, images and ISOs at `kubectl apply` time, checking only
  changed fields on update so retired catalog entries never block edits.
- Multi-arch images (`linux/amd64`, `linux/arm64`) on Docker Hub, signed with
  cosign and shipped with an SBOM and provenance.

[Unreleased]: https://github.com/shebang-labs/hcloud-operator/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/shebang-labs/hcloud-operator/releases/tag/v1.2.0
[1.1.2]: https://github.com/shebang-labs/hcloud-operator/releases/tag/v1.1.2
[1.1.1]: https://github.com/shebang-labs/hcloud-operator/releases/tag/v1.1.1
[1.1.0]: https://github.com/shebang-labs/hcloud-operator/releases/tag/v1.1.0
[1.0.0]: https://github.com/shebang-labs/hcloud-operator/releases/tag/v1.0.0
