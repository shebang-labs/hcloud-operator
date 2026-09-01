/**
 * The small comparison helpers the adapters share.
 *
 * These look trivial, and each one guards against the same class of bug: an
 * over-eager comparison that reports a difference on every resync and makes the
 * operator rewrite a resource that was already correct.
 */

import { describe, expect, it } from 'vitest';
import {
    ChangeLog,
    deepEqual,
    dnsPtrChanges,
    protectionMatches,
    sameSet,
    toProtectionPayload,
} from '../../src/resources/common.js';

describe('protectionMatches', () => {
    it('is satisfied when the spec asks for nothing', () => {
        expect(protectionMatches({ delete: true }, undefined)).toBe(true);
        expect(protectionMatches(undefined, {})).toBe(true);
    });

    it('treats an absent remote flag as false', () => {
        expect(protectionMatches(undefined, { delete: false })).toBe(true);
        expect(protectionMatches(undefined, { delete: true })).toBe(false);
        expect(protectionMatches({}, { delete: false })).toBe(true);
    });

    it('compares only the flags the spec sets', () => {
        // A spec that mentions only `delete` must not fight over `rebuild`.
        expect(protectionMatches({ delete: true, rebuild: true }, { delete: true })).toBe(true);
        expect(protectionMatches({ delete: true, rebuild: false }, { rebuild: true })).toBe(false);
    });
});

describe('toProtectionPayload', () => {
    it('sends only the flags that were set', () => {
        expect(toProtectionPayload({ delete: true })).toEqual({ delete: true });
        expect(toProtectionPayload({ delete: false, rebuild: true })).toEqual({
            delete: false,
            rebuild: true,
        });
        expect(toProtectionPayload({})).toEqual({});
    });
});

describe('dnsPtrChanges', () => {
    it('returns nothing when the spec declares no entries', () => {
        expect(dnsPtrChanges([{ ip: '1.2.3.4', dns_ptr: 'a' }], undefined)).toEqual([]);
        expect(dnsPtrChanges(undefined, [])).toEqual([]);
    });

    it('returns only the entries that differ', () => {
        const actual = [
            { ip: '1.2.3.4', dns_ptr: 'a.example.com' },
            { ip: '5.6.7.8', dns_ptr: 'b.example.com' },
        ];

        expect(
            dnsPtrChanges(actual, [
                { ip: '1.2.3.4', dnsPtr: 'a.example.com' },
                { ip: '5.6.7.8', dnsPtr: 'changed.example.com' },
            ]),
        ).toEqual([{ ip: '5.6.7.8', dnsPtr: 'changed.example.com' }]);
    });

    it('treats an address with no entry yet as a change', () => {
        expect(dnsPtrChanges([], [{ ip: '1.2.3.4', dnsPtr: 'a' }])).toEqual([
            { ip: '1.2.3.4', dnsPtr: 'a' },
        ]);
    });

    it('treats clearing an entry as a change, and clearing a cleared one as nothing', () => {
        expect(
            dnsPtrChanges([{ ip: '1.2.3.4', dns_ptr: 'a' }], [{ ip: '1.2.3.4', dnsPtr: null }]),
        ).toEqual([{ ip: '1.2.3.4', dnsPtr: null }]);
        expect(
            dnsPtrChanges([{ ip: '1.2.3.4', dns_ptr: null }], [{ ip: '1.2.3.4', dnsPtr: null }]),
        ).toEqual([]);
    });
});

describe('sameSet', () => {
    it('ignores order and handles absent lists', () => {
        expect(sameSet(['a', 'b'], ['b', 'a'])).toBe(true);
        expect(sameSet([], undefined)).toBe(true);
        expect(sameSet(undefined, undefined)).toBe(true);
        expect(sameSet(['a'], ['a', 'b'])).toBe(false);
        expect(sameSet([1, 2], [2, 1])).toBe(true);
    });
});

describe('deepEqual', () => {
    it('compares primitives, arrays and nested objects', () => {
        expect(deepEqual(1, 1)).toBe(true);
        expect(deepEqual('a', 'b')).toBe(false);
        expect(deepEqual([1, [2, 3]], [1, [2, 3]])).toBe(true);
        expect(deepEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true);
        expect(deepEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
    });

    it('treats an undefined-valued key as absent', () => {
        // The Hetzner API omits fields it has no value for; a spec that omits
        // them means the same thing, and must not read as a difference.
        expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
        expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
        expect(deepEqual({ a: 1, b: null }, { a: 1 })).toBe(false);
    });

    it('distinguishes arrays from objects and null from an object', () => {
        expect(deepEqual([1], { 0: 1 })).toBe(false);
        expect(deepEqual(null, {})).toBe(false);
        expect(deepEqual(null, null)).toBe(true);
        expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    });
});

describe('ChangeLog', () => {
    it('starts empty and records what happened', () => {
        const log = new ChangeLog();
        expect(log.changed).toBe(false);
        expect(log.changes).toEqual([]);

        log.record('powered on');
        log.record('enabled backups');

        expect(log.changed).toBe(true);
        expect(log.changes).toEqual(['powered on', 'enabled backups']);
    });

    it('hands out a copy, so a caller cannot corrupt it', () => {
        const log = new ChangeLog();
        log.record('a');
        log.changes.push('b');
        expect(log.changes).toEqual(['a']);
    });
});
