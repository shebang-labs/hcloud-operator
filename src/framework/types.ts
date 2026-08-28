/**
 * The contract between the generic reconcile engine and the eleven
 * kind-specific adapters.
 *
 * The split is the whole design: everything that is the *same* for a Hetzner
 * server and a Hetzner certificate — finalizer ordering, adoption by owner
 * label, status and condition writing, backoff, deletion policy — lives in the
 * engine and is written and tested once. An adapter contributes only the five
 * things that genuinely differ per resource:
 *
 *   create   — bring it into existence
 *   update   — converge the mutable fields
 *   project  — pure: turn the remote object into Kubernetes status
 *   drift    — pure: report changes that cannot be applied in place
 *   validate — pure: reject impossible specs before any API call
 *
 * `project` and `drift` being pure is deliberate: they carry most of the
 * per-resource logic and are exhaustively testable as plain functions.
 */

import type { Labelled } from '../hcloud/types.js';
import type {
    CommonSpec,
    CommonStatus,
    ManagedResource,
    Phase,
    ResourceDescriptor,
} from '../kube/api.js';
import type { Logger } from '../observability/logger.js';
import type { ReferenceResolver } from './references.js';

/** What the engine passes to an adapter for one reconcile pass. */
export interface ReconcileContext<TSpec extends CommonSpec, TStatus extends CommonStatus> {
    readonly resource: ManagedResource<TSpec, TStatus>;
    readonly spec: TSpec;
    readonly namespace: string;
    readonly name: string;
    /** "<namespace>/<name>", the work queue key. */
    readonly key: string;
    readonly logger: Logger;
    /** Ownership labels merged with `spec.labels`, ready to send to Hetzner. */
    readonly labels: Record<string, string>;
    /** Name to give the resource inside the Hetzner project. */
    readonly hetznerName: string;
    /** Resolves references to other kinds into Hetzner ids. */
    readonly refs: ReferenceResolver;
}

/** The pure mapping from a Hetzner object to Kubernetes status. */
export interface Projection<TStatus extends CommonStatus> {
    /** Whether the resource is usable right now. Drives the Ready condition. */
    ready: boolean;
    phase: Phase;
    message: string;
    /** Kind-specific status fields. The engine fills in the common ones. */
    status: Partial<TStatus>;
    /**
     * Ask to be looked at again after this delay — used while Hetzner is still
     * working (a volume in `creating`, a managed certificate being issued).
     */
    requeueAfterMs?: number;
}

/** What an adapter's `update` reports back to the engine. */
export interface UpdateOutcome {
    /** Whether anything was actually changed remotely. */
    changed: boolean;
    /** One line per change, for the log and the status message. */
    changes?: string[];
    /**
     * A change the user asked for that the operator refuses to make without an
     * explicit opt-in (resizing a server, rebuilding it). Reported on `Synced`
     * as a false condition; not an error, and not retried in a hot loop.
     */
    blocked?: string;
    requeueAfterMs?: number;
    /**
     * Bookkeeping the adapter needs to remember between passes — "I asked for a
     * shutdown at 12:01", "I powered this off in order to resize it". Merged
     * into the status write on top of the projection, because it describes what
     * the operator is doing rather than what the resource looks like.
     */
    statusPatch?: Record<string, unknown>;
}

export const noChange: UpdateOutcome = { changed: false };

/** The generic remote operations the engine performs on any kind's behalf. */
export interface OwnedRemoteApi<TRemote extends Labelled> {
    get(id: number): Promise<TRemote | null>;
    listByLabel(selector: string): Promise<TRemote[]>;
    getByName(name: string): Promise<TRemote | null>;
    update(
        id: number,
        changes: { name?: string; labels?: Record<string, string> },
    ): Promise<TRemote>;
    /** Returns false when the resource was already gone. */
    delete(id: number): Promise<boolean>;
}

export interface ResourceAdapter<
    TSpec extends CommonSpec,
    TStatus extends CommonStatus,
    TRemote extends Labelled,
> {
    readonly descriptor: ResourceDescriptor;
    /** The Hetzner endpoint module, narrowed to what the engine needs. */
    readonly api: OwnedRemoteApi<TRemote>;

    /**
     * Pure spec validation. Returned messages become a permanent `Synced=False`
     * rather than a retry loop, because no amount of retrying fixes a typo.
     */
    validate?(spec: TSpec): string[];

    create(context: ReconcileContext<TSpec, TStatus>): Promise<TRemote>;

    update(context: ReconcileContext<TSpec, TStatus>, remote: TRemote): Promise<UpdateOutcome>;

    /**
     * Optional override for deletion. Most kinds want the default (call
     * `api.delete`); a few need to detach or unprotect first.
     */
    delete?(context: ReconcileContext<TSpec, TStatus>, remote: TRemote): Promise<void>;

    /**
     * Pure. Turns the remote object into Kubernetes status.
     *
     * It receives the spec as well as the remote object because "is this what
     * was asked for?" is not answerable from the remote object alone — a server
     * that is powered off is a problem or the desired state depending entirely
     * on `spec.powerState`, and only the spec knows which.
     */
    project(remote: TRemote, spec: TSpec): Projection<TStatus>;

    /** Pure. Immutable-field changes that can only be applied by recreating. */
    drift?(context: ReconcileContext<TSpec, TStatus>, remote: TRemote): string | undefined;

    /**
     * Whether the operator may rename the Hetzner resource when the Kubernetes
     * object's derived name changes. Off by default: a rename is visible in
     * Hetzner's UI and in nothing else.
     */
    readonly syncName?: boolean;
}

/** What the work queue is told to do after a reconcile. */
export interface ReconcileResult {
    /** Reconcile again after this delay. Omitted = only on events and resync. */
    requeueAfterMs?: number;
}
