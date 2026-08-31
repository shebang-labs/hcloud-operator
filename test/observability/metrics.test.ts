/**
 * The metrics registry is hand-rolled, so the Prometheus text format it emits
 * is worth checking directly — a malformed exposition breaks a scrape silently.
 */

import { describe, expect, it } from 'vitest';
import { createMetrics, MetricsRegistry } from '../../src/observability/metrics.js';

describe('Counter', () => {
    it('accumulates per label set', () => {
        const registry = new MetricsRegistry();
        const counter = registry.counter('reconciles_total', 'help');

        counter.inc({ kind: 'HetznerServer' });
        counter.inc({ kind: 'HetznerServer' });
        counter.inc({ kind: 'HetznerVolume' }, 5);

        expect(counter.get({ kind: 'HetznerServer' })).toBe(2);
        expect(counter.get({ kind: 'HetznerVolume' })).toBe(5);
        expect(counter.get({ kind: 'Nothing' })).toBe(0);
    });

    it('treats label order as irrelevant', () => {
        const counter = new MetricsRegistry().counter('c', 'help');

        counter.inc({ a: '1', b: '2' });
        counter.inc({ b: '2', a: '1' });

        expect(counter.get({ a: '1', b: '2' })).toBe(2);
    });

    it('renders HELP, TYPE and one line per series', () => {
        const registry = new MetricsRegistry();
        const counter = registry.counter('reconciles_total', 'Total reconciles.');
        counter.inc({ kind: 'HetznerServer' }, 3);

        expect(registry.render()).toBe(
            '# HELP reconciles_total Total reconciles.\n' +
                '# TYPE reconciles_total counter\n' +
                'reconciles_total{kind="HetznerServer"} 3\n',
        );
    });

    it('escapes characters that would break the format', () => {
        const registry = new MetricsRegistry();
        registry.counter('c', 'help').inc({ message: 'a "quote"\nand a newline' });

        expect(registry.render()).toContain('message="a \\"quote\\"\\nand a newline"');
    });
});

describe('Histogram', () => {
    it('produces cumulative buckets, a sum and a count', () => {
        const registry = new MetricsRegistry();
        const histogram = registry.histogram('duration_seconds', 'help', [0.1, 1, 10]);

        histogram.observe(0.05);
        histogram.observe(0.5);
        histogram.observe(5);

        const output = registry.render();
        expect(output).toContain('duration_seconds_bucket{le="0.1"} 1');
        expect(output).toContain('duration_seconds_bucket{le="1"} 2');
        expect(output).toContain('duration_seconds_bucket{le="10"} 3');
        expect(output).toContain('duration_seconds_bucket{le="+Inf"} 3');
        expect(output).toContain('duration_seconds_count 3');
        expect(output).toContain('duration_seconds_sum 5.55');
    });

    it('counts an observation beyond the last bucket in +Inf only', () => {
        const registry = new MetricsRegistry();
        registry.histogram('d', 'help', [1]).observe(99);

        const output = registry.render();
        expect(output).toContain('d_bucket{le="1"} 0');
        expect(output).toContain('d_bucket{le="+Inf"} 1');
    });

    it('times an operation and still returns its value', async () => {
        const registry = new MetricsRegistry();
        const histogram = registry.histogram('d', 'help');

        const result = await histogram.time({ kind: 'X' }, async () => 'value');

        expect(result).toBe('value');
        expect(registry.render()).toContain('d_count{kind="X"} 1');
    });

    it('records the duration even when the operation throws', async () => {
        const registry = new MetricsRegistry();
        const histogram = registry.histogram('d', 'help');

        await expect(
            histogram.time({}, async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');

        expect(registry.render()).toContain('d_count 1');
    });
});

describe('CallbackGauge', () => {
    it('reads its value at scrape time, not at registration', () => {
        const registry = new MetricsRegistry();
        const gauge = registry.gauge('queue_depth', 'help');
        let depth = 0;
        gauge.addSource({ kind: 'HetznerServer' }, () => depth);

        expect(registry.render()).toContain('queue_depth{kind="HetznerServer"} 0');
        depth = 7;
        expect(registry.render()).toContain('queue_depth{kind="HetznerServer"} 7');
    });

    it('reports a non-finite reading as zero rather than breaking the scrape', () => {
        const registry = new MetricsRegistry();
        registry.gauge('g', 'help').addSource({}, () => Number.NaN);

        expect(registry.render()).toContain('g 0');
    });
});

describe('MetricsRegistry', () => {
    it('omits metrics that have no observations yet', () => {
        const registry = new MetricsRegistry();
        registry.counter('never_used', 'help');

        expect(registry.render()).toBe('\n');
    });
});

describe('createMetrics', () => {
    it('exposes every series the deployment alerts on', () => {
        const metrics = createMetrics();

        metrics.reconcileTotal.inc({ kind: 'HetznerServer', outcome: 'success' });
        metrics.reconcileDuration.observe(0.5, { kind: 'HetznerServer' });
        metrics.apiRequestTotal.inc({ method: 'GET', route: '/servers', status: '2xx' });
        metrics.apiRequestDuration.observe(0.1, { method: 'GET', route: '/servers' });
        metrics.actionTotal.inc({ command: 'poweron', outcome: 'success' });
        metrics.queueDepth.addSource({ kind: 'HetznerServer' }, () => 3);
        metrics.rateLimitRemaining.addSource({}, () => 2_900);
        metrics.leaderStatus.addSource({}, () => 1);

        const output = metrics.registry.render();
        for (const name of [
            'hcloud_operator_reconcile_total',
            'hcloud_operator_reconcile_duration_seconds',
            'hcloud_operator_api_request_total',
            'hcloud_operator_api_request_duration_seconds',
            'hcloud_operator_action_total',
            'hcloud_operator_queue_depth',
            'hcloud_operator_rate_limit_remaining',
            'hcloud_operator_leader',
        ]) {
            expect(output).toContain(`# TYPE ${name}`);
        }
    });
});
