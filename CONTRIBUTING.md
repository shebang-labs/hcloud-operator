# Contributing

Thanks for considering it. This document is short on purpose: the repository is
meant to be readable, and the tooling is meant to stay out of your way.

## Getting set up

```bash
git clone https://github.com/shebang-labs/hetzner-server-controller
cd hetzner-server-controller
npm install
npm run verify        # lint + typecheck + tests, the same gate CI runs
```

Node 24 (`.nvmrc`) and, for the chart tests, `helm` on your PATH. No Hetzner
account and no Kubernetes cluster are needed: every test runs against
`test/support/fake-hcloud.ts`, an in-memory Hetzner API, and
`test/support/fake-apiserver.ts`, a fake API server the real informer talks to.

To run against a real cluster from your laptop — it uses `~/.kube/config`
exactly like kubectl:

```bash
npm run build
HETZNER_TOKEN=... LEADER_ELECTION_ENABLED=false npm start
```

## Where things live

```
src/framework/       the generic reconcile engine, shared by all eleven kinds
src/resources/       one adapter per Hetzner resource; the only provider-specific logic
src/hcloud/          the Hetzner Cloud API client
src/kube/            Kubernetes plumbing: store, conditions, events, leader election
src/admission/       the optional validating webhook
src/observability/   logging, metrics, health
charts/              the Helm chart; charts/*/crds/ is the API contract
examples/            one working manifest per kind, validated against the CRDs
docs/                architecture, operations, adoption, webhook, releasing
```

`framework/` knows nothing about Hetzner and `hcloud/` knows nothing about
Kubernetes. The adapters in `resources/` are the only place the two meet. Please
keep it that way — it is what makes every layer testable without a cluster.

## Adding support for another Hetzner resource

1. Add the endpoint module under `src/hcloud/resources/`.
2. Add the adapter under `src/resources/` — `create`, `update`, `project`,
   `drift`, `validate`. Nothing else.
3. Register it in `src/resources/index.ts`.
4. Add the CRD in `charts/hetzner-server-controller/crds/` and the plural to
   `hetzner-server-controller.plurals` in `templates/_helpers.tpl`.
5. Add an example in `examples/` and a row to the README table.
6. Add a test file under `test/resources/`.

The manifest tests fail until the CRD, the RBAC, the webhook rules and the
registry agree, so you will be told if you miss a step.

## Tests

Tests verify **behaviour**, not implementation. Assert on what ends up in the
fake Hetzner project and in `.status`, not on which methods were called.

A pull request that changes reconcile behaviour needs a test that fails without
the change. If you are fixing a bug, write the failing test first.

Coverage thresholds in `vitest.config.ts` are a floor, not a target. Please do
not add tests purely to move the number.

## The chart

```bash
npm run chart:lint        # helm lint with the CI values
npm run chart:template    # render with the CI values
npm run chart:docs        # regenerate charts/*/README.md from values.yaml comments
```

Every value needs a `# --` comment in `values.yaml`; that is where the chart
README comes from. Rendering assertions live in `test/manifests/chart.test.ts`.

## Commits and pull requests

- One logical change per pull request.
- Explain *why* in the description, not just what.
- `npm run verify` must pass.
- New behaviour needs documentation: usually a line in the README table, a field
  description in the CRD (which is what `kubectl explain` shows), and an entry
  under `[Unreleased]` in `CHANGELOG.md`.

## Comments

Comments in this repository explain *why*, not *what*. If a comment restates the
code, delete it. If a piece of code is subtle — an ordering constraint, a
Hetzner API quirk, a safety property — say so, and say what breaks if it changes.

## Releasing

Maintainers: see [docs/releasing.md](docs/releasing.md).

## Reporting bugs

Open an issue with the controller's logs (JSON, one object per line) and the
output of `kubectl describe` on the affected resource. Please redact your
Hetzner token if it somehow appears — and if it does, that is itself a bug worth
reporting privately under [SECURITY.md](SECURITY.md).
