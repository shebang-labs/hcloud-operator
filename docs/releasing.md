# Releasing (maintainers)

A release is a version tag. Everything else is automation.

## Cut a release

```bash
# 1. One commit: version in package.json and the chart, changelog section.
npm version 1.1.0 --no-git-tag-version
sed -i 's/^version: .*/version: 1.1.0/; s/^appVersion: .*/appVersion: "1.1.0"/' charts/hcloud-operator/Chart.yaml
sed -i 's|hcloud-operator:[0-9.]*$|hcloud-operator:1.1.0|' charts/hcloud-operator/Chart.yaml
$EDITOR CHANGELOG.md        # move [Unreleased] into ## [1.1.0] — YYYY-MM-DD
npm run verify              # a test fails if any of the above disagree
git commit -am "release: 1.1.0"

# 2. Tag. The tag is what triggers the release workflow.
git tag -a v1.1.0 -m "1.1.0"
git push origin main v1.1.0
```

The `Release` workflow then:

1. Refuses to continue unless the tag, `package.json`, `Chart.yaml` `version`
   and `appVersion`, and a `CHANGELOG.md` section all agree.
2. Builds and pushes `docker.io/shebanglabs/hcloud-operator:1.1.0`,
   `:latest` (not for pre-releases such as `1.1.0-rc.1`) and `:<sha>` for
   `linux/amd64` and `linux/arm64`, with SLSA provenance and an SBOM, and signs
   the digest with cosign (keyless, using the workflow's OIDC identity).
3. Packages the chart, creates the GitHub Release `v1.1.0` with the changelog
   section as notes and the chart archive attached, updates `index.yaml` on the
   `gh-pages` branch (the Helm repository), and pushes the chart to
   `oci://ghcr.io/shebang-labs/charts/hcloud-operator` (GHCR rather
   than Docker Hub because an OCI chart is stored under its chart name, which
   would collide with the image's tags; the package must be made public once
   in the GitHub UI).
4. Syncs `docs/docker-hub.md` to the Docker Hub repository description.

Verify:

```bash
cosign verify docker.io/shebanglabs/hcloud-operator:1.1.0 \
  --certificate-identity-regexp 'https://github.com/shebang-labs/hcloud-operator/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
helm pull oci://ghcr.io/shebang-labs/charts/hcloud-operator --version 1.1.0
```

## Repository configuration

| Setting | Value |
| --- | --- |
| Secret `DOCKERHUB_USERNAME` | Docker Hub account with write access to the `shebanglabs` organisation. |
| Secret `DOCKERHUB_TOKEN` | A Docker Hub **access token** with Read & Write, not the password. |
| Pages | Source: branch `gh-pages`, folder `/`. Serves `index.yaml`. |
| Branch protection on `main` | Require the `CI` checks; no force pushes. |

A push to `main` publishes `:dev` and `:<sha>` if the secrets exist and warns
otherwise, so a fork or a fresh repository is never red for a missing registry.
A version tag without the secrets is a hard failure: somebody meant to release.
Add the secrets and re-run it for the same tag:

```bash
gh workflow run release.yaml --ref v1.1.0
```

## Artifact Hub

Register `https://shebang-labs.github.io/hcloud-operator` once as a
Helm charts repository at https://artifacthub.io/control-panel/repositories,
then copy the repository ID into `.github/artifacthub-repo.yml` (it is
published to `gh-pages` on every release) to become a verified publisher. The
`artifacthub.io/*` annotations in `Chart.yaml` — CRDs, examples, images, links,
changes — are what Artifact Hub renders.

## What the version covers

Semantic versioning applies to: the CRD schemas, the chart values, the
environment variables, the status conditions and their reasons, the metric
names, and the Hetzner labels the controller writes. Internal package layout is
not part of the contract.
