# The validating admission webhook

Optional. With it enabled, `kubectl apply` rejects a bad spec immediately:

```
$ kubectl apply -f server.yaml
Error from server: error when creating "server.yaml": admission webhook
"validate.hcloud.shebanglabs.io" denied the request: HetznerServer spec is
invalid: spec.serverType "cpx99" does not exist in this Hetzner project.
Valid values: cax11, cax21, ccx13, cpx11, cpx21, cpx31, cx22, cx32, ...
```

Without it, the same typo is reported on the object's `Synced` condition a few
seconds later. Nothing breaks; you just have to go and look.

## What it checks

- The adapter's own `validate()` — the exact same function the reconcile engine
  runs, so the two can never disagree.
- Values that only Hetzner knows: `serverType`, `location`, `datacenter`,
  `image` and `iso` are checked against the live catalog. On an update, only
  fields that actually changed are checked, so a server whose type Hetzner has
  since retired can still be edited.

If Hetzner is unreachable the webhook **allows** the request with a warning.
Blocking every apply in the cluster on a third party's availability would be far
worse than letting a typo through to a condition.

## Enable

Requires [cert-manager](https://cert-manager.io). The chart creates a
self-signed `Issuer`, a `Certificate`, a `Service` and the
`ValidatingWebhookConfiguration`, and mounts the certificate into the Pods.

```bash
helm upgrade hetzner-server-controller shebanglabs/hetzner-server-controller \
  -n hetzner-server-controller --reuse-values \
  --set webhook.enabled=true
```

To use your own issuer:

```bash
  --set webhook.certManager.createIssuer=false \
  --set webhook.certManager.issuerRef.name=internal-ca \
  --set webhook.certManager.issuerRef.kind=ClusterIssuer
```

## Disable, and uninstall order

```bash
helm upgrade hetzner-server-controller shebanglabs/hetzner-server-controller \
  -n hetzner-server-controller --reuse-values \
  --set webhook.enabled=false
```

Do this **before** `helm uninstall` if the webhook is on. Its `failurePolicy` is
`Fail` — the safe choice, because an unchecked spec would create real, billable
infrastructure — so if the controller goes away while the configuration is
still registered, every apply of a Hetzner resource is rejected until it is
removed. `helm uninstall` removes both together, but a partial failure would
leave the configuration behind; disabling first avoids the question.

Set `webhook.failurePolicy=Ignore` if you would rather accept unchecked specs
than be blocked while the controller is down.
