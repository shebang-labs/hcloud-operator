/**
 * The reconcile engine: given the key of one custom resource of any kind, make
 * the Hetzner project match it.
 *
 * Written as "look at reality, then act", never as "react to the event that
 * woke me up". That is what makes it idempotent: running it once or five times
 * in a row leads to the same single Hetzner resource.
 *
 * Flow for one object:
 *
 *   1. Read the object from the API server (not from a cache). Gone? Done.
 *   2. Being deleted (deletionTimestamp set)? -> honour the deletion policy,
 *      delete the Hetzner resource, wait until it is really gone, then remove
 *      the finalizer.
 *   3. No finalizer yet? -> add it *before* creating anything, so a crash can
 *      never orphan a paid resource.
 *   4. Validate the spec. Invalid specs are a permanent condition, not a retry.
 *   5. Find the matching Hetzner resource: by recorded id, then by owner label,
 *      then by explicit adoption.
 *   6. Not found -> create it, and record the id in status immediately.
 *   7. Found -> sync ownership labels, let the adapter converge the rest,
 *      project reality into status.
 *
 * Every step above is identical for all eleven kinds, which is exactly why it
 * lives here instead of being written out eleven times.
 */

import { HetznerApiError } from '../hcloud/errors.js';
import type { Labelled } from '../hcloud/types.js';
import {
    CONDITION_DEPENDENCIES_READY,
    CONDITION_READY,
    CONDITION_SYNCED,
    type CommonSpec,
    type CommonStatus,
    type ConditionInput,
    ConditionReason,
    type EventRecorder,
    FINALIZER,
    type ManagedResource,
    nullEventRecorder,
    type Phase,
    type ResourceStore,
    setConditions,
    toReason,
} from '../kube/index.js';
import type { Logger } from '../observability/logger.js';
import {
    buildLabels,
    hetznerResourceName,
    isOwnedByAnother,
    labelsMatch,
    ownerSelector,
} from './ownership.js';
import { isDependencyError, type ReferenceResolver } from './references.js';
import type { ReconcileContext, ReconcileResult, ResourceAdapter, UpdateOutcome } from './types.js';

/**
 * The shape the engine writes into `.status`.
 *
 * The common fields are typed; the kind-specific ones arrive already typed from
 * `adapter.project()` and are carried through as an open record. Keeping the
 * patch loosely typed *here* — and only here — is what lets one engine serve
 * eleven different status schemas without eleven copies of this class.
 */
type StatusPatch = Omit<Partial<CommonStatus>, 'conditions'> &
    Record<string, unknown> & {
        /** Condition *inputs*; the engine adds lastTransitionTime for each. */
        conditions?: ConditionInput[];
    };

/** How long to wait while Hetzner is still working on the resource. */
export const REQUEUE_WHILE_TRANSITIONING_MS = 10_000;
/** How long to wait for a delete to complete before checking again. */
export const REQUEUE_WHILE_DELETING_MS = 5_000;
/** How long to wait for a referenced resource to become ready. */
export const REQUEUE_WHILE_WAITING_FOR_DEPENDENCY_MS = 15_000;

export interface ReconcileEngineDependencies<
    TSpec extends CommonSpec,
    TStatus extends CommonStatus,
    TRemote extends Labelled,
> {
    adapter: ResourceAdapter<TSpec, TStatus, TRemote>;
    store: ResourceStore<ManagedResource<TSpec, TStatus>>;
    refs: ReferenceResolver;
    logger: Logger;
    /** Records Kubernetes Events. Optional; defaults to discarding them. */
    events?: EventRecorder;
    /** Injectable clock, so tests get stable timestamps. */
    now?: () => Date;
}

export class ReconcileEngine<
    TSpec extends CommonSpec,
    TStatus extends CommonStatus,
    TRemote extends Labelled,
> {
    private readonly adapter: ResourceAdapter<TSpec, TStatus, TRemote>;
    private readonly store: ResourceStore<ManagedResource<TSpec, TStatus>>;
    private readonly refs: ReferenceResolver;
    private readonly logger: Logger;
    private readonly events: EventRecorder;
    private readonly now: () => Date;

    constructor(dependencies: ReconcileEngineDependencies<TSpec, TStatus, TRemote>) {
        this.adapter = dependencies.adapter;
        this.store = dependencies.store;
        this.refs = dependencies.refs;
        this.logger = dependencies.logger;
        this.events = dependencies.events ?? nullEventRecorder;
        this.now = dependencies.now ?? (() => new Date());
    }

    get kind(): string {
        return this.adapter.descriptor.kind;
    }

    /**
     * Reconciles one object, addressed by its "<namespace>/<name>" key.
     * Throws on unexpected failures; the caller retries with backoff.
     */
    async reconcile(namespace: string, name: string): Promise<ReconcileResult> {
        const key = `${namespace}/${name}`;
        const logger = this.logger.child({ resource: key });

        const resource = await this.store.get(namespace, name);
        if (!resource) {
            logger.debug('Resource no longer exists, nothing to reconcile');
            return {};
        }

        const context = this.buildContext(resource, logger);

        if (resource.metadata?.deletionTimestamp) {
            return this.reconcileDeletion(context);
        }

        // The finalizer must exist before the first Hetzner call. Otherwise a
        // crash between "resource created" and "finalizer added" leaves a
        // running resource behind that nobody cleans up.
        if (!(resource.metadata?.finalizers ?? []).includes(FINALIZER)) {
            logger.info('Adding finalizer');
            await this.store.addFinalizer(resource);
            // Re-read on the next pass so we work with fresh metadata.
            return { requeueAfterMs: 0 };
        }

        const problems = this.adapter.validate?.(context.spec) ?? [];
        if (problems.length > 0) {
            return this.reportInvalidSpec(context, problems);
        }

        try {
            return await this.reconcileExisting(context);
        } catch (error) {
            if (isDependencyError(error)) {
                return this.reportWaitingForDependency(context, error);
            }
            throw error;
        }
    }

    /** Builds the per-pass context handed to the adapter. */
    private buildContext(
        resource: ManagedResource<TSpec, TStatus>,
        logger: Logger,
    ): ReconcileContext<TSpec, TStatus> {
        const namespace = resource.metadata?.namespace ?? 'default';
        const name = resource.metadata?.name ?? '';
        return {
            resource,
            spec: resource.spec,
            namespace,
            name,
            key: `${namespace}/${name}`,
            logger,
            labels: buildLabels(resource, this.adapter.descriptor.kind),
            hetznerName: hetznerResourceName(namespace, name),
            refs: this.refs,
        };
    }

    private async reconcileExisting(
        context: ReconcileContext<TSpec, TStatus>,
    ): Promise<ReconcileResult> {
        const existing = await this.findRemote(context);
        if (!existing) {
            return this.createRemote(context);
        }
        return this.observeRemote(context, existing);
    }

    /**
     * Finds the Hetzner resource belonging to this object.
     *
     * Three lookups, in order:
     *   1. status.id             — the fast, exact path.
     *   2. the uid owner label   — the recovery path, used when status was never
     *      written (the operator crashed right after create).
     *   3. spec.adoptExisting    — the migration path, for a resource that
     *      already existed before the operator did.
     */
    private async findRemote(context: ReconcileContext<TSpec, TStatus>): Promise<TRemote | null> {
        const { resource, logger } = context;

        const recordedId = resource.status?.id;
        if (recordedId) {
            const remote = await this.adapter.api.get(recordedId);
            if (remote) {
                return remote;
            }
            logger.warn('Recorded Hetzner resource does not exist any more', { id: recordedId });
        }

        const uid = resource.metadata?.uid;
        if (!uid) {
            throw new Error(
                'Resource has no metadata.uid, so its Hetzner resource cannot be identified',
            );
        }

        const byLabel = await this.adapter.api.listByLabel(ownerSelector(uid));
        if (byLabel.length > 1) {
            // Should never happen: the uid is unique. Log loudly rather than
            // pick one at random and silently leak the others.
            logger.error('Several Hetzner resources carry the same owner uid', {
                uid,
                ids: byLabel.map((entry) => entry.id),
            });
        }
        const owned = byLabel[0];
        if (owned) {
            logger.debug('Found the Hetzner resource by owner label', { id: owned.id });
            return owned;
        }

        return this.adoptRemote(context);
    }

    /** Handles `spec.adoptExisting`, taking over an unmanaged Hetzner resource. */
    private async adoptRemote(context: ReconcileContext<TSpec, TStatus>): Promise<TRemote | null> {
        const target = context.spec.adoptExisting?.trim();
        if (!target) {
            return null;
        }

        const uid = context.resource.metadata?.uid ?? '';
        const numeric = Number(target);
        const candidate = Number.isInteger(numeric)
            ? await this.adapter.api.get(numeric)
            : await this.adapter.api.getByName(target);

        if (!candidate) {
            throw new HetznerApiError({
                status: 404,
                code: 'not_found',
                message: `spec.adoptExisting refers to "${target}", which does not exist in this Hetzner project`,
                // Permanent until the user fixes the spec or creates the resource.
                retryable: false,
            });
        }

        if (isOwnedByAnother(candidate, uid)) {
            throw new HetznerApiError({
                status: 409,
                code: 'already_owned',
                message:
                    `Refusing to adopt Hetzner resource ${candidate.id}: it is already managed by ` +
                    `another ${this.adapter.descriptor.kind}. Adopting it would give two objects the ` +
                    'same resource, and deleting either would take it from the other.',
                retryable: false,
            });
        }

        context.logger.info('Adopting an existing Hetzner resource', {
            id: candidate.id,
            adoptExisting: target,
        });
        this.events.normal(
            context.resource,
            'Adopted',
            `Adopted the existing Hetzner resource "${target}" (${candidate.id}) instead of creating one`,
        );
        // Stamp ownership straight away, so a crash before the next status write
        // still leaves the resource findable by label.
        return (await this.adapter.api.update(candidate.id, {
            labels: context.labels,
        })) as TRemote;
    }

    private async createRemote(
        context: ReconcileContext<TSpec, TStatus>,
    ): Promise<ReconcileResult> {
        const { logger } = context;

        await this.writeStatus(context, {
            phase: 'Creating',
            message: `Creating Hetzner ${this.adapter.descriptor.kind}`,
            conditions: [
                {
                    type: CONDITION_READY,
                    status: 'False',
                    reason: ConditionReason.Creating,
                    message: 'The Hetzner resource is being created',
                },
                {
                    type: CONDITION_SYNCED,
                    status: 'False',
                    reason: ConditionReason.Creating,
                    message: 'The Hetzner resource is being created',
                },
            ],
        });

        logger.info('Creating Hetzner resource', { hetznerName: context.hetznerName });

        let created: TRemote;
        try {
            created = await this.adapter.create(context);
        } catch (error) {
            // A name clash can happen if a previous attempt created the resource
            // but we never saw the response. Check the ownership label before
            // giving up: adopting our own orphan is always right.
            if (error instanceof HetznerApiError && error.isUniquenessConflict) {
                const recovered = await this.recoverAfterUniquenessConflict(context);
                if (!recovered) {
                    throw error;
                }
                created = recovered;
            } else {
                throw error;
            }
        }

        logger.info('Hetzner resource created', { id: created.id, hetznerName: created.name });
        this.events.normal(
            context.resource,
            'Created',
            `Created Hetzner ${this.adapter.descriptor.kind} ${created.id} (${created.name ?? 'unnamed'})`,
        );

        // Record the id straight away: it is the link that prevents duplicates.
        const projection = this.adapter.project(created, context.spec);
        await this.writeStatus(context, {
            phase: projection.ready ? 'Ready' : 'Creating',
            id: created.id,
            hetznerName: created.name ?? undefined,
            message: projection.message,
            ...projection.status,
            conditions: [
                {
                    type: CONDITION_READY,
                    status: projection.ready ? 'True' : 'False',
                    reason: projection.ready ? ConditionReason.Ready : ConditionReason.Creating,
                    message: projection.message,
                },
                {
                    type: CONDITION_SYNCED,
                    status: 'True',
                    reason: ConditionReason.Created,
                    message: 'The Hetzner resource matches the desired spec',
                },
            ],
        });

        // Always come back once: a freshly created resource usually still has
        // attachments to settle, and the next pass is what applies them.
        return { requeueAfterMs: projection.requeueAfterMs ?? REQUEUE_WHILE_TRANSITIONING_MS };
    }

    private async recoverAfterUniquenessConflict(
        context: ReconcileContext<TSpec, TStatus>,
    ): Promise<TRemote | null> {
        const uid = context.resource.metadata?.uid;
        if (!uid) {
            return null;
        }
        const owned = (await this.adapter.api.listByLabel(ownerSelector(uid)))[0];
        if (!owned) {
            return null;
        }
        context.logger.warn(
            'The Hetzner name was already taken by one of our own earlier attempts; adopting it',
            { id: owned.id },
        );
        return owned;
    }

    /**
     * The resource exists: keep ownership labels current, let the adapter
     * converge everything else, then copy reality into status.
     */
    private async observeRemote(
        context: ReconcileContext<TSpec, TStatus>,
        remote: TRemote,
    ): Promise<ReconcileResult> {
        const { logger } = context;
        let current = remote;

        current = await this.syncCommonFields(context, current);

        const outcome: UpdateOutcome = await this.adapter.update(context, current);
        if (outcome.changed) {
            logger.info('Converged the Hetzner resource', { changes: outcome.changes ?? [] });
            this.events.normal(
                context.resource,
                'Updated',
                (outcome.changes ?? ['applied a change']).join('; '),
            );
            // Re-read so status reflects what the changes actually produced
            // rather than what they were expected to produce.
            current = (await this.adapter.api.get(current.id)) ?? current;
        }

        const drift = this.adapter.drift?.(context, current);
        if (drift) {
            logger.warn('Spec changed in a field that cannot be applied in place', { drift });
            this.events.warning(context.resource, ConditionReason.ImmutableFieldChanged, drift);
        }
        if (outcome.blocked) {
            // A change the user asked for that needs an explicit opt-in. Worth
            // an event: the condition alone is easy to miss on a resource
            // somebody edited and walked away from.
            this.events.warning(context.resource, ConditionReason.GuardRequired, outcome.blocked);
        }

        const projection = this.adapter.project(current, context.spec);
        const syncedProblem = drift ?? outcome.blocked;

        const conditions: ConditionInput[] = [
            {
                type: CONDITION_READY,
                status: projection.ready ? 'True' : 'False',
                reason: projection.ready ? ConditionReason.Ready : ConditionReason.NotReady,
                message: projection.message,
            },
            {
                type: CONDITION_DEPENDENCIES_READY,
                status: 'True',
                reason: ConditionReason.InSync,
                message: 'Every referenced resource is ready',
            },
            syncedProblem
                ? {
                      type: CONDITION_SYNCED,
                      status: 'False',
                      reason: drift
                          ? ConditionReason.ImmutableFieldChanged
                          : ConditionReason.GuardRequired,
                      message: syncedProblem,
                  }
                : {
                      type: CONDITION_SYNCED,
                      status: 'True',
                      reason: ConditionReason.InSync,
                      message: 'The Hetzner resource matches the desired spec',
                  },
        ];

        await this.writeStatus(context, {
            phase: this.phaseFor(projection.phase, syncedProblem),
            id: current.id,
            hetznerName: current.name ?? undefined,
            message: syncedProblem ?? projection.message,
            ...projection.status,
            // The adapter's own bookkeeping goes last: it describes what the
            // operator is doing, which the projection cannot know.
            ...(outcome.statusPatch ?? {}),
            conditions,
        });

        const requeueAfterMs = outcome.requeueAfterMs ?? projection.requeueAfterMs;
        return requeueAfterMs !== undefined ? { requeueAfterMs } : {};
    }

    /**
     * Ownership labels and, when the adapter opts in, the name. Done generically
     * because every kind stores labels the same way and every kind must stay
     * findable by its uid label.
     */
    private async syncCommonFields(
        context: ReconcileContext<TSpec, TStatus>,
        remote: TRemote,
    ): Promise<TRemote> {
        const desiredName =
            this.adapter.syncName && remote.name !== context.hetznerName
                ? context.hetznerName
                : undefined;
        const labelsDiffer = !labelsMatch(remote.labels, context.labels);

        if (!labelsDiffer && desiredName === undefined) {
            return remote;
        }

        context.logger.info('Updating Hetzner resource metadata', {
            id: remote.id,
            ...(labelsDiffer ? { labels: true } : {}),
            ...(desiredName ? { renameTo: desiredName } : {}),
        });

        return (await this.adapter.api.update(remote.id, {
            ...(labelsDiffer ? { labels: context.labels } : {}),
            ...(desiredName ? { name: desiredName } : {}),
        })) as TRemote;
    }

    /**
     * Deletion. The finalizer is only removed once the Hetzner resource is
     * confirmed gone, so a `kubectl delete` can never orphan paid infrastructure
     * — unless the user asked for exactly that with `deletionPolicy: Orphan`.
     */
    private async reconcileDeletion(
        context: ReconcileContext<TSpec, TStatus>,
    ): Promise<ReconcileResult> {
        const { resource, logger } = context;

        if (!(resource.metadata?.finalizers ?? []).includes(FINALIZER)) {
            logger.debug('Object is being deleted and carries no finalizer of ours');
            return {};
        }

        if (context.spec.deletionPolicy === 'Orphan') {
            logger.info('deletionPolicy is Orphan: leaving the Hetzner resource in place', {
                id: resource.status?.id,
            });
            this.events.warning(
                resource,
                ConditionReason.Orphaned,
                `deletionPolicy is Orphan: Hetzner ${this.adapter.descriptor.kind} ` +
                    `${resource.status?.id ?? 'resource'} was left running and is no longer managed`,
            );
            await this.store.removeFinalizer(resource);
            return {};
        }

        const remote = await this.findRemoteForDeletion(context);

        if (!remote) {
            logger.info('No Hetzner resource left, removing finalizer');
            await this.store.removeFinalizer(resource);
            logger.info('Finalizer removed, Kubernetes can now delete the object');
            return {};
        }

        await this.writeStatus(context, {
            phase: 'Deleting',
            id: remote.id,
            message: `Deleting Hetzner resource ${remote.id}`,
            conditions: [
                {
                    type: CONDITION_READY,
                    status: 'False',
                    reason: ConditionReason.Deleting,
                    message: 'The Hetzner resource is being deleted',
                },
            ],
        });

        logger.info('Deleting Hetzner resource', { id: remote.id });
        this.events.normal(
            context.resource,
            'Deleting',
            `Deleting Hetzner ${this.adapter.descriptor.kind} ${remote.id}`,
        );
        if (this.adapter.delete) {
            await this.adapter.delete(context, remote);
        } else {
            await this.adapter.api.delete(remote.id);
        }

        // Check again before releasing the object: only a confirmed absence is
        // good enough to remove the finalizer.
        return { requeueAfterMs: REQUEUE_WHILE_DELETING_MS };
    }

    /**
     * Like `findRemote`, but never adopts: taking over a resource on the way to
     * deleting the object would delete something the user never handed us.
     */
    private async findRemoteForDeletion(
        context: ReconcileContext<TSpec, TStatus>,
    ): Promise<TRemote | null> {
        const recordedId = context.resource.status?.id;
        if (recordedId) {
            const remote = await this.adapter.api.get(recordedId);
            if (remote) {
                return remote;
            }
        }
        const uid = context.resource.metadata?.uid;
        if (!uid) {
            return null;
        }
        return (await this.adapter.api.listByLabel(ownerSelector(uid)))[0] ?? null;
    }

    /** A spec the API can never accept: report it and stop, do not retry. */
    private async reportInvalidSpec(
        context: ReconcileContext<TSpec, TStatus>,
        problems: string[],
    ): Promise<ReconcileResult> {
        const message = `The spec is invalid: ${problems.join('; ')}`;
        context.logger.error('Refusing to reconcile an invalid spec', { problems });
        this.events.warning(context.resource, 'InvalidSpec', message);

        await this.writeStatus(context, {
            phase: 'Error',
            message,
            conditions: [
                {
                    type: CONDITION_SYNCED,
                    status: 'False',
                    reason: 'InvalidSpec',
                    message,
                },
            ],
        });
        // No requeue: only a spec change can fix this, and that produces an event.
        return {};
    }

    /** A referenced resource is missing or not ready: wait, do not fail. */
    private async reportWaitingForDependency(
        context: ReconcileContext<TSpec, TStatus>,
        error: Error,
    ): Promise<ReconcileResult> {
        context.logger.info('Waiting for a referenced resource', { reason: error.message });

        await this.writeStatus(context, {
            phase: 'Pending',
            message: error.message,
            conditions: [
                {
                    type: CONDITION_DEPENDENCIES_READY,
                    status: 'False',
                    reason:
                        error.name === 'DependencyMissingError'
                            ? ConditionReason.DependencyMissing
                            : ConditionReason.WaitingForDependency,
                    message: error.message,
                },
                {
                    type: CONDITION_READY,
                    status: 'False',
                    reason: ConditionReason.WaitingForDependency,
                    message: error.message,
                },
            ],
        });

        return { requeueAfterMs: REQUEUE_WHILE_WAITING_FOR_DEPENDENCY_MS };
    }

    /**
     * Best-effort: writes a failure into status so users see it with
     * `kubectl describe`. Never throws — the real error is reported by the
     * caller, and losing the status write must not lose the error.
     */
    async recordFailure(namespace: string, name: string, error: unknown): Promise<void> {
        const message = error instanceof Error ? error.message : String(error);
        const reason =
            error instanceof HetznerApiError
                ? toReason(error.code)
                : ConditionReason.ReconcileError;

        try {
            const resource = await this.store.get(namespace, name);
            if (!resource) {
                return;
            }
            this.events.warning(resource, reason, message);

            const generation = resource.metadata?.generation;
            await this.store.patchStatus(namespace, name, {
                phase: 'Error',
                message,
                ...(generation !== undefined ? { observedGeneration: generation } : {}),
                conditions: setConditions(
                    resource.status?.conditions,
                    [
                        {
                            type: CONDITION_SYNCED,
                            status: 'False',
                            reason,
                            message,
                            ...(generation !== undefined ? { observedGeneration: generation } : {}),
                        },
                    ],
                    this.now(),
                ),
            } as TStatus);
        } catch (statusError) {
            this.logger.warn('Could not write the error status', {
                resource: `${namespace}/${name}`,
                error: statusError,
            });
        }
    }

    /** A resource can be Ready and out of sync at the same time; say so. */
    private phaseFor(projected: Phase, syncedProblem: string | undefined): Phase {
        if (!syncedProblem) {
            return projected;
        }
        return projected === 'Ready' ? 'Updating' : projected;
    }

    /** Writes status, filling in observedGeneration and condition timestamps. */
    private async writeStatus(
        context: ReconcileContext<TSpec, TStatus>,
        status: StatusPatch,
    ): Promise<void> {
        const { namespace, name, resource } = context;
        const generation = resource.metadata?.generation;
        const { conditions, ...rest } = status;

        await this.store.patchStatus(namespace, name, {
            ...rest,
            ...(generation !== undefined ? { observedGeneration: generation } : {}),
            ...(conditions
                ? {
                      conditions: setConditions(
                          resource.status?.conditions,
                          conditions.map((condition) => ({
                              ...condition,
                              ...(generation !== undefined
                                  ? { observedGeneration: generation }
                                  : {}),
                          })),
                          this.now(),
                      ),
                  }
                : {}),
        } as TStatus);
    }
}
