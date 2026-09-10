# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The public contract covered by that versioning is: the CRD schemas, the Helm
chart values, the environment variables, the status conditions and their
reasons, the metric names, and the Hetzner labels the controller writes.
Internal package layout is not part of it.

## [Unreleased]

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

[Unreleased]: https://github.com/shebang-labs/hcloud-operator/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/shebang-labs/hcloud-operator/releases/tag/v1.0.0
