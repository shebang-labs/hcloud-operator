/**
 * Action tracking is the difference between "the request returned" and "the
 * server actually changed". Getting it wrong produces the classic Hetzner bug:
 * attach a volume, read the server back, see nothing.
 */

import { describe, expect, it, vi } from 'vitest';
import { createActionTracker } from '../../src/hcloud/actions.js';
import {
    HetznerActionError,
    HetznerActionTimeoutError,
    HetznerApiError,
} from '../../src/hcloud/errors.js';
import type { HttpClient } from '../../src/hcloud/http.js';
import type { Action } from '../../src/hcloud/types.js';

function running(id = 1, command = 'attach_volume'): Action {
    return { id, command, status: 'running', progress: 0, error: null };
}

/** An HTTP client that serves a scripted sequence of action states. */
function actionServer(states: Record<number, Action[]>, options: { only?: string } = {}) {
    const requested: string[] = [];
    const cursors = new Map<number, number>();

    const http: HttpClient = {
        async get<T>(path: string): Promise<T> {
            requested.push(path);
            if (options.only && !path.startsWith(options.only)) {
                throw new HetznerApiError({
                    status: 404,
                    code: 'not_found',
                    message: `no handler for ${path}`,
                    retryable: false,
                });
            }
            const id = Number(path.split('/').pop());
            const sequence = states[id] ?? [];
            const cursor = Math.min(cursors.get(id) ?? 0, sequence.length - 1);
            cursors.set(id, cursor + 1);
            const action = sequence[cursor];
            if (!action) {
                throw new HetznerApiError({
                    status: 404,
                    code: 'not_found',
                    message: 'unknown action',
                    retryable: false,
                });
            }
            return { action } as T;
        },
        post: async () => ({}) as never,
        put: async () => ({}) as never,
        delete: async () => ({}) as never,
        list: async () => [],
    };

    return { http, requested };
}

const instant = { pollIntervalMs: 0, maxPollIntervalMs: 0, sleep: async () => undefined };

describe('ActionTracker', () => {
    it('returns immediately for a synchronous call', async () => {
        const { http, requested } = actionServer({});
        const tracker = createActionTracker({ http, ...instant });

        await expect(tracker.wait(undefined)).resolves.toBeUndefined();
        await expect(tracker.wait(null)).resolves.toBeUndefined();
        expect(requested).toHaveLength(0);
    });

    it('returns immediately for an action that is already successful', async () => {
        const { http, requested } = actionServer({});
        const tracker = createActionTracker({ http, ...instant });

        await tracker.wait({ id: 1, command: 'poweron', status: 'success' });

        expect(requested).toHaveLength(0);
    });

    it('polls a running action until it succeeds', async () => {
        const { http, requested } = actionServer({
            1: [running(), running(), { ...running(), status: 'success' }],
        });
        const tracker = createActionTracker({ http, ...instant });

        await tracker.wait(running());

        expect(requested).toHaveLength(3);
    });

    it('throws a typed error when the action fails', async () => {
        const { http } = actionServer({
            1: [
                {
                    id: 1,
                    command: 'change_type',
                    status: 'error',
                    error: { code: 'server_not_stopped', message: 'power it off first' },
                },
            ],
        });
        const tracker = createActionTracker({ http, ...instant });

        const error = await tracker.wait(running(1, 'change_type')).catch((caught) => caught);

        expect(error).toBeInstanceOf(HetznerActionError);
        expect(error.code).toBe('server_not_stopped');
        expect(error.message).toContain('power it off first');
    });

    it('gives up after the timeout and says the action may still be running', async () => {
        let now = 0;
        const { http } = actionServer({ 1: [running()] });
        const tracker = createActionTracker({
            http,
            timeoutMs: 5_000,
            pollIntervalMs: 1_000,
            maxPollIntervalMs: 1_000,
            now: () => now,
            sleep: async (ms) => {
                now += ms;
            },
        });

        await expect(tracker.wait(running())).rejects.toBeInstanceOf(HetznerActionTimeoutError);
    });

    it('backs off between polls rather than hammering the API', async () => {
        const delays: number[] = [];
        const { http } = actionServer({
            1: [running(), running(), running(), { ...running(), status: 'success' }],
        });
        const tracker = createActionTracker({
            http,
            pollIntervalMs: 100,
            maxPollIntervalMs: 500,
            sleep: async (ms) => {
                delays.push(ms);
            },
        });

        await tracker.wait(running());

        expect(delays[0]).toBe(100);
        expect(delays[1]).toBeGreaterThan(delays[0] ?? 0);
    });

    it('prefers the per-resource action endpoint', async () => {
        const { http, requested } = actionServer(
            { 1: [{ ...running(), status: 'success' }] },
            { only: '/servers/actions' },
        );
        const tracker = createActionTracker({ http, ...instant });

        await tracker.wait(running(), 'servers');

        expect(requested[0]).toBe('/servers/actions/1');
    });

    it('falls back to the global endpoint when the per-resource one 404s', async () => {
        const { http, requested } = actionServer(
            { 1: [{ ...running(), status: 'success' }] },
            { only: '/actions' },
        );
        const tracker = createActionTracker({ http, ...instant });

        await tracker.wait(running(), 'servers');

        expect(requested).toEqual(['/servers/actions/1', '/actions/1']);
    });

    it('does not swallow a non-404 while polling', async () => {
        const http: HttpClient = {
            get: async () => {
                throw new HetznerApiError({
                    status: 500,
                    code: 'server_error',
                    message: 'boom',
                    retryable: true,
                });
            },
            post: async () => ({}) as never,
            put: async () => ({}) as never,
            delete: async () => ({}) as never,
            list: async () => [],
        };
        const tracker = createActionTracker({ http, ...instant });

        await expect(tracker.wait(running())).rejects.toThrow(/boom/);
    });

    it('waits for several actions and fails on the first error', async () => {
        const { http } = actionServer({
            1: [{ ...running(1), status: 'success' }],
            2: [
                {
                    id: 2,
                    command: 'attach_to_network',
                    status: 'error',
                    error: { code: 'ip_not_available', message: 'address in use' },
                },
            ],
        });
        const tracker = createActionTracker({ http, ...instant });

        await expect(
            tracker.waitAll([running(1), running(2, 'attach_to_network')]),
        ).rejects.toThrow(/address in use/);
    });

    it('does nothing for an empty or absent action list', async () => {
        const { http, requested } = actionServer({});
        const tracker = createActionTracker({ http, ...instant });

        await tracker.waitAll(undefined);
        await tracker.waitAll([]);

        expect(requested).toHaveLength(0);
    });

    it('reports each outcome to the metrics callback', async () => {
        const onSettled = vi.fn();
        const { http } = actionServer({ 1: [{ ...running(), status: 'success' }] });
        const tracker = createActionTracker({ http, ...instant, onSettled });

        await tracker.wait(running(1, 'poweron'));

        expect(onSettled).toHaveBeenCalledWith('attach_volume', 'success');
    });
});
