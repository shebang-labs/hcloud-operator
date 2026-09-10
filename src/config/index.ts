/**
 * All configuration comes from environment variables.
 *
 * The Hetzner API token is the only secret. It is injected by Kubernetes from a
 * Secret (see config/secret.example.yaml) and must never be hardcoded or logged.
 *
 * Everything is validated up front and the process refuses to start on bad
 * input. An operator that boots with a silently-wrong resync period is far
 * worse than one that crash-loops with a clear message in its logs.
 */

import { LOG_LEVELS, type LogLevel } from '../observability/logger.js';

export interface OperatorConfig {
    /** Hetzner Cloud API token, read from HETZNER_TOKEN. */
    readonly hetznerToken: string;
    /** Base URL of the Hetzner Cloud API. Overridable so tests can point elsewhere. */
    readonly hetznerApiUrl: string;
    /** Per-request timeout against the Hetzner API. */
    readonly hetznerTimeoutMs: number;
    /**
     * Sustained request budget against the Hetzner API, in requests per hour.
     * Hetzner's own project limit is 3600/h; staying under it keeps the operator
     * from starving anything else that uses the same token.
     */
    readonly hetznerRequestsPerHour: number;
    /** Watch a single namespace, or all namespaces when undefined. */
    readonly namespace?: string;
    /** Kinds to reconcile. Empty means "all registered kinds". */
    readonly enabledKinds: readonly string[];
    /** How often every known resource is reconciled again, even without events. */
    readonly resyncPeriodMs: number;
    /** How many resources may be reconciled at the same time, per kind. */
    readonly concurrency: number;
    /** First retry delay after a failed reconcile. */
    readonly retryBaseDelayMs: number;
    /** Upper bound for the exponential retry delay. */
    readonly retryMaxDelayMs: number;
    /** How long to wait for a Hetzner action to reach a terminal state. */
    readonly actionTimeoutMs: number;
    /** Port for /healthz, /readyz and /metrics. */
    readonly healthPort: number;
    /**
     * Serve a validating admission webhook, so a bad spec is rejected at
     * `kubectl apply` time. Off by default: it needs a TLS certificate and a
     * ValidatingWebhookConfiguration (see config/webhook/).
     */
    readonly webhookEnabled: boolean;
    readonly webhookPort: number;
    readonly webhookCertFile: string;
    readonly webhookKeyFile: string;
    /** Whether to contend for a leader lease before reconciling anything. */
    readonly leaderElectionEnabled: boolean;
    /** Name of the Lease object used for leader election. */
    readonly leaderElectionLeaseName: string;
    /**
     * Namespace holding the Lease: LEADER_ELECTION_NAMESPACE, or the operator's
     * own namespace from POD_NAMESPACE. Empty only when leader election is
     * disabled, in which case nothing reads it.
     */
    readonly leaderElectionNamespace: string;
    /** How long a lease stays valid without a renewal. */
    readonly leaderElectionLeaseDurationMs: number;
    /** Identity recorded in the Lease. Defaults to the Pod name. */
    readonly leaderElectionIdentity: string;
    readonly logLevel: LogLevel;
    /**
     * Redacts the token when the config is serialized.
     *
     * Nothing logs the whole config today, and nothing should. But the object
     * is passed around, the logger serializes whatever it is given, and
     * `logger.info('config', { config })` is a one-line mistake somebody will
     * eventually make. This makes that mistake harmless instead of a leaked
     * project-wide credential.
     */
    toJSON(): Record<string, unknown>;
}

class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConfigError';
    }
}

interface NumberOptions {
    min?: number;
    max?: number;
}

function readNumber(
    env: NodeJS.ProcessEnv,
    name: string,
    fallback: number,
    { min = 1, max = Number.MAX_SAFE_INTEGER }: NumberOptions = {},
): number {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        throw new ConfigError(`${name} must be a number, got "${raw}"`);
    }
    if (parsed < min || parsed > max) {
        throw new ConfigError(`${name} must be between ${min} and ${max}, got ${parsed}`);
    }
    return parsed;
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
    const raw = env[name]?.trim().toLowerCase();
    if (raw === undefined || raw === '') {
        return fallback;
    }
    if (['1', 'true', 'yes', 'on'].includes(raw)) {
        return true;
    }
    if (['0', 'false', 'no', 'off'].includes(raw)) {
        return false;
    }
    throw new ConfigError(`${name} must be a boolean ("true"/"false"), got "${raw}"`);
}

function readLogLevel(env: NodeJS.ProcessEnv): LogLevel {
    const raw = (env.LOG_LEVEL ?? 'info').trim().toLowerCase() as LogLevel;
    if (!LOG_LEVELS.includes(raw)) {
        throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${raw}"`);
    }
    return raw;
}

/**
 * Validates the Hetzner API base URL.
 *
 * The token is a bearer credential for the entire Hetzner project and is sent
 * on every request, so plaintext HTTP would put it on the wire in the clear.
 * Loopback is allowed because a local record/replay proxy is a legitimate
 * development setup and never leaves the host.
 */
function readApiUrl(env: NodeJS.ProcessEnv): string {
    const raw = env.HETZNER_API_URL?.trim() || 'https://api.hetzner.cloud/v1';

    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new ConfigError(`HETZNER_API_URL must be an absolute URL, got "${raw}"`);
    }

    const isLoopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
        throw new ConfigError(
            `HETZNER_API_URL must use https (got "${parsed.protocol}//"): the Hetzner token is ` +
                'sent as a bearer credential on every request and must never travel in plaintext. ' +
                'Plain http is permitted only for a loopback address.',
        );
    }

    return raw;
}

/** Parses a comma-separated list, dropping blanks. */
function readList(env: NodeJS.ProcessEnv, name: string): string[] {
    return (env[name] ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

/**
 * Reads and validates the configuration. Throws on invalid input so the Pod
 * fails fast and visibly instead of running in a broken state.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): OperatorConfig {
    const hetznerToken = env.HETZNER_TOKEN?.trim();
    if (!hetznerToken) {
        // CI greps the image's output for "HETZNER_TOKEN is not set"; keep it.
        throw new ConfigError(
            'HETZNER_TOKEN is not set. Provide it from a Kubernetes Secret (the Helm chart does ' +
                'this from hetzner.token or hetzner.existingSecret).',
        );
    }

    const namespace = env.WATCH_NAMESPACE?.trim();

    const webhookEnabled = readBoolean(env, 'WEBHOOK_ENABLED', false);
    const webhookCertFile = env.WEBHOOK_CERT_FILE?.trim() || '/etc/webhook/certs/tls.crt';
    const webhookKeyFile = env.WEBHOOK_KEY_FILE?.trim() || '/etc/webhook/certs/tls.key';

    // A Lease has to live somewhere real. A hardcoded fallback namespace would
    // silently contend for a Lease in a namespace that may not exist or may
    // belong to another install, and the failure shows up as RBAC errors long
    // after start-up instead of a clear message now.
    const leaderElectionEnabled = readBoolean(env, 'LEADER_ELECTION_ENABLED', true);
    const leaderElectionNamespace =
        env.LEADER_ELECTION_NAMESPACE?.trim() || env.POD_NAMESPACE?.trim() || '';
    if (leaderElectionEnabled && !leaderElectionNamespace) {
        throw new ConfigError(
            'LEADER_ELECTION_ENABLED is true but neither LEADER_ELECTION_NAMESPACE nor ' +
                'POD_NAMESPACE is set, so the operator does not know where to keep its Lease. ' +
                'The Helm chart sets POD_NAMESPACE automatically; set one of them when running ' +
                'elsewhere, or set LEADER_ELECTION_ENABLED=false for a single local process.',
        );
    }

    const retryBaseDelayMs = readNumber(env, 'RETRY_BASE_DELAY_MS', 2_000);
    const retryMaxDelayMs = readNumber(env, 'RETRY_MAX_DELAY_MS', 5 * 60 * 1000);
    if (retryMaxDelayMs < retryBaseDelayMs) {
        throw new ConfigError(
            `RETRY_MAX_DELAY_MS (${retryMaxDelayMs}) must not be smaller than RETRY_BASE_DELAY_MS (${retryBaseDelayMs})`,
        );
    }

    const config: Omit<OperatorConfig, 'toJSON'> = {
        hetznerToken,
        hetznerApiUrl: readApiUrl(env),
        hetznerTimeoutMs: readNumber(env, 'HETZNER_TIMEOUT_MS', 30_000),
        hetznerRequestsPerHour: readNumber(env, 'HETZNER_REQUESTS_PER_HOUR', 3_000, {
            min: 60,
            max: 3_600,
        }),
        ...(namespace ? { namespace } : {}),
        enabledKinds: readList(env, 'ENABLED_KINDS'),
        resyncPeriodMs: readNumber(env, 'RESYNC_PERIOD_MS', 5 * 60 * 1000, { min: 10_000 }),
        concurrency: readNumber(env, 'CONCURRENCY', 2, { min: 1, max: 64 }),
        retryBaseDelayMs,
        retryMaxDelayMs,
        actionTimeoutMs: readNumber(env, 'ACTION_TIMEOUT_MS', 10 * 60 * 1000, { min: 1_000 }),
        healthPort: readNumber(env, 'HEALTH_PORT', 8080, { min: 1, max: 65_535 }),
        webhookEnabled,
        webhookPort: readNumber(env, 'WEBHOOK_PORT', 9443, { min: 1, max: 65_535 }),
        webhookCertFile,
        webhookKeyFile,
        leaderElectionEnabled,
        leaderElectionLeaseName: env.LEADER_ELECTION_LEASE_NAME?.trim() || 'hcloud-operator',
        leaderElectionNamespace,
        leaderElectionLeaseDurationMs: readNumber(
            env,
            'LEADER_ELECTION_LEASE_DURATION_MS',
            15_000,
            {
                min: 2_000,
            },
        ),
        leaderElectionIdentity:
            env.LEADER_ELECTION_IDENTITY?.trim() || env.POD_NAME?.trim() || `local-${process.pid}`,
        logLevel: readLogLevel(env),
    };

    return {
        ...config,
        toJSON: () => ({ ...config, hetznerToken: '[redacted]' }),
    };
}

export { ConfigError };
