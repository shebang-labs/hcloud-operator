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

The controller then removes its five `hcloud.shebanglabs.io/*` ownership labels
(your own `spec.labels` stay) and its finalizer, and leaves the resource running.
A resource stamped by a different object is left untouched.

Orphaning therefore needs a working Hetzner API, just like deletion. If the
labels cannot be removed, the finalizer stays and the controller retries, so a
resource is never half released. Transient errors are retried with backoff;
persistent ones (for example a revoked token answering 401, 403 or 422) are only
retried on the resync, every five minutes, and until they clear the object, and
any namespace or uninstall waiting on it, stays in `Terminating`. Fix the
credentials and it completes by itself. To release the object without removing
the labels, delete the finalizer by hand:

```bash
kubectl patch hsrv web-01 --type=merge -p '{"metadata":{"finalizers":null}}'
```

(`null` drops all finalizers; the controller's own is
`hcloud.shebanglabs.io/finalizer`.) The resource keeps its stale stamp, which a
later `adoptExisting` can still take over as described below. This is the right default while you are
migrating; switch to `Delete` (the default) once you trust the manifests.

Because the labels are gone, a released resource can be adopted by a new object
with `adoptExisting`. That is how you move a resource to a new object without
rebuilding it: orphan the old object, then create the new one.

### Adopting a resource whose owner no longer exists

Resources orphaned by an older controller version still carry labels that point
at a deleted object. The controller normally refuses to adopt a resource that
another object owns (`409 already_owned`), but it takes over a stamp whose owner
is proven gone. That needs all of the following:

- the stamp has a uid and a namespace, and its kind label matches the kind being
  adopted into (the name label is not used, because it can be cut short);
- the controller can read that namespace (`WATCH_NAMESPACE` is unset or equal to
  it);
- no object with the stamped uid exists there any more. The controller lists the
  namespace and looks for the uid, so a deleted owner and a recreated one (same
  name, new uid) are both stale.

Whenever that cannot be proven (for example a lookup error or a namespace the
controller does not watch) the adoption is refused as before. A takeover emits a
`TookOverStaleOwnership` event naming the old uid.

**Known limit:** a controller in another cluster that shares the same Hetzner
project cannot be seen. Adopting a resource it owns, when no object with the
stamped uid exists in that namespace here, takes it over. `adoptExisting` names
the resource explicitly, so this is treated as intent.

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
