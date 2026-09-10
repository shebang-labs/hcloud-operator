/**
 * Repository-level consistency.
 *
 * These are the details that are individually trivial and collectively decide
 * whether a public repository looks maintained: a version that matches its
 * changelog, links that resolve, and the files a contributor looks for before
 * opening an issue.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const packageJson = JSON.parse(read('package.json')) as {
    name: string;
    version: string;
    repository: { url: string };
    homepage: string;
    bugs: { url: string };
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
};

describe('the files a public repository needs', () => {
    it.each([
        'README.md',
        'LICENSE',
        'SECURITY.md',
        'CONTRIBUTING.md',
        'CODE_OF_CONDUCT.md',
        'CHANGELOG.md',
        '.github/PULL_REQUEST_TEMPLATE.md',
        '.github/dependabot.yml',
        '.github/ISSUE_TEMPLATE/bug_report.yml',
        '.github/ISSUE_TEMPLATE/feature_request.yml',
        '.github/CODEOWNERS',
        '.github/workflows/ci.yaml',
        '.github/workflows/release.yaml',
        'charts/hetzner-server-controller/Chart.yaml',
        'charts/hetzner-server-controller/values.yaml',
        'charts/hetzner-server-controller/values.schema.json',
        'charts/hetzner-server-controller/README.md',
        'docs/architecture.md',
        'docs/operations.md',
        'docs/adoption.md',
        'docs/relationships.md',
        'docs/webhook.md',
        'docs/releasing.md',
        'docs/docker-hub.md',
    ])('%s exists', (path) => {
        expect(existsSync(join(root, path))).toBe(true);
    });
});

describe('naming consistency', () => {
    it('uses one repository name everywhere', () => {
        // A stale repository name means every link in the docs 404s.
        for (const path of [
            'package.json',
            'Dockerfile',
            'README.md',
            'SECURITY.md',
            'CONTRIBUTING.md',
            'CHANGELOG.md',
            'charts/hetzner-server-controller/Chart.yaml',
        ]) {
            const text = read(path);
            if (text.includes('github.com/shebang-labs/')) {
                expect(text, path).toContain('shebang-labs/hetzner-server-controller');
            }
        }
    });

    it('deploys the image the release workflow publishes', () => {
        // A chart pointing at a repository nothing pushes to is an
        // ImagePullBackOff for the first person who installs it.
        const release = load(read('.github/workflows/release.yaml')) as {
            env: Record<string, string>;
        };
        const values = load(read('charts/hetzner-server-controller/values.yaml')) as {
            image: { repository: string; tag: string };
        };
        expect(values.image.repository).toBe(release.env.IMAGE);
        // An empty tag means "the chart's appVersion", which the release
        // workflow verifies against the tag before publishing anything.
        expect(values.image.tag).toBe('');
    });
});

describe('the Node.js version', () => {
    it('is stated once and agrees everywhere it is repeated', () => {
        // engines, the Dockerfile base image, CI and .nvmrc all name a Node
        // major. Dependabot deliberately does not bump the Dockerfile's, so
        // nothing else would notice if they drifted apart.
        const nvmrc = read('.nvmrc').trim();
        const dockerfile = read('Dockerfile').match(/^FROM node:(\d+)/m)?.[1];
        const ci = read('.github/workflows/ci.yaml');

        expect(dockerfile).toBe(nvmrc);
        expect(ci).toContain('node-version-file: .nvmrc');
        const minimum = Number(
            (packageJson as { engines: { node: string } }).engines.node.replace(/[^0-9.]/g, ''),
        );
        expect(Number(nvmrc)).toBeGreaterThanOrEqual(minimum);
    });
});

describe('versioning', () => {
    const chart = load(read('charts/hetzner-server-controller/Chart.yaml')) as {
        version: string;
        appVersion: string;
        annotations: Record<string, string>;
    };

    it('has a changelog entry for the current version', () => {
        expect(read('CHANGELOG.md')).toContain(`## [${packageJson.version}]`);
    });

    it('versions the chart together with the application', () => {
        // One number for users: chart 1.2.3 always ships image 1.2.3. The
        // release workflow refuses to publish when these disagree with the tag.
        expect(chart.version).toBe(packageJson.version);
        expect(chart.appVersion).toBe(packageJson.version);
        expect(chart.annotations['artifacthub.io/images']).toContain(`:${packageJson.version}`);
    });
});

describe('the npm manifest', () => {
    it('exposes the scripts CI and CONTRIBUTING tell people to run', () => {
        for (const script of ['build', 'test', 'lint', 'typecheck', 'verify']) {
            expect(packageJson.scripts[script], script).toBeDefined();
        }
    });

    it('depends on nothing at runtime beyond the Kubernetes and HTTP clients', () => {
        // Every runtime dependency is attack surface in the shipped image and
        // something to audit on every release.
        expect(Object.keys(packageJson.dependencies).sort()).toEqual([
            '@kubernetes/client-node',
            'axios',
        ]);
    });
});

interface Workflow {
    permissions?: Record<string, string>;
    jobs: Record<string, { steps?: Array<{ uses?: string; run?: string }>; permissions?: unknown }>;
}

const WORKFLOWS = ['.github/workflows/ci.yaml', '.github/workflows/release.yaml'];

describe('CI', () => {
    const workflow = load(read('.github/workflows/ci.yaml')) as Workflow;

    it.each(WORKFLOWS)('%s defaults to a read-only token', (path) => {
        expect((load(read(path)) as Workflow).permissions).toEqual({ contents: 'read' });
    });

    it.each(WORKFLOWS)('%s pins every action by commit, not by a movable tag', (path) => {
        // An action runs with this workflow's token; a tag can be repointed at
        // any time by whoever owns it. That includes GitHub's own actions.
        for (const [name, job] of Object.entries((load(read(path)) as Workflow).jobs)) {
            for (const step of job.steps ?? []) {
                if (step.uses) {
                    expect(step.uses, `${name}: ${step.uses}`).toMatch(/@[0-9a-f]{40}$/);
                }
            }
        }
        // The human-readable version rides along as a comment, so Dependabot
        // can bump the SHA and a reviewer can still tell what it is.
        for (const line of read(path).split('\n')) {
            if (/^\s*-?\s*uses:/.test(line)) {
                expect(line.trim()).toMatch(/ # v\d/);
            }
        }
    });

    it('runs lint, typecheck, tests and a dependency audit', () => {
        const commands = Object.values(workflow.jobs)
            .flatMap((job) => job.steps ?? [])
            .map((step) => step.run ?? '')
            .join('\n');

        expect(commands).toContain('npm run lint');
        expect(commands).toContain('npm run typecheck');
        expect(commands).toContain('npm audit --omit=dev');
    });

    it('publishes to exactly one registry', () => {
        // Two registries publishing the same image means two things to keep in
        // step and two places for a deployment to point at.
        for (const path of WORKFLOWS) {
            const text = read(path);
            expect(text, path).not.toMatch(/ghcr\.io/);
            expect(text, path).not.toMatch(/quay\.io/);
        }
    });

    it('takes the registry credentials from secrets, never from a literal', () => {
        for (const path of WORKFLOWS) {
            const text = read(path);
            expect(text, path).toContain('secrets.DOCKERHUB_USERNAME');
            expect(text, path).toContain('secrets.DOCKERHUB_TOKEN');
            expect(text, path).not.toMatch(/docker login .*(-p|--password) /);
        }
    });

    it('checks that every version number agrees before a release publishes anything', () => {
        const text = read('.github/workflows/release.yaml');
        expect(text).toContain('package.json');
        expect(text).toContain('Chart.yaml');
        expect(text).toContain('CHANGELOG.md');
    });

    it('installs the chart on a real cluster before merging', () => {
        const text = read('.github/workflows/ci.yaml');
        expect(text).toContain('helm install');
        expect(text).toContain('helm test');
        expect(text).toContain('--dry-run=server');
    });
});

describe('Dependabot', () => {
    const config = load(read('.github/dependabot.yml')) as {
        updates: Array<{
            'package-ecosystem': string;
            'open-pull-requests-limit'?: number;
            groups?: Record<string, unknown>;
        }>;
    };

    it('covers npm, the actions and the base image', () => {
        expect(config.updates.map((u) => u['package-ecosystem']).sort()).toEqual([
            'docker',
            'github-actions',
            'npm',
        ]);
    });

    it('groups updates and caps how many pull requests it can open', () => {
        // Ungrouped, this opened nine PRs on day one — including one that bumped
        // @vitest/coverage-v8 to 5 while leaving vitest at 3, a combination that
        // cannot install. A bot that floods the queue with broken PRs trains
        // people to ignore it.
        const total = config.updates.reduce(
            (sum, u) => sum + (u['open-pull-requests-limit'] ?? 5),
            0,
        );
        expect(total).toBeLessThanOrEqual(5);

        for (const update of config.updates) {
            if (update['package-ecosystem'] === 'docker') {
                continue; // A single image; nothing to group it with.
            }
            expect(
                Object.keys(update.groups ?? {}).length,
                update['package-ecosystem'],
            ).toBeGreaterThan(0);
        }
    });
});

describe('supply-chain hardening', () => {
    it('never installs with lifecycle scripts enabled', () => {
        // A compromised package's preinstall/postinstall hook is the usual way a
        // supply-chain attack gets code execution, and it runs before any test
        // could notice. Nothing in this tree needs one.
        const workflow = read('.github/workflows/ci.yaml');
        const dockerfile = read('Dockerfile');

        for (const [name, text] of [
            ['workflow', workflow],
            ['Dockerfile', dockerfile],
        ] as const) {
            const installs = text
                .split('\n')
                .map((line) => line.trim())
                // Real invocations only: a comment mentioning `npm ci` is prose.
                .filter((line) => !line.startsWith('#'))
                .filter((line) => /^(RUN|run:)\s+npm ci\b/.test(line));
            expect(installs.length, `${name} has no npm ci`).toBeGreaterThan(0);
            for (const line of installs) {
                expect(line, `${name}: ${line.trim()}`).toContain('--ignore-scripts');
            }
        }
    });

    it('never uses pull_request_target, which would expose write credentials', () => {
        // pull_request_target runs with the base repository's token and secrets
        // against the *pull request's* code. On a Dependabot or fork PR that is
        // a direct path from an untrusted dependency to a write token.
        for (const path of WORKFLOWS) {
            expect(read(path), path).not.toContain('pull_request_target');
        }
    });

    it('blocks a pull request that adds a dependency with a known advisory', () => {
        const text = read('.github/workflows/ci.yaml');
        expect(text).toContain('dependency-review-action');
        expect(text).toContain('fail-on-severity: high');
    });
});

describe('the repository contains no committed credentials', () => {
    it('ships no token in the chart defaults or the CI values', () => {
        const values = load(read('charts/hetzner-server-controller/values.yaml')) as {
            hetzner: { token: string; existingSecret: string };
        };
        expect(values.hetzner.token).toBe('');
        expect(values.hetzner.existingSecret).toBe('');
        for (const file of readdirSync(join(root, 'charts/hetzner-server-controller/ci'))) {
            const text = read(`charts/hetzner-server-controller/ci/${file}`);
            // A real Hetzner token is 64 alphanumerics; the placeholder is not.
            expect(text, file).not.toMatch(/token: [A-Za-z0-9]{64}/);
        }
    });

    it('has no private key material outside the documented placeholder', () => {
        const offenders: string[] = [];
        const walk = (directory: string): void => {
            for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
                const path = `${directory}/${entry.name}`;
                if (entry.isDirectory()) {
                    if (!['node_modules', 'dist', 'coverage', '.git'].includes(entry.name)) {
                        walk(path);
                    }
                    continue;
                }
                if (!/\.(ts|yaml|yml|json|md)$/.test(entry.name)) {
                    continue;
                }
                const text = readFileSync(join(root, path), 'utf8');
                // A real key body is base64 over many lines; the placeholders in
                // the examples are a single REPLACE_ME line.
                if (/-----BEGIN [A-Z ]*PRIVATE KEY-----\s*\n\s*[A-Za-z0-9+/]{40,}/.test(text)) {
                    offenders.push(path);
                }
            }
        };
        walk('.');
        expect(offenders).toEqual([]);
    });
});
