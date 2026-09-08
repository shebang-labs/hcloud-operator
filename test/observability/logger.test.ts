/**
 * The one property that really matters: a Hetzner token, or anything else
 * attached to an axios error, must never reach a log line.
 */

import axios from 'axios';
import { describe, expect, it } from 'vitest';
import { createLogger, type LogLevel, nullLogger } from '../../src/observability/logger.js';

function capture(level: LogLevel = 'debug') {
    const lines: Array<{ level: LogLevel; payload: Record<string, unknown> }> = [];
    const logger = createLogger(
        level,
        {},
        {
            write: (line, lineLevel) => lines.push({ level: lineLevel, payload: JSON.parse(line) }),
        },
    );
    return { logger, lines };
}

describe('createLogger', () => {
    it('emits one JSON object per line with time, level and message', () => {
        const { logger, lines } = capture();

        logger.info('Reconciling', { resource: 'default/web-01' });

        expect(lines[0]?.payload).toMatchObject({
            level: 'info',
            message: 'Reconciling',
            resource: 'default/web-01',
        });
        expect(String(lines[0]?.payload.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('drops lines below the configured level', () => {
        const { logger, lines } = capture('warn');

        logger.debug('noise');
        logger.info('noise');
        logger.warn('kept');
        logger.error('kept');

        expect(lines.map((entry) => entry.payload.message)).toEqual(['kept', 'kept']);
    });

    it('sends warnings and errors to stderr, everything else to stdout', () => {
        const { logger, lines } = capture();

        logger.info('out');
        logger.warn('err');

        expect(lines[0]?.level).toBe('info');
        expect(lines[1]?.level).toBe('warn');
    });

    it('merges child fields, with the call site winning', () => {
        const { logger, lines } = capture();

        logger
            .child({ kind: 'HetznerServer' })
            .child({ resource: 'a' })
            .info('x', { resource: 'b' });

        expect(lines[0]?.payload).toMatchObject({ kind: 'HetznerServer', resource: 'b' });
    });

    it('reduces an Error to its name, message and known codes', () => {
        const { logger, lines } = capture();
        const error = Object.assign(new Error('boom'), { code: 'not_found', status: 404 });

        logger.error('failed', { error });

        expect(lines[0]?.payload.error).toEqual({
            name: 'Error',
            message: 'boom',
            code: 'not_found',
            status: 404,
        });
    });

    it('never serialises an axios error’s request, which carries the token', () => {
        const { logger, lines } = capture();
        const axiosError = new axios.AxiosError(
            'Request failed',
            '403',
            {
                url: '/servers',
                headers: { Authorization: 'Bearer super-secret-token' },
            } as never,
            {},
            undefined,
        );

        logger.error('failed', { error: axiosError });

        expect(JSON.stringify(lines[0]?.payload)).not.toContain('super-secret-token');
    });

    it('passes a non-Error error value through unchanged', () => {
        const { logger, lines } = capture();

        logger.error('failed', { error: 'a plain string' });

        expect(lines[0]?.payload.error).toBe('a plain string');
    });
});

describe('nullLogger', () => {
    it('discards everything without throwing', () => {
        expect(() => {
            nullLogger.debug('x');
            nullLogger.info('x');
            nullLogger.warn('x');
            nullLogger.error('x', { error: new Error('boom') });
            nullLogger.child({ a: 1 }).info('x');
        }).not.toThrow();
    });
});

describe('unserialisable fields', () => {
    it('never throws, and still gets the message out', () => {
        const { logger, lines } = capture();
        const circular: Record<string, unknown> = { name: 'loop' };
        circular.self = circular;

        expect(() =>
            logger.info('odd payload', { circular, big: BigInt(10), fine: 'ok' }),
        ).not.toThrow();

        expect(lines).toHaveLength(1);
        expect(lines[0]?.payload).toMatchObject({
            level: 'info',
            message: 'odd payload',
            fine: 'ok',
        });
        expect(typeof lines[0]?.payload.circular).toBe('string');
        expect(lines[0]?.payload.big).toBe('10');
    });

    it('keeps the base fields of a child logger on the fallback line', () => {
        const { logger, lines } = capture();
        const circular: Record<string, unknown> = {};
        circular.self = circular;

        logger.child({ kind: 'HetznerServer' }).error('failed', { circular });

        expect(lines[0]?.payload).toMatchObject({ kind: 'HetznerServer', message: 'failed' });
    });
});
