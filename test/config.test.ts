/**
 * Configuration is validated up front so a Pod crash-loops with a clear message
 * instead of running with a silently wrong resync period. Every rejection below
 * is a failure mode that would otherwise be discovered in production.
 */

import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/index.js';

// What a Pod always has: the token from a Secret and its own namespace from
// the downward API, which leader election needs to know where its Lease lives.
const minimal = { HETZNER_TOKEN: 'token', POD_NAMESPACE: 'operators' } as NodeJS.ProcessEnv;

describe('loadConfig', () => {
    it('refuses to start without a token, and says where to get one', () => {
        expect(() => loadConfig({})).toThrow(ConfigError);
        // CI greps the image's output for this exact phrase.
        expect(() => loadConfig({})).toThrow(/HETZNER_TOKEN is not set/);
        expect(() => loadConfig({})).toThrow(/hetzner.token or hetzner.existingSecret/);
    });

    it('treats a blank token as missing', () => {
        expect(() => loadConfig({ HETZNER_TOKEN: '   ' })).toThrow(/HETZNER_TOKEN is not set/);
    });

    it('fills in defaults that are safe for a single-replica install', () => {
        const config = loadConfig(minimal);

        expect(config).toMatchObject({
            hetznerToken: 'token',
            hetznerApiUrl: 'https://api.hetzner.cloud/v1',
            hetznerTimeoutMs: 30_000,
            resyncPeriodMs: 300_000,
            concurrency: 2,
            retryBaseDelayMs: 2_000,
            retryMaxDelayMs: 300_000,
            healthPort: 8080,
            leaderElectionEnabled: true,
            logLevel: 'info',
        });
        expect(config.namespace).toBeUndefined();
        expect(config.enabledKinds).toEqual([]);
    });

    it('stays under the Hetzner project limit by default', () => {
        // Hetzner allows 3600/hour; leaving headroom keeps the operator from
        // starving anything else using the same token.
        expect(loadConfig(minimal).hetznerRequestsPerHour).toBeLessThan(3_600);
    });

    it('reads a namespace and drops it when blank', () => {
        expect(loadConfig({ ...minimal, WATCH_NAMESPACE: 'prod' }).namespace).toBe('prod');
        expect(loadConfig({ ...minimal, WATCH_NAMESPACE: '  ' }).namespace).toBeUndefined();
    });

    it('parses a comma-separated kind list, ignoring blanks', () => {
        expect(
            loadConfig({ ...minimal, ENABLED_KINDS: 'HetznerServer, ,HetznerVolume ' })
                .enabledKinds,
        ).toEqual(['HetznerServer', 'HetznerVolume']);
    });

    it.each([
        ['RESYNC_PERIOD_MS', 'not-a-number', /must be a number/],
        ['RESYNC_PERIOD_MS', '500', /between 10000/],
        ['CONCURRENCY', '0', /between 1 and 64/],
        ['CONCURRENCY', '999', /between 1 and 64/],
        ['HEALTH_PORT', '70000', /between 1 and 65535/],
        ['HETZNER_REQUESTS_PER_HOUR', '10', /between 60 and 3600/],
        ['HETZNER_REQUESTS_PER_HOUR', '99999', /between 60 and 3600/],
    ])('rejects %s=%o', (name, value, expected) => {
        expect(() => loadConfig({ ...minimal, [name]: value })).toThrow(expected);
    });

    it('rejects a max retry delay below the base delay', () => {
        expect(() =>
            loadConfig({ ...minimal, RETRY_BASE_DELAY_MS: '10000', RETRY_MAX_DELAY_MS: '1000' }),
        ).toThrow(/must not be smaller than/);
    });

    it.each([
        ['true', true],
        ['TRUE', true],
        ['1', true],
        ['yes', true],
        ['on', true],
        ['false', false],
        ['0', false],
        ['no', false],
        ['off', false],
    ])('reads LEADER_ELECTION_ENABLED=%o as %s', (value, expected) => {
        expect(
            loadConfig({ ...minimal, LEADER_ELECTION_ENABLED: value }).leaderElectionEnabled,
        ).toBe(expected);
    });

    it('rejects a boolean it cannot understand', () => {
        expect(() => loadConfig({ ...minimal, LEADER_ELECTION_ENABLED: 'maybe' })).toThrow(
            /must be a boolean/,
        );
    });

    it('validates the log level and lists the valid ones', () => {
        expect(loadConfig({ ...minimal, LOG_LEVEL: 'DEBUG' }).logLevel).toBe('debug');
        expect(() => loadConfig({ ...minimal, LOG_LEVEL: 'chatty' })).toThrow(
            /debug, info, warn, error/,
        );
    });

    it('derives the leader identity and namespace from the Pod', () => {
        const config = loadConfig({
            ...minimal,
            POD_NAME: 'hcloud-operator-abc',
            POD_NAMESPACE: 'platform',
        });

        expect(config.leaderElectionIdentity).toBe('hcloud-operator-abc');
        expect(config.leaderElectionNamespace).toBe('platform');
    });

    it('falls back to a process-unique identity outside a Pod', () => {
        expect(loadConfig(minimal).leaderElectionIdentity).toMatch(/^local-\d+$/);
    });

    it('refuses leader election without a namespace, naming both ways to set one', () => {
        // A hardcoded fallback namespace would silently take a Lease in a
        // namespace that may not exist, or belong to another install.
        const env = { HETZNER_TOKEN: 'token' };

        expect(() => loadConfig(env)).toThrow(ConfigError);
        expect(() => loadConfig(env)).toThrow(/LEADER_ELECTION_NAMESPACE/);
        expect(() => loadConfig(env)).toThrow(/POD_NAMESPACE/);
        expect(() => loadConfig(env)).toThrow(/Helm chart/);
    });

    it('does not need a namespace when leader election is off', () => {
        const config = loadConfig({ HETZNER_TOKEN: 'token', LEADER_ELECTION_ENABLED: 'false' });

        expect(config.leaderElectionEnabled).toBe(false);
        expect(config.leaderElectionNamespace).toBe('');
    });

    it('treats a blank namespace as unset', () => {
        expect(() =>
            loadConfig({
                HETZNER_TOKEN: 'token',
                POD_NAMESPACE: ' ',
                LEADER_ELECTION_NAMESPACE: '',
            }),
        ).toThrow(/POD_NAMESPACE/);
    });

    it('lets an explicit override beat the downward-API values', () => {
        const config = loadConfig({
            ...minimal,
            POD_NAME: 'from-pod',
            LEADER_ELECTION_IDENTITY: 'explicit',
        });

        expect(config.leaderElectionIdentity).toBe('explicit');
        expect(
            loadConfig({ ...minimal, LEADER_ELECTION_NAMESPACE: 'leases' }).leaderElectionNamespace,
        ).toBe('leases');
    });
});

describe('the Hetzner API URL', () => {
    it('defaults to the real API over https', () => {
        expect(loadConfig(minimal).hetznerApiUrl).toBe('https://api.hetzner.cloud/v1');
    });

    it('accepts an https override', () => {
        expect(
            loadConfig({ ...minimal, HETZNER_API_URL: 'https://api.example.internal/v1' })
                .hetznerApiUrl,
        ).toBe('https://api.example.internal/v1');
    });

    it('refuses plain http, which would put the token on the wire in the clear', () => {
        expect(() =>
            loadConfig({ ...minimal, HETZNER_API_URL: 'http://api.hetzner.cloud/v1' }),
        ).toThrow(/must use https/);
    });

    it.each(['http://localhost:8080/v1', 'http://127.0.0.1:8080/v1', 'http://[::1]:8080/v1'])(
        'allows %s, for a local record/replay proxy',
        (url) => {
            expect(loadConfig({ ...minimal, HETZNER_API_URL: url }).hetznerApiUrl).toBe(url);
        },
    );

    it('rejects something that is not a URL at all', () => {
        expect(() => loadConfig({ ...minimal, HETZNER_API_URL: 'api.hetzner.cloud' })).toThrow(
            /absolute URL/,
        );
    });
});

describe('serializing the config', () => {
    it('redacts the token, so logging the config cannot leak it', () => {
        // Nothing logs the whole config today. This makes it safe when somebody
        // eventually does.
        const config = loadConfig({ ...minimal, HETZNER_TOKEN: 'super-secret-token' });

        expect(JSON.stringify(config)).not.toContain('super-secret-token');
        expect(JSON.stringify(config)).toContain('[redacted]');
    });

    it('still exposes the real token to the code that needs it', () => {
        expect(loadConfig({ ...minimal, HETZNER_TOKEN: 'super-secret-token' }).hetznerToken).toBe(
            'super-secret-token',
        );
    });

    it('keeps every other field visible when serialized', () => {
        const serialized = JSON.parse(JSON.stringify(loadConfig(minimal))) as Record<
            string,
            unknown
        >;

        expect(serialized.hetznerApiUrl).toBe('https://api.hetzner.cloud/v1');
        expect(serialized.concurrency).toBe(2);
    });
});
