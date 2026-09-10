# Adopting existing Hetzner resources

You do not have to start from an empty project. Any Hetzner resource can be
brought under management without recreating it.

## Adopt by name

```yaml
apiVersion: hcloud.shebanglabs.io/v1alpha1
kind: HetznerServer
metadata:
  name: web-01
spec:
  adoptExisting: web-old-01     # the server's current name in Hetzner
  deletionPolicy: Orphan        # see below
  serverType: cpx21
  image: ubuntu-24.04
  location: nbg1
```

On the first reconcile the controller looks up `web-old-01`, stamps its
ownership labels on it, records the id in `status.id`, and from then on treats
it exactly like a server it created. `adoptExisting` is only consulted when no
resource with this object's uid exists yet, so it is safe to leave in place.

Two things happen on adoption that are worth knowing:

- **The Hetzner name is changed** to `<namespace>-<name>` for kinds where the
  controller manages names (servers, volumes, networks, and others that support
  renaming). Set `metadata.name` to what you want the server to be called.
- **Labels are converged.** The controller owns the resource's Hetzner labels
  after adoption; labels set in the console that are not in `spec.labels` are
  removed on the next resync. Copy the ones you want into the spec first.

## Adopt by id

If the name is ambiguous or about to change, reference the id instead — the
same three-form reference used everywhere else:

```yaml
spec:
  adoptExisting: "4711"
```

## Protect production data with `deletionPolicy: Orphan`

By default, deleting a `Hetzner*` object deletes the Hetzner resource. For
anything you would not want to lose to a mistaken `kubectl delete`, set:

```yaml
spec:
  deletionPolicy: Orphan
```

The controller then removes its labels and finalizer and leaves the resource
running. This is the right default while you are migrating; switch to `Delete`
(the default) once you trust the manifests.

`spec.protection.delete: true` is the belt to that suspenders: it turns on
Hetzner's own delete protection, so even the controller cannot remove the
resource until you set it back to `false`.

## Referencing things you never adopt

Not everything needs to be managed. A reference can point at an unmanaged
resource by its Hetzner name or id:

```yaml
networkRef: { hetznerName: legacy-network }
sshKeyRefs:
  - { hetznerName: laptop }
```

The controller will use it but never modify or delete it.

## Checking what happened

```bash
kubectl get hsrv web-01 -w
kubectl describe hsrv web-01     # look for the Adopted event
```
