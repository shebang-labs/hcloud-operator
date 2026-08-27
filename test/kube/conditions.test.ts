/**
 * Conditions are what a user reads in `kubectl describe`, and the one rule that
 * makes them useful is that `lastTransitionTime` changes only when the *status*
 * flips. A controller that stamps it on every reconcile turns "Ready since
 * Tuesday" into "Ready since four seconds ago", every five minutes, forever.
 */

import { describe, expect, it } from 'vitest';
import type { ResourceCondition } from '../../src/kube/api.js';
import {
    CONDITION_READY,
    CONDITION_SYNCED,
    findCondition,
    isConditionTrue,
    setCondition,
    setConditions,
    toReason,
} from '../../src/kube/conditions.js';

const monday = new Date('2026-01-05T09:00:00.000Z');
const tuesday = new Date('2026-01-06T09:00:00.000Z');

const ready: ResourceCondition = {
    type: CONDITION_READY,
    status: 'True',
    reason: 'Ready',
    message: 'The server is running',
    lastTransitionTime: monday.toISOString(),
};

describe('setCondition', () => {
    it('adds a condition that was not there', () => {
        const result = setCondition(
            undefined,
            {
                type: CONDITION_READY,
                status: 'True',
                reason: 'Ready',
                message: 'up',
            },
            monday,
        );

        expect(result).toHaveLength(1);
        expect(result[0]?.lastTransitionTime).toBe(monday.toISOString());
    });

    it('keeps lastTransitionTime when the status is unchanged', () => {
        const result = setCondition(
            [ready],
            {
                type: CONDITION_READY,
                status: 'True',
                reason: 'StillReady',
                message: 'a different message',
            },
            tuesday,
        );

        expect(result[0]?.lastTransitionTime).toBe(monday.toISOString());
        // Reason and message still update; only the timestamp is sticky.
        expect(result[0]?.reason).toBe('StillReady');
        expect(result[0]?.message).toBe('a different message');
    });

    it('moves lastTransitionTime when the status flips', () => {
        const result = setCondition(
            [ready],
            {
                type: CONDITION_READY,
                status: 'False',
                reason: 'NotReady',
                message: 'down',
            },
            tuesday,
        );

        expect(result[0]?.lastTransitionTime).toBe(tuesday.toISOString());
    });

    it('never mutates the list it was given', () => {
        const original = [ready];
        setCondition(
            original,
            {
                type: CONDITION_READY,
                status: 'False',
                reason: 'NotReady',
                message: 'down',
            },
            tuesday,
        );

        expect(original[0]?.status).toBe('True');
    });

    it('leaves other conditions untouched', () => {
        const synced: ResourceCondition = { ...ready, type: CONDITION_SYNCED };
        const result = setCondition(
            [ready, synced],
            {
                type: CONDITION_READY,
                status: 'False',
                reason: 'NotReady',
                message: 'down',
            },
            tuesday,
        );

        expect(result).toHaveLength(2);
        expect(findCondition(result, CONDITION_SYNCED)?.status).toBe('True');
    });

    it('carries observedGeneration through when given', () => {
        const result = setCondition(
            undefined,
            {
                type: CONDITION_READY,
                status: 'True',
                reason: 'Ready',
                message: 'up',
                observedGeneration: 7,
            },
            monday,
        );

        expect(result[0]?.observedGeneration).toBe(7);
    });

    it('truncates a message the API server would reject', () => {
        const result = setCondition(
            undefined,
            {
                type: CONDITION_READY,
                status: 'False',
                reason: 'Error',
                message: 'x'.repeat(10_000),
            },
            monday,
        );

        expect(result[0]?.message.length ?? 0).toBeLessThanOrEqual(2_000);
        expect(result[0]?.message.endsWith('...')).toBe(true);
    });
});

describe('setConditions', () => {
    it('applies several in one pass', () => {
        const result = setConditions(
            undefined,
            [
                { type: CONDITION_READY, status: 'True', reason: 'Ready', message: 'up' },
                { type: CONDITION_SYNCED, status: 'False', reason: 'Drift', message: 'differs' },
            ],
            monday,
        );

        expect(result.map((condition) => condition.type)).toEqual([
            CONDITION_READY,
            CONDITION_SYNCED,
        ]);
    });
});

describe('isConditionTrue', () => {
    it('is true only for a present condition whose status is True', () => {
        expect(isConditionTrue([ready], CONDITION_READY)).toBe(true);
        expect(isConditionTrue([{ ...ready, status: 'False' }], CONDITION_READY)).toBe(false);
        expect(isConditionTrue([{ ...ready, status: 'Unknown' }], CONDITION_READY)).toBe(false);
        expect(isConditionTrue([], CONDITION_READY)).toBe(false);
        expect(isConditionTrue(undefined, CONDITION_READY)).toBe(false);
    });
});

describe('toReason', () => {
    it.each([
        ['uniqueness_error', 'UniquenessError'],
        ['not_found', 'NotFound'],
        ['rate_limit_exceeded', 'RateLimitExceeded'],
        ['http_500', 'Http500'],
        ['already', 'Already'],
        ['', 'Error'],
        ['___', 'Error'],
    ])('turns %o into %o', (code, expected) => {
        expect(toReason(code)).toBe(expected);
    });
});
