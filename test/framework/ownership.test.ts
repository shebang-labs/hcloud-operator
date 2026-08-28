/**
 * Ownership is what lets the operator recover from a crash without leaking paid
 * infrastructure, so the label helpers are worth pinning down precisely — in
 * particular that a user-supplied label can never displace one of ours.
 */

import { describe, expect, it } from 'vitest';
import {
    buildLabels,
    buildOwnerLabels,
    hetznerResourceName,
    isOwnedBy,
    isOwnedByAnother,
    isUnowned,
    labelsMatch,
    ownerSelector,
    sanitizeLabelValue,
} from '../../src/framework/ownership.js';
import { MANAGED_BY_VALUE, OwnerLabel } from '../../src/kube/api.js';
import { buildResource } from '../support/fake-store.js';

const resource = buildResource(
    'HetznerServer',
    {},
    { name: 'web-01', namespace: 'demo', uid: 'abc-123' },
);

describe('buildOwnerLabels', () => {
    it('records the kind, uid, namespace and name', () => {
        expect(buildOwnerLabels(resource, 'HetznerServer')).toEqual({
            [OwnerLabel.ManagedBy]: MANAGED_BY_VALUE,
            [OwnerLabel.Uid]: 'abc-123',
            [OwnerLabel.Namespace]: 'demo',
            [OwnerLabel.Name]: 'web-01',
            [OwnerLabel.Kind]: 'HetznerServer',
        });
    });
});

describe('buildLabels', () => {
    it('merges spec.labels underneath the ownership labels', () => {
        const withLabels = buildResource(
            'HetznerServer',
            { labels: { role: 'web' } },
            { uid: 'abc-123', name: 'web-01', namespace: 'demo' },
        );

        expect(buildLabels(withLabels, 'HetznerServer')).toMatchObject({
            role: 'web',
            [OwnerLabel.Uid]: 'abc-123',
        });
    });

    it('does not let a user label displace an ownership label', () => {
        const hostile = buildResource(
            'HetznerServer',
            { labels: { [OwnerLabel.Uid]: 'someone-elses-uid' } },
            { uid: 'abc-123' },
        );

        expect(buildLabels(hostile, 'HetznerServer')[OwnerLabel.Uid]).toBe('abc-123');
    });
});

describe('sanitizeLabelValue', () => {
    it.each([
        ['demo', 'demo'],
        ['has spaces', 'has-spaces'],
        ['-leading-and-trailing-', 'leading-and-trailing'],
        ['emoji🎉here', 'emoji-here'],
        ['a'.repeat(80), 'a'.repeat(63)],
    ])('turns %o into %o', (input, expected) => {
        expect(sanitizeLabelValue(input)).toBe(expected);
    });
});

describe('ownerSelector', () => {
    it('renders the Hetzner label selector for a uid', () => {
        expect(ownerSelector('abc-123')).toBe(`${OwnerLabel.Uid}=abc-123`);
    });
});

describe('ownership predicates', () => {
    const mine = { id: 1, labels: { [OwnerLabel.Uid]: 'abc-123' } };
    const theirs = { id: 2, labels: { [OwnerLabel.Uid]: 'xyz-789' } };
    const nobodys = { id: 3, labels: {} };

    it('recognises its own resource', () => {
        expect(isOwnedBy(mine, 'abc-123')).toBe(true);
        expect(isOwnedBy(theirs, 'abc-123')).toBe(false);
    });

    it('recognises somebody else’s resource', () => {
        expect(isOwnedByAnother(theirs, 'abc-123')).toBe(true);
        expect(isOwnedByAnother(mine, 'abc-123')).toBe(false);
        // Unowned is not "somebody else's": it is free to adopt.
        expect(isOwnedByAnother(nobodys, 'abc-123')).toBe(false);
    });

    it('recognises an unowned resource', () => {
        expect(isUnowned(nobodys)).toBe(true);
        expect(isUnowned(mine)).toBe(false);
    });
});

describe('hetznerResourceName', () => {
    it.each([
        ['default', 'web', 'default-web'],
        ['Demo', 'Web-01', 'demo-web-01'],
        ['ns', 'name_with_underscores', 'ns-name-with-underscores'],
        ['ns', '.leading.dot.', 'ns-.leading.dot'],
    ])('turns %o/%o into %o', (namespace, name, expected) => {
        expect(hetznerResourceName(namespace, name)).toBe(expected);
    });

    it('truncates to the Hetzner limit without leaving a trailing separator', () => {
        const result = hetznerResourceName('a'.repeat(40), `${'b'.repeat(30)}-`);
        expect(result.length).toBeLessThanOrEqual(63);
        expect(result).not.toMatch(/[.-]$/);
    });

    it('keeps two long names distinct after truncation', () => {
        // Hetzner names are unique per project, so a collision would make the
        // second object fail its create with uniqueness_error forever — and the
        // adopt-our-own-orphan recovery cannot help, because the existing
        // resource belongs to a different owner uid.
        const namespace = 'a-very-long-namespace-name-used-only-for-testing';
        const first = hetznerResourceName(namespace, 'web-server-deployment-one');
        const second = hetznerResourceName(namespace, 'web-server-deployment-two');

        expect(first).not.toBe(second);
        expect(first.length).toBeLessThanOrEqual(63);
        expect(second.length).toBeLessThanOrEqual(63);
    });

    it('is deterministic, so a restart derives the same name', () => {
        const namespace = 'a-very-long-namespace-name-used-only-for-testing';
        expect(hetznerResourceName(namespace, 'web')).toBe(hetznerResourceName(namespace, 'web'));
    });

    it('leaves a name that already fits completely alone', () => {
        // No digest suffix on the common path: the name stays readable.
        expect(hetznerResourceName('demo', 'web-01')).toBe('demo-web-01');
    });
});

describe('labelsMatch', () => {
    it('is true only for an exact match', () => {
        expect(labelsMatch({ a: '1' }, { a: '1' })).toBe(true);
        expect(labelsMatch({ a: '1' }, { a: '2' })).toBe(false);
        expect(labelsMatch({ a: '1', b: '2' }, { a: '1' })).toBe(false);
        expect(labelsMatch({ a: '1' }, { a: '1', b: '2' })).toBe(false);
        expect(labelsMatch(undefined, {})).toBe(true);
    });
});
