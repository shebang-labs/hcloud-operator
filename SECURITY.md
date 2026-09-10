# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through
[GitHub's private vulnerability reporting](https://github.com/shebang-labs/hcloud-operator/security/advisories/new),
or by email to **security@shebanglabs.io**.

Please include:

- what the issue is and what an attacker could do with it,
- the affected version or commit,
- steps to reproduce, if you have them.

We aim to acknowledge a report within three working days and to ship a fix or a
mitigation for a confirmed high-severity issue within fourteen days. We will
credit you in the advisory unless you would rather we did not.

## What this controller can do

Understanding the blast radius is part of running it safely.


**The Hetzner token is the crown jewel.** It is a project-wide Read & Write
credential. Anyone who obtains it can create, modify and delete every server,
volume, network and load balancer in that Hetzner project. The controller:

- reads it only from the `HETZNER_TOKEN` environment variable, which the
  Helm chart sources from a Secret;
- sends it only to the URL in `HETZNER_API_URL`, which is validated to be
  `https` (loopback is the sole exception, for a local proxy);
- never follows HTTP redirects, because a redirect to another host would
  forward the `Authorization` header with it;
- never logs it. The Hetzner client converts every failure into its own
  sanitized error type, because an `axios` error object carries the full
  request — headers included — and would otherwise reach a log line.

**Other credentials the controller handles:**

- Server root passwords. Hetzner generates one when a server is created without
  an SSH key. The client drops it from the response immediately; it is never
  logged and never written to status.
- Certificate private keys. Read once from a Kubernetes Secret, sent to
  Hetzner, and never read back, logged, or written to status.

**Kubernetes permissions.** The controller runs with a ClusterRole. The single
broadest grant is `get` on Secrets cluster-wide, needed only for
`HetznerCertificate` with `type: uploaded`. If you do not use that, set
`rbac.secretsAccess=false` — nothing else reads a Secret. To narrow it further,
set `controller.watchNamespace`, which turns the ClusterRole into a namespaced
Role.

The controller holds **no** `create` or `delete` on its own custom resources:
those objects belong to you. It manages what they describe.

**The admission webhook** (optional, off by default) is served over TLS with a
certificate issued by cert-manager. Its `failurePolicy` is `Fail`, so removing
the controller while the `ValidatingWebhookConfiguration` is still registered
will reject every apply of a Hetzner resource — see
[docs/webhook.md](docs/webhook.md) for the uninstall order.

## Dependency supply chain

Dependabot proposes dependency updates; it does not vet them. It knows that a
newer version exists, not that it is safe — a compromised maintainer account
publishing a malicious release would produce a perfectly ordinary-looking pull
request. The controls that matter are therefore about what happens to that pull
request, not about the bot:

- **Nothing merges itself.** Auto-merge is disabled. Every dependency change is
  reviewed and merged by a person.
- **CI cannot leak secrets to a dependency.** The workflow uses `pull_request`,
  never `pull_request_target`, and its default token is `contents: read`.
  GitHub scopes repository secrets away from Dependabot runs, and the publish
  job is gated on `push`, so it never executes for a pull request at all.
- **Install scripts are disabled.** CI and the Docker build both run
  `npm ci --ignore-scripts`. A package's `preinstall`/`postinstall` hook is the
  usual way a supply-chain attack gets code execution, and it runs before any
  test or lint could notice. Nothing in this dependency tree needs one.
- **Known advisories block a merge.** `npm audit --omit=dev --audit-level=high`
  gates every run, `dependency-review-action` fails a pull request that
  introduces a dependency with a high-severity advisory, and the built image is
  scanned with Trivy for fixable high and critical CVEs.
- **Every GitHub Action is pinned by commit SHA**, including GitHub's own, and a
  test fails if one is not.
- **Release images are signed** with cosign using the workflow's OIDC identity,
  and ship an SBOM and SLSA provenance. See [docs/releasing.md](docs/releasing.md)
  for the verify command.
- **The runtime surface is deliberately tiny.** Two runtime dependencies,
  `@kubernetes/client-node` and `axios`. Majors of either are excluded from
  automation because their behaviour — informer semantics, redirect and error
  handling — is something this controller depends on in detail.

Reviewing a dependency pull request means reading what changed, not just seeing
a green tick. Green CI on a dev-only bump is good evidence; a runtime bump
deserves a look at the release notes.

## Supported versions

Until 1.x is declared stable, only the latest released minor version receives
security fixes.

| Version | Supported |
| ------- | --------- |
| 1.0.x   | yes       |
| < 1.0   | no        |
