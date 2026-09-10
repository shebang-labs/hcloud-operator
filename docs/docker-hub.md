# hcloud-operator

A Kubernetes operator that manages Hetzner Cloud declaratively: servers,
volumes, networks, firewalls, load balancers, floating and primary IPs,
certificates, images, SSH keys and placement groups as custom resources.

Source, documentation and Helm chart:
https://github.com/shebang-labs/hcloud-operator

## Install

```bash
helm repo add shebanglabs https://shebang-labs.github.io/hcloud-operator
helm install hcloud-operator shebanglabs/hcloud-operator \
  --namespace hcloud-operator --create-namespace \
  --set hetzner.token=<your Hetzner Cloud API token>
```

## Tags

| Tag | What it is |
| --- | --- |
| `1.2.3` | A release. Deploy these. |
| `latest` | The newest release. |
| `dev` | The tip of `main`. Not for production. |
| `<commit-sha>` | Every build. Immutable. |

Images are built for `linux/amd64` and `linux/arm64`, run as an unprivileged
user (uid 65532), ship an SBOM and SLSA provenance, and release tags are signed
with cosign:

```bash
cosign verify docker.io/shebanglabs/hcloud-operator:1.0.0 \
  --certificate-identity-regexp 'https://github.com/shebang-labs/hcloud-operator/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Running the image directly

```bash
docker run --rm -e HETZNER_TOKEN=... -e LEADER_ELECTION_ENABLED=false \
  -v ~/.kube/config:/kube/config:ro -e KUBECONFIG=/kube/config \
  shebanglabs/hcloud-operator:1.0.0
```

The only required variable is `HETZNER_TOKEN`; the image refuses to start
without it and says so.
