# hcloud-operator Helm repository

```bash
helm repo add shebanglabs https://shebang-labs.github.io/hcloud-operator
helm install hcloud-operator shebanglabs/hcloud-operator \
  --namespace hcloud-operator --create-namespace --set hetzner.token=<token>
```

Documentation: https://github.com/shebang-labs/hcloud-operator
