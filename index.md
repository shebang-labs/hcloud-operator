# hetzner-server-controller Helm repository

```bash
helm repo add shebanglabs https://shebang-labs.github.io/hetzner-server-controller
helm install hetzner-server-controller shebanglabs/hetzner-server-controller \
  --namespace hetzner-server-controller --create-namespace --set hetzner.token=<token>
```

Documentation: https://github.com/shebang-labs/hetzner-server-controller
