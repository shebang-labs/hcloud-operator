/**
 * A minimal Prometheus-compatible metrics registry.
 *
 * Prometheus scrapes a plain text format; producing it is about eighty lines,
 * so we do not add a client library and its transitive dependencies to an
 * operator whose whole point is to be auditable.
 *
 * Only the two metric types an operator actually needs are implemented:
 * counters (monotonic totals) and histograms (latency distributions). Gauges
 * are expressed as callback-backed values, because everything gauge-like here
 * (queue depth, rate-limit headroom) is already tracked somewhere else and
 * should not be mirrored into a second source of truth.
 */

export type Labels = Record<string, string>;

/** Buckets in seconds, tuned for reconcile latency against a remote API. */
const DEFAULT_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

function escapeLabelValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

/** Renders `{a="1",b="2"}`, or an empty string when there are no labels. */
function renderLabels(labels: Labels): string {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) {
        return '';
    }
    const rendered = entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(',');
    return `{${rendered}}`;
}

/** Stable key for a label set, so series are looked up in O(1). */
function seriesKey(labels: Labels): string {
    return renderLabels(labels);
}

interface Metric {
    readonly name: string;
    readonly help: string;
    readonly type: 'counter' | 'histogram' | 'gauge';
    render(): string[];
}

export class Counter implements Metric {
    readonly type = 'counter' as const;
    private readonly series = new Map<string, { labels: Labels; value: number }>();

    constructor(
        readonly name: string,
        readonly help: string,
    ) {}

    inc(labels: Labels = {}, delta = 1): void {
        const key = seriesKey(labels);
        const existing = this.series.get(key);
        if (existing) {
            existing.value += delta;
            return;
        }
        this.series.set(key, { labels, value: delta });
    }

    /** Current value of one series. Exposed for tests and readiness checks. */
    get(labels: Labels = {}): number {
        return this.series.get(seriesKey(labels))?.value ?? 0;
    }

    render(): string[] {
        return [...this.series.values()].map(
            ({ labels, value }) => `${this.name}${renderLabels(labels)} ${value}`,
        );
    }
}

export class Histogram implements Metric {
    readonly type = 'histogram' as const;
    private readonly series = new Map<
        string,
        { labels: Labels; counts: number[]; sum: number; count: number }
    >();

    constructor(
        readonly name: string,
        readonly help: string,
        private readonly buckets: number[] = DEFAULT_BUCKETS,
    ) {}

    observe(value: number, labels: Labels = {}): void {
        const key = seriesKey(labels);
        let entry = this.series.get(key);
        if (!entry) {
            entry = { labels, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
            this.series.set(key, entry);
        }
        entry.sum += value;
        entry.count += 1;
        for (let index = 0; index < this.buckets.length; index += 1) {
            const bound = this.buckets[index];
            if (bound !== undefined && value <= bound) {
                // Prometheus histogram buckets are cumulative: a value in the
                // 0.1 bucket is also in every larger one.
                for (let cursor = index; cursor < entry.counts.length; cursor += 1) {
                    entry.counts[cursor] = (entry.counts[cursor] ?? 0) + 1;
                }
                break;
            }
        }
    }

    /** Times an async operation and records how long it took, in seconds. */
    async time<T>(labels: Labels, operation: () => Promise<T>): Promise<T> {
        const startedAt = process.hrtime.bigint();
        try {
            return await operation();
        } finally {
            const elapsedNs = Number(process.hrtime.bigint() - startedAt);
            this.observe(elapsedNs / 1_000_000_000, labels);
        }
    }

    render(): string[] {
        const lines: string[] = [];
        for (const { labels, counts, sum, count } of this.series.values()) {
            this.buckets.forEach((bound, index) => {
                lines.push(
                    `${this.name}_bucket${renderLabels({ ...labels, le: String(bound) })} ${counts[index] ?? 0}`,
                );
            });
            lines.push(`${this.name}_bucket${renderLabels({ ...labels, le: '+Inf' })} ${count}`);
            lines.push(`${this.name}_sum${renderLabels(labels)} ${sum}`);
            lines.push(`${this.name}_count${renderLabels(labels)} ${count}`);
        }
        return lines;
    }
}

/**
 * A gauge whose value is read from a callback at scrape time. This keeps
 * things like "how many keys are in the work queue" in exactly one place —
 * the queue — instead of duplicating the count into the metrics registry and
 * hoping the two stay in step.
 */
export class CallbackGauge implements Metric {
    readonly type = 'gauge' as const;
    private readonly sources: Array<{ labels: Labels; read: () => number }> = [];

    constructor(
        readonly name: string,
        readonly help: string,
    ) {}

    addSource(labels: Labels, read: () => number): void {
        this.sources.push({ labels, read });
    }

    render(): string[] {
        return this.sources.map(({ labels, read }) => {
            const value = read();
            return `${this.name}${renderLabels(labels)} ${Number.isFinite(value) ? value : 0}`;
        });
    }
}

export class MetricsRegistry {
    private readonly metrics: Metric[] = [];

    counter(name: string, help: string): Counter {
        return this.register(new Counter(name, help));
    }

    histogram(name: string, help: string, buckets?: number[]): Histogram {
        return this.register(new Histogram(name, help, buckets));
    }

    gauge(name: string, help: string): CallbackGauge {
        return this.register(new CallbackGauge(name, help));
    }

    private register<T extends Metric>(metric: T): T {
        this.metrics.push(metric);
        return metric;
    }

    /** Renders the whole registry in the Prometheus text exposition format. */
    render(): string {
        const lines: string[] = [];
        for (const metric of this.metrics) {
            const series = metric.render();
            if (series.length === 0) {
                // A metric with no observations yet: emitting HELP/TYPE without
                // samples is valid but noisy, so skip it entirely.
                continue;
            }
            lines.push(`# HELP ${metric.name} ${metric.help}`);
            lines.push(`# TYPE ${metric.name} ${metric.type}`);
            lines.push(...series);
        }
        return `${lines.join('\n')}\n`;
    }
}

/**
 * Every metric the operator exposes, created once and passed around. Grouping
 * them in one object means `grep OperatorMetrics` answers "what can I alert
 * on?" without reading the whole codebase.
 */
export interface OperatorMetrics {
    readonly registry: MetricsRegistry;
    /** Reconcile attempts, labelled by kind and outcome (success/failure/skipped). */
    readonly reconcileTotal: Counter;
    /** Reconcile wall-clock duration in seconds, labelled by kind. */
    readonly reconcileDuration: Histogram;
    /** Hetzner API requests, labelled by method, path template and status class. */
    readonly apiRequestTotal: Counter;
    /** Hetzner API request duration in seconds. */
    readonly apiRequestDuration: Histogram;
    /** Hetzner actions waited on, labelled by command and outcome. */
    readonly actionTotal: Counter;
    /** Work queue depth, read from the queues themselves at scrape time. */
    readonly queueDepth: CallbackGauge;
    /** Remaining requests in the current Hetzner rate-limit window. */
    readonly rateLimitRemaining: CallbackGauge;
    /** 1 when this replica holds the leader lease, 0 otherwise. */
    readonly leaderStatus: CallbackGauge;
}

export function createMetrics(): OperatorMetrics {
    const registry = new MetricsRegistry();
    return {
        registry,
        reconcileTotal: registry.counter(
            'hcloud_operator_reconcile_total',
            'Total reconcile attempts by kind and outcome.',
        ),
        reconcileDuration: registry.histogram(
            'hcloud_operator_reconcile_duration_seconds',
            'Reconcile duration in seconds by kind.',
        ),
        apiRequestTotal: registry.counter(
            'hcloud_operator_api_request_total',
            'Hetzner Cloud API requests by method, route and status class.',
        ),
        apiRequestDuration: registry.histogram(
            'hcloud_operator_api_request_duration_seconds',
            'Hetzner Cloud API request duration in seconds.',
        ),
        actionTotal: registry.counter(
            'hcloud_operator_action_total',
            'Hetzner Cloud actions awaited, by command and outcome.',
        ),
        queueDepth: registry.gauge(
            'hcloud_operator_queue_depth',
            'Number of resource keys waiting in a work queue.',
        ),
        rateLimitRemaining: registry.gauge(
            'hcloud_operator_rate_limit_remaining',
            'Requests left in the current Hetzner Cloud rate-limit window.',
        ),
        leaderStatus: registry.gauge(
            'hcloud_operator_leader',
            'Whether this replica currently holds the leader lease.',
        ),
    };
}
