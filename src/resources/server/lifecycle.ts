/**
 * Turning the server's declarative fields into Hetzner actions.
 *
 * The idea behind every function here is the same: read the server's real
 * state, compare it to the spec, and issue at most the one action that moves
 * reality one step closer. Anything that cannot be finished in a single pass
 * (a shutdown that has to be waited out, a resize that needs the server off
 * first) records what it is waiting for in status and asks to be called again.
 *
 * That "one step per pass" shape is what keeps these operations safe to
 * interrupt. The operator can be killed at any point and the next reconcile
 * picks up from whatever the server actually looks like, not from a plan it
 * was half-way through.
 */

import type { ReconcileContext } from '../../framework/types.js';
import type { ServerApi } from '../../hcloud/resources/servers.js';
import type { Server } from '../../hcloud/types.js';
import type { ChangeLog } from '../common.js';
import {
    DEFAULT_GRACEFUL_SHUTDOWN_SECONDS,
    desiredServerTypes,
    type HetznerServerSpec,
    type HetznerServerStatus,
    type PowerState,
} from './spec.js';

export type ServerContext = ReconcileContext<HetznerServerSpec, HetznerServerStatus>;

/** What a lifecycle step wants to happen next. */
export interface StepResult {
    /** Come back after this delay; the step is not finished. */
    requeueAfterMs?: number;
    /** A change the user asked for that needs a guard flag first. */
    blocked?: string;
    /** Status bookkeeping to persist. */
    statusPatch?: Record<string, unknown>;
    /** True when this step issued an action, so later steps should stand down. */
    acted?: boolean;
}

const NOTHING: StepResult = {};

/** How long to wait while a power transition is in flight. */
const REQUEUE_WHILE_POWERING_MS = 10_000;

/**
 * Where "now" comes from. The engine has its own injectable clock but does not
 * hand it to adapters, so the steps that measure elapsed time take one of their
 * own; tests advance it instead of sleeping through a grace period.
 */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

export function desiredPowerState(spec: HetznerServerSpec): PowerState {
    return spec.powerState ?? 'Running';
}

/**
 * Resize.
 *
 * Hetzner only changes a server's type while it is powered off, so this is a
 * three-step dance: shut down, change the type, power back on. `pendingOperation`
 * remembers that the operator — not the user — powered the server off, so it
 * knows to start it again afterwards.
 *
 * Any type the spec lists counts as in sync, not just the first. A server that
 * fell back to a smaller type because Hetzner had no capacity for the preferred
 * one is a server that is working, and pulling it back up the list later would
 * mean an unrequested resize: downtime for a node nobody complained about, and
 * a disk that cannot be shrunk again if it grows. Only a type that has left the
 * list entirely is drift — which takes a deliberate edit, and still needs
 * `allowDowntime` before anything happens.
 */
export async function convergeServerType(
    api: ServerApi,
    context: ServerContext,
    remote: Server,
    log: ChangeLog,
    clock: Clock = systemClock,
): Promise<StepResult> {
    const { spec } = context;
    const wanted = desiredServerTypes(spec);
    // The first entry is where a server the spec no longer covers is sent.
    const target = wanted[0];
    const actualType = remote.server_type?.name;
    if (!actualType || !target || wanted.includes(actualType)) {
        // Nothing to do. If we were mid-resize, the operation is complete.
        return context.resource.status?.pendingOperation === 'Resizing'
            ? { statusPatch: { pendingOperation: null } }
            : NOTHING;
    }

    if (!spec.allowDowntime) {
        return {
            blocked:
                `spec no longer lists "${actualType}", which the server runs; it would be ` +
                `resized to "${target}", the first type the list does name. ` +
                'Resizing powers the server off and back on, so set spec.allowDowntime: true to apply it.',
        };
    }

    switch (remote.status) {
        case 'off':
            context.logger.info('Changing the server type', {
                from: actualType,
                to: target,
                upgradeDisk: spec.upgradeDisk ?? false,
            });
            await api.changeType(remote.id, target, spec.upgradeDisk ?? false);
            log.record(`resized from ${actualType} to ${target}`);
            // Power the server back on only if we are the ones who stopped it
            // and the spec still asks for it to be running.
            if (
                context.resource.status?.pendingOperation === 'Resizing' &&
                desiredPowerState(spec) === 'Running'
            ) {
                await api.powerOn(remote.id);
                log.record('powered back on after the resize');
            }
            return {
                acted: true,
                statusPatch: { pendingOperation: null },
                requeueAfterMs: REQUEUE_WHILE_POWERING_MS,
            };

        case 'running': {
            // The same shutdown-then-force escalation as `powerState: Stopped`.
            // It has to be the same code: the adapter stops the pass after a
            // disruptive step, so the escalation in convergePowerState would
            // never be reached from here, and a guest that ignores ACPI would be
            // asked to shut down again on every pass, forever.
            const result = await stopGracefully(api, context, remote, log, clock, 'to resize');
            return {
                ...result,
                // Remember that the operator, not the user, is stopping the
                // server, so the 'off' branch knows to start it again afterwards.
                statusPatch: { ...result.statusPatch, pendingOperation: 'Resizing' },
            };
        }

        default:
            // stopping / starting / migrating: wait for Hetzner to settle.
            return { requeueAfterMs: REQUEUE_WHILE_POWERING_MS };
    }
}

/**
 * Rebuild. Erases the disk, so it needs `allowDataLoss` and nothing else: the
 * action works whatever power state the server is in.
 */
export async function convergeImage(
    api: ServerApi,
    context: ServerContext,
    remote: Server,
    log: ChangeLog,
): Promise<StepResult> {
    const { spec } = context;
    if (imageMatches(spec.image, remote)) {
        return NOTHING;
    }

    const actual = describeImage(remote);
    if (!spec.allowDataLoss) {
        // A snapshot has no name, so a server built from one can only ever match
        // its numeric id. Say so, because the fix may be to change spec.image
        // rather than to erase the disk.
        const hint =
            remote.image && remote.image.name == null
                ? ` That is a snapshot, which only matches spec.image "${remote.image.id}"; set that to keep the disk.`
                : '';
        return {
            blocked:
                `spec.image is "${spec.image}" but the server was built from "${actual}". ` +
                `Rebuilding erases the disk, so set spec.allowDataLoss: true to apply it.${hint}`,
        };
    }

    context.logger.warn('Rebuilding the server — its disk will be erased', {
        from: actual,
        to: spec.image,
    });
    await api.rebuild(remote.id, spec.image);
    log.record(`rebuilt from image ${spec.image}`);
    return { acted: true, requeueAfterMs: REQUEUE_WHILE_POWERING_MS };
}

/**
 * Power state.
 *
 * "Off" first asks the guest to stop cleanly, and only cuts the power once the
 * grace period has passed — the same escalation an administrator would do by
 * hand, and the reason `shutdownRequestedAt` is tracked in status.
 */
export async function convergePowerState(
    api: ServerApi,
    context: ServerContext,
    remote: Server,
    log: ChangeLog,
    clock: Clock = systemClock,
): Promise<StepResult> {
    const { spec } = context;
    const desired = desiredPowerState(spec);
    const status = remote.status;

    if (desired === 'Running') {
        if (status === 'running') {
            return NOTHING;
        }
        if (status === 'off') {
            context.logger.info('Powering the server on');
            await api.powerOn(remote.id);
            log.record('powered on');
            return {
                acted: true,
                statusPatch: { shutdownRequestedAt: null },
                requeueAfterMs: REQUEUE_WHILE_POWERING_MS,
            };
        }
        // starting / initializing: already on its way.
        return { requeueAfterMs: REQUEUE_WHILE_POWERING_MS };
    }

    if (status === 'off') {
        return context.resource.status?.shutdownRequestedAt
            ? { statusPatch: { shutdownRequestedAt: null } }
            : NOTHING;
    }

    if (status !== 'running') {
        // stopping: give it time to finish on its own.
        return { requeueAfterMs: REQUEUE_WHILE_POWERING_MS };
    }

    return stopGracefully(api, context, remote, log, clock);
}

/**
 * Takes a running server one step towards being off.
 *
 * First pass: ask the guest to shut down and note when. Later passes: wait, and
 * once the grace period is over cut the power. The request is deliberately not
 * re-sent while waiting — that would restart the clock each pass, and a guest
 * that ignores ACPI would then never be forced off.
 */
async function stopGracefully(
    api: ServerApi,
    context: ServerContext,
    remote: Server,
    log: ChangeLog,
    clock: Clock,
    purpose?: string,
): Promise<StepResult> {
    const { spec } = context;
    const suffix = purpose ? ` ${purpose}` : '';

    const requestedAt = context.resource.status?.shutdownRequestedAt;
    if (!requestedAt) {
        context.logger.info('Asking the guest to shut down', { purpose: purpose ?? 'to stop' });
        await api.shutdown(remote.id);
        log.record(`requested a graceful shutdown${suffix}`);
        return {
            acted: true,
            statusPatch: { shutdownRequestedAt: clock().toISOString() },
            requeueAfterMs: REQUEUE_WHILE_POWERING_MS,
        };
    }

    const graceMs =
        (spec.gracefulShutdownTimeoutSeconds ?? DEFAULT_GRACEFUL_SHUTDOWN_SECONDS) * 1000;
    const waitedMs = clock().getTime() - new Date(requestedAt).getTime();
    if (waitedMs < graceMs) {
        return { requeueAfterMs: REQUEUE_WHILE_POWERING_MS };
    }

    context.logger.warn('The guest did not shut down in time; cutting the power', {
        waitedMs,
        graceMs,
    });
    await api.powerOff(remote.id);
    log.record(`forced the server off${suffix} after the graceful shutdown timed out`);
    return {
        acted: true,
        statusPatch: { shutdownRequestedAt: null },
        requeueAfterMs: REQUEUE_WHILE_POWERING_MS,
    };
}

/** Daily backups. A plain on/off toggle. */
export async function convergeBackups(
    api: ServerApi,
    context: ServerContext,
    remote: Server,
    log: ChangeLog,
): Promise<StepResult> {
    const desired = context.spec.backups;
    if (desired === undefined) {
        return NOTHING;
    }
    const actual = Boolean(remote.backup_window);
    if (desired === actual) {
        return NOTHING;
    }

    if (desired) {
        await api.enableBackup(remote.id);
        log.record('enabled daily backups');
    } else {
        await api.disableBackup(remote.id);
        log.record('disabled daily backups');
    }
    return { acted: true };
}

/**
 * Rescue mode. Enabling it only takes effect on the next boot, which is why the
 * operator does not reboot the server for you: that decision belongs to whoever
 * is about to debug it.
 */
export async function convergeRescue(
    api: ServerApi,
    context: ServerContext,
    remote: Server,
    log: ChangeLog,
): Promise<StepResult> {
    const desired = context.spec.rescue;
    if (desired === undefined) {
        return NOTHING;
    }
    const actual = remote.rescue_enabled ?? false;
    if (desired.enabled === actual) {
        return NOTHING;
    }

    if (desired.enabled) {
        const sshKeyIds = await context.refs.resolveAll(
            'HetznerSSHKey',
            desired.sshKeyRefs,
            context.namespace,
        );
        await api.enableRescue(remote.id, {
            ...(desired.type ? { type: desired.type } : {}),
            sshKeyIds,
        });
        log.record('enabled the rescue system (effective on the next boot)');
    } else {
        await api.disableRescue(remote.id);
        log.record('disabled the rescue system');
    }
    return { acted: true };
}

/** Attached ISO. `spec.iso: null` (or omitted) means "none". */
export async function convergeIso(
    api: ServerApi,
    context: ServerContext,
    remote: Server,
    log: ChangeLog,
): Promise<StepResult> {
    const desired = context.spec.iso ?? null;
    const actual = remote.iso?.name ?? null;
    if (desired === actual) {
        return NOTHING;
    }

    if (desired === null) {
        await api.detachIso(remote.id);
        log.record(`detached ISO ${actual}`);
    } else {
        await api.attachIso(remote.id, desired);
        log.record(`attached ISO ${desired}`);
    }
    return { acted: true };
}

/* -------------------------------------------------------------------------- */

/**
 * Hetzner reports system images by name ("ubuntu-24.04") and snapshots by id
 * with a null name, so `spec.image` is compared against whichever the server
 * actually has.
 */
export function imageMatches(desired: string, remote: Server): boolean {
    const image = remote.image;
    if (!image) {
        // The server was rebuilt from a since-deleted image; nothing to compare.
        return true;
    }
    if (/^\d+$/.test(desired)) {
        return image.id === Number(desired);
    }
    // A nameless image is a snapshot, and a snapshot is never "ubuntu-24.04".
    // Letting it pass would make a rebuild request disappear without a trace.
    return image.name === desired;
}

export function describeImage(remote: Server): string {
    return (
        remote.image?.name ?? (remote.image?.id !== undefined ? `#${remote.image.id}` : 'unknown')
    );
}
