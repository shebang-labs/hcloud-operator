/**
 * Hetzner action tracking.
 *
 * Almost every mutating call in the Hetzner Cloud API is asynchronous: the HTTP
 * request returns 201 with an `Action` object still in `running`, and the work
 * finishes seconds or minutes later. Treating that 201 as "done" is the single
 * most common bug in a Hetzner integration — you attach a volume, immediately
 * read the server back, and see no volume.
 *
 * `ActionTracker` closes that gap: it polls one action to a terminal state and
 * turns `error` into a typed exception carrying Hetzner's own error code.
 *
 * Hetzner is migrating from the global `/actions/{id}` endpoint to per-resource
 * ones (`/servers/actions/{id}`), so the scope is passed in by each resource
 * module and the global path stays as the fallback.
 *
 * Waiting is abortable. A resize or rebuild can take minutes; a Pod that keeps
 * polling through SIGTERM is SIGKILLed at the end of its grace period, and the
 * next leader would rather pick the work up now than after that.
 */

import { HetznerActionError, HetznerActionTimeoutError, HetznerApiError } from './errors.js';
import type { HttpClient } from './http.js';
import type { Action } from './types.js';

/** Resource prefix for the per-resource action endpoints. */
export type ActionScope =
    | 'servers'
    | 'volumes'
    | 'images'
    | 'networks'
    | 'firewalls'
    | 'load_balancers'
    | 'floating_ips'
    | 'primary_ips'
    | 'certificates'
    | 'placement_groups';

/**
 * The wait was abandoned because the operator is shutting down. The action
 * itself keeps running on Hetzner's side; the next reconcile re-observes it.
 */
export class HetznerActionAbortedError extends Error {
    readonly actionId: number;
    readonly command: string;
    readonly retryable = true;

    constructor(actionId: number, command: string) {
        super(
            `Stopped waiting for Hetzner action "${command}" (${actionId}) because the operator is shutting down; it may still be running`,
        );
        this.name = 'HetznerActionAbortedError';
        this.actionId = actionId;
        this.command = command;
    }
}

export interface ActionTrackerOptions {
    http: HttpClient;
    /** Total budget before giving up on an action. */
    timeoutMs?: number;
    /** First poll delay. Grows geometrically up to `maxPollIntervalMs`. */
    pollIntervalMs?: number;
    maxPollIntervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    onSettled?: (command: string, outcome: 'success' | 'error' | 'timeout') => void;
    /** Aborting it makes every pending wait fail with `HetznerActionAbortedError`. */
    signal?: AbortSignal;
}

export interface ActionTracker {
    /** Waits for one action. `undefined` means "the call was synchronous". */
    wait(action: Action | undefined | null, scope?: ActionScope): Promise<void>;
    /** Waits for several actions concurrently, failing on the first error. */
    waitAll(
        actions: Array<Action | undefined | null> | undefined,
        scope?: ActionScope,
    ): Promise<void>;
}

function isTerminal(action: Action): boolean {
    return action.status === 'success' || action.status === 'error';
}

function toActionError(action: Action): HetznerActionError {
    return new HetznerActionError({
        actionId: action.id,
        command: action.command,
        code: action.error?.code ?? 'action_failed',
        message: action.error?.message ?? 'the action finished in state "error"',
    });
}

export function createActionTracker(options: ActionTrackerOptions): ActionTracker {
    const { http, onSettled } = options;
    const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    const firstPollMs = options.pollIntervalMs ?? 500;
    const maxPollMs = options.maxPollIntervalMs ?? 5_000;
    const now = options.now ?? (() => Date.now());
    const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const signal = options.signal;

    /** Sleeps, but returns early when the signal aborts. An injected sleep is wrapped the same way. */
    function pause(ms: number): Promise<void> {
        if (!signal) {
            return sleep(ms);
        }
        return new Promise<void>((resolve) => {
            const onAbort = () => resolve();
            signal.addEventListener('abort', onAbort, { once: true });
            const done = () => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            };
            sleep(ms).then(done, done);
        });
    }

    function throwIfAborted(action: Action): void {
        if (signal?.aborted) {
            throw new HetznerActionAbortedError(action.id, action.command);
        }
    }

    async function fetchAction(id: number, scope: ActionScope | undefined): Promise<Action> {
        const paths = scope ? [`/${scope}/actions/${id}`, `/actions/${id}`] : [`/actions/${id}`];
        let lastError: unknown;
        for (const path of paths) {
            try {
                const response = await http.get<{ action: Action }>(path);
                return response.action;
            } catch (error) {
                // A 404 on the per-resource path means this deployment only has
                // the global one (or vice versa): try the next candidate.
                if (error instanceof HetznerApiError && error.isNotFound) {
                    lastError = error;
                    continue;
                }
                throw error;
            }
        }
        throw lastError;
    }

    async function wait(action: Action | undefined | null, scope?: ActionScope): Promise<void> {
        if (!action) {
            return; // The call was synchronous; there is nothing to wait for.
        }

        let current = action;
        const deadline = now() + timeoutMs;
        let pollMs = firstPollMs;

        while (!isTerminal(current)) {
            throwIfAborted(current);
            if (now() >= deadline) {
                onSettled?.(current.command, 'timeout');
                throw new HetznerActionTimeoutError(current.id, current.command, timeoutMs);
            }
            await pause(pollMs);
            // Not reported to onSettled: the action did not settle, we left.
            throwIfAborted(current);
            pollMs = Math.min(maxPollMs, Math.ceil(pollMs * 1.5));
            current = await fetchAction(current.id, scope);
        }

        if (current.status === 'error') {
            onSettled?.(current.command, 'error');
            throw toActionError(current);
        }
        onSettled?.(current.command, 'success');
    }

    return {
        wait,
        async waitAll(actions, scope) {
            if (!actions?.length) {
                return;
            }
            // Promise.all rejects on the first failure but leaves the others
            // running, which is what we want: a failed sub-action should surface
            // immediately, and the reconcile will re-observe reality anyway.
            await Promise.all(actions.map((action) => wait(action, scope)));
        },
    };
}
