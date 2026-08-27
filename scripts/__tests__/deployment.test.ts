/**
 * The deployment gate's self-tests.
 *
 * Same two halves as every other gate here: the rules against the real files,
 * then each rule against a planted violation, with a control beside anything
 * that could plausibly fire on correct work.
 *
 * The reason this file exists at all: `docker-compose.yml`, `deploy/` and
 * `examples/` are the parts of this repository a stranger meets first, and they
 * are the parts nothing was checking. A compose file that quietly stops setting
 * a variable, or an image that slides to `latest`, changes a deployment without
 * changing anything a reviewer looks at.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COMPOSE_FILES,
  CONNECTOR_EXAMPLES,
  DELIBERATELY_UNSET,
  checkCaddyAgreement,
  checkDockerfilesExist,
  checkExamples,
  checkImagePins,
  checkPublishedPorts,
  checkRelayConfiguration,
  composeServices,
  dockerfilesReferenced,
  readCaddyfile,
  relayEnvironmentNames,
  type DeploymentViolation,
} from '../deployment-rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string): boolean => existsSync(path.join(ROOT, rel));
const isDirectory = (rel: string): boolean =>
  existsSync(path.join(ROOT, rel)) && statSync(path.join(ROOT, rel)).isDirectory();

const COMPOSE = 'docker-compose.yml';
const compose = read(COMPOSE);
const relayBin = read('apps/relay/src/bin.ts');

const report = (violations: readonly DeploymentViolation[]): string[] =>
  violations.map((v) => `${v.rule} ${v.file}: ${v.detail}`);

describe('the stack as it stands', () => {
  it('P1 — every compose file configures every variable the relay reads', () => {
    const names = relayEnvironmentNames(relayBin);
    expect(names).toContain('RELAY_PROXY_HOPS');
    expect(COMPOSE_FILES.length).toBeGreaterThan(1);
    for (const file of COMPOSE_FILES) {
      expect(report(checkRelayConfiguration(file, read(file), names)), file).toEqual([]);
    }
  });

  it('P1 — every deliberately unset variable has a reason recorded', () => {
    // An exemption nobody reads is a hole nobody notices.
    for (const [name, reason] of Object.entries(DELIBERATELY_UNSET)) {
      expect(relayEnvironmentNames(relayBin), `${name} is exempted and the relay no longer reads it`).toContain(name);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('P2 — the two Caddy configurations agree', () => {
    const files = ['deploy/Caddyfile', 'apps/relay/deploy/Caddyfile'].map((rel) => ({ path: rel, text: read(rel) }));
    expect(report(checkCaddyAgreement(files))).toEqual([]);
  });

  it('P3 — every image is pinned', () => {
    expect(report(checkImagePins(COMPOSE, compose))).toEqual([]);
  });

  it('P4 — only the proxy publishes a port', () => {
    expect(report(checkPublishedPorts(COMPOSE, compose))).toEqual([]);
    // Worth asserting positively too: a compose file where nothing publishes
    // anything would pass P4 and serve nobody.
    expect(compose).toMatch(/"443:443"/);
  });

  it('P5 — every Dockerfile the compose file builds from exists', () => {
    expect(dockerfilesReferenced(compose).length).toBeGreaterThan(0);
    expect(report(checkDockerfilesExist(COMPOSE, compose, exists))).toEqual([]);
  });

  it('P5 — the lite daemon image exists and is built from the repository root', () => {
    const dockerfile = read('deploy/daemon.Dockerfile');
    expect(dockerfile).toContain('packages/daemon/dist/bin.js');
    // The context claim is load-bearing: the daemon depends on four workspace
    // siblings, so a build rooted at packages/daemon could not see them.
    expect(dockerfile).toContain('BUILD CONTEXT IS THE REPOSITORY ROOT');
  });

  it('P6 — every connector has a runnable example with a README', () => {
    expect(report(checkExamples(exists, isDirectory))).toEqual([]);
  });

  it('P6 — the example directories are the ones the map names, and no others', () => {
    // Both directions. An example nobody mapped is an example the gate would
    // never notice going stale.
    const mapped = new Set(Object.values(CONNECTOR_EXAMPLES).map((dir) => dir.split('/')[1]));
    for (const dir of ['typescript', 'python', 'cli', 'mcp', 'a2a', 'opencloud']) {
      expect(mapped, `examples/${dir} is not in CONNECTOR_EXAMPLES`).toContain(dir);
    }
  });

  it('the compose file is the one the deployment docs tell a stranger to run', () => {
    expect(read('docs/SELF-HOSTING.md')).toContain('docker compose up');
    expect(exists('.env.example')).toBe(true);
  });
});

// ── planted violations ───────────────────────────────────────────────────────

describe('P1 — a variable that quietly stops being configured', () => {
  it('rejects a compose file missing one the relay reads', () => {
    const planted = compose.replace(/^\s*RELAY_PROXY_HOPS:.*$/m, '');
    const violations = checkRelayConfiguration(COMPOSE, planted, ['RELAY_PROXY_HOPS']);
    expect(violations[0]!.detail).toMatch(/RELAY_PROXY_HOPS is read by the relay/);
  });

  it('does not count a name that appears only in a comment', () => {
    // The compose file explains RELAY_PROXY_HOPS at length in its comments. A
    // rule that accepted a commented mention would accept a file that explains
    // the setting and never sets it.
    const planted = compose.replace(/^\s*RELAY_PROXY_HOPS:.*$/m, '      # RELAY_PROXY_HOPS: 1');
    expect(checkRelayConfiguration(COMPOSE, planted, ['RELAY_PROXY_HOPS'])).toHaveLength(1);
  });

  it('CONTROL — an exempted variable is not reported', () => {
    expect(checkRelayConfiguration(COMPOSE, compose, ['RELAY_INSECURE_HTTP'])).toEqual([]);
  });
});

describe('P2 — two proxy configurations that drift', () => {
  const good = 'x.example {\n\treverse_proxy relay:8080 {\n\t\ttransport http {\n\t\t\tread_timeout 15m\n\t\t}\n\t}\n}\n';

  it('reads a Caddyfile', () => {
    expect(readCaddyfile(good)).toEqual({ upstream: 'relay:8080', readTimeout: '15m' });
  });

  it('rejects a differing read_timeout, which is the one that reads as a broken bridge', () => {
    const drifted = good.replace('15m', '30s');
    const violations = checkCaddyAgreement([
      { path: 'a', text: good },
      { path: 'b', text: drifted },
    ]);
    expect(violations[0]!.detail).toMatch(/read_timeout is 30s while a uses 15m/);
  });

  it('rejects a differing upstream', () => {
    const violations = checkCaddyAgreement([
      { path: 'a', text: good },
      { path: 'b', text: good.replace('relay:8080', 'relay:9090') },
    ]);
    expect(violations[0]!.detail).toMatch(/proxies to relay:9090/);
  });

  it('rejects having fewer than two files to compare, rather than reporting agreement', () => {
    expect(checkCaddyAgreement([{ path: 'a', text: good }])[0]!.detail).toMatch(/expected at least two/);
  });

  it('CONTROL — two identical configurations pass', () => {
    expect(checkCaddyAgreement([{ path: 'a', text: good }, { path: 'b', text: good }])).toEqual([]);
  });
});

describe('P3 — image pins', () => {
  it('rejects a tagless image', () => {
    expect(checkImagePins('c', 'services:\n  x:\n    image: caddy\n')[0]!.detail).toMatch(/has no tag/);
  });

  it('rejects :latest', () => {
    expect(checkImagePins('c', 'services:\n  x:\n    image: caddy:latest\n')[0]!.detail).toMatch(/not a pin/);
  });

  it('CONTROL — a tag and a digest both count as pinned', () => {
    expect(checkImagePins('c', 'services:\n  x:\n    image: caddy:2-alpine\n')).toEqual([]);
    expect(checkImagePins('c', 'services:\n  x:\n    image: caddy@sha256:' + 'a'.repeat(64) + '\n')).toEqual([]);
  });

  it('ignores a commented image line', () => {
    expect(checkImagePins('c', 'services:\n  x:\n    # image: caddy:latest\n    image: caddy:2-alpine\n')).toEqual([]);
  });
});

describe('P4 — only the proxy publishes', () => {
  it('splits a compose file into services', () => {
    expect(composeServices(compose).map((s) => s.name)).toEqual(['relay', 'caddy', 'otel-collector']);
  });

  it('rejects a relay published straight to the host', () => {
    // This is the change that turns RELAY_PROXY_HOPS=1 from a fact into a
    // vulnerability: a path to the relay that skips the proxy means the
    // rightmost X-Forwarded-For entry was written by the caller.
    const planted = compose.replace(
      /^(  relay:\n)/m,
      '  relay:\n    ports:\n      - "8080:8080"\n',
    );
    expect(checkPublishedPorts(COMPOSE, planted)[0]!.detail).toMatch(/service "relay" publishes a port/);
  });

  it('rejects a collector published to the host', () => {
    const planted = compose.replace(
      /^(  otel-collector:\n)/m,
      '  otel-collector:\n    ports:\n      - "4318:4318"\n',
    );
    expect(checkPublishedPorts(COMPOSE, planted)[0]!.detail).toMatch(/service "otel-collector" publishes a port/);
  });

  it('rejects a compose file with no services rather than reporting clean', () => {
    expect(checkPublishedPorts('c', 'name: x\n')[0]!.detail).toMatch(/no services block/);
  });
});

describe('P5/P6 — files and examples that are named and missing', () => {
  it('rejects a build from a Dockerfile that is not in the tree', () => {
    const planted = compose.replace('apps/relay/Dockerfile', 'apps/relay/Dockerfile.gone');
    expect(checkDockerfilesExist(COMPOSE, planted, exists)[0]!.detail).toMatch(/not a file in this repository/);
  });

  it('rejects a connector with no example', () => {
    const violations = checkExamples(
      (rel) => rel === 'packages/opencloud',
      () => false,
    );
    expect(violations[0]!.detail).toMatch(/packages\/opencloud exists and has no runnable example/);
  });

  it('rejects an example directory with no README', () => {
    const violations = checkExamples(
      (rel) => rel === 'packages/opencloud',
      (rel) => rel === 'examples/opencloud',
    );
    expect(violations[0]!.detail).toMatch(/has no README.md/);
  });

  it('CONTROL — a connector that does not exist yet owes no example', () => {
    // Otherwise the rule fires on a package nobody has written, which is a rule
    // people route around rather than satisfy.
    expect(checkExamples(() => false, () => false)).toEqual([]);
  });
});
