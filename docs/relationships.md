# Who owns a relationship

Several Hetzner relationships could be declared from either end. A volume is
attached to a server; you could say so on the volume or on the server. A
firewall protects a server; same question.

Declaring them from both ends would make two controllers fight. The volume
controller reads `HetznerVolume.serverRef`, sees `web-01`, and attaches. The
server controller reads `HetznerServer.volumeRefs`, sees an empty list, and
detaches. Then the volume controller attaches again. Forever, at the resync
rate, on your production database.

So every relationship has exactly one owner, and only the owner may declare it.

| Relationship                      | Declared on                          |
| --------------------------------- | ------------------------------------ |
| volume attached to a server       | `HetznerVolume.spec.serverRef`       |
| firewall protects a server        | `HetznerFirewall.spec.applyToServerRefs` / `applyToLabelSelectors` |
| floating IP points at a server    | `HetznerFloatingIP.spec.serverRef`   |
| primary IP assigned to a server   | `HetznerPrimaryIP.spec.serverRef`    |
| server joins a private network    | `HetznerServer.spec.networks`        |
| server joins a placement group    | `HetznerServer.spec.placementGroupRef` |
| server's SSH keys                 | `HetznerServer.spec.sshKeyRefs` (create only) |
| load balancer targets a server    | `HetznerLoadBalancer.spec.targets`   |
| load balancer serves a certificate| `HetznerLoadBalancer.spec.services[].http.certificateRefs` |
| load balancer joins a network     | `HetznerLoadBalancer.spec.networkRef` |
| snapshot taken from a server      | `HetznerImage.spec.sourceServerRef`  |

That is why `HetznerServer` has no `volumeRefs` and no `firewallRefs`: those
live on the other side, and the CRD schema does not accept them.

## Which end is the owner?

Two rules decided each row:

1. **The dependent side owns it.** A volume is useless without a server; a
   server is perfectly useful without that volume. So the volume points at the
   server.
2. **Where Hetzner's own API puts it wins ties.** A firewall's `applied_to` is a
   property of the firewall, so the firewall owns the relationship even though
   `POST /servers` also accepts a firewall list.

## Referring to things the operator does not manage

Every reference accepts three forms, so nothing has to be adopted before it can
be pointed at:

```yaml
networkRef:
  name: prod            # a HetznerNetwork in this namespace
---
networkRef:
  hetznerName: legacy   # an unmanaged network already in the Hetzner project
---
networkRef:
  id: 4711              # a raw Hetzner id
```

## Ordering

There is none to worry about. A reference to a resource that does not exist yet
sets `DependenciesReady=False` and requeues; it does not count as a failure and
does not consume the retry budget. `kubectl apply -f examples/stack/` works in
one pass whatever order the files are read in.
