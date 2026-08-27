/**
 * The deployment gate: rules over `docker-compose.yml`, the Dockerfiles, the
 * proxy configuration and `examples/`.
 *
 * These are the M46/M47/M50 half of what the other gates in this directory do
 * for source. The argument is the same one `verify-boundaries.ts` makes: the
 * repository has documented promises about how it deploys — *the relay is only
 * reachable through the proxy*, *every image is pinned*, *one runnable example
 * per connector* — and a promise nothing checks is a promise that stops being
 * true on a Tuesday.
 *
 * Six rules, each a pure function over file text so `__tests__/deployment.test.ts`
 * can plant a violation and prove it fires, and each shipped with the legitimate
 * shape it is most confusable with as a control.
 *
 *   P1  every variable the relay reads is set in the compose file, or listed
 *       here as deliberately unset with a reason
 *   P2  the two Caddy configurations agree
 *   P3  every image is pinned to a version
 *   P4  nothing publishes a port except the proxy
 *   P5  every service the compose file builds has a Dockerfile that exists
 *   P6  every connector that claims a runnable example has one
 */

export interface DeploymentViolation {
  rule: 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6';
  file: string;
  detail: string;
}

export const DEPLOYMENT_RULE_TEXT: Record<DeploymentViolation['rule'], string> = {
  P1: 'the compose file configures every variable the relay reads',
  P2: 'the two Caddy configurations agree on target and timeout',
  P3: 'every image in the compose file is pinned',
  P4: 'only the proxy publishes a port',
  P5: 'every built service names a Dockerfile that exists',
  P6: 'every connector with a documented example has one',
};

function push(out: DeploymentViolation[], rule: DeploymentViolation['rule'], file: string, detail: string): void {
  out.push({ rule, file, detail });
}

// ── P1: the relay's configuration surface ────────────────────────────────────

/**
 * Variables the relay reads that the compose file is *right* not to set, with
 * the reason, printed by the gate on every run.
 *
 * A list of exemptions nobody reads is a hole nobody notices —
 * `verify-no-key-storage.ts` makes the same argument for its allowed names.
 */
export const DELIBERATELY_UNSET: Readonly<Record<string, string>> = {
  RELAY_HOST: 'the container has one interface and the image already defaults to 0.0.0.0',
  RELAY_INSECURE_HTTP:
    'setting it would waive the TLS check for a deployment whose entire point is that Caddy terminates TLS in front',
};

/**
 * Every compose file in this repository. Both must configure the whole surface:
 * the root one is the full stack, `apps/relay/deploy/` is the relay on its own,
 * and a variable added to one and not the other is a self-hoster who followed
 * the wrong README and got a different relay.
 */
export const COMPOSE_FILES: readonly string[] = ['docker-compose.yml', 'apps/relay/deploy/docker-compose.yml'];

/** Every `RELAY_*` name a source file reads out of the environment. */
export function relayEnvironmentNames(binSource: string): string[] {
  const found = new Set<string>();
  // Both spellings the relay uses: a literal in an ENV table, and a direct read.
  for (const match of binSource.matchAll(/\b(RELAY_[A-Z0-9_]+)\b/g)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found].sort();
}

export function checkRelayConfiguration(
  composePath: string,
  compose: string,
  names: readonly string[],
): DeploymentViolation[] {
  const out: DeploymentViolation[] = [];
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(DELIBERATELY_UNSET, name)) continue;
    // A name that appears only inside a comment is a name nobody set.
    const uncommented = compose
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    if (new RegExp(`^\\s*${name}\\s*:`, 'm').test(uncommented)) continue;
    push(
      out,
      'P1',
      composePath,
      `${name} is read by the relay and is neither set here nor listed as deliberately unset. ` +
        'A self-hoster reading this file cannot see the whole configurable surface, which is the point of having it in one place.',
    );
  }
  return out;
}

// ── P2: two proxy configurations, one behaviour ──────────────────────────────

export interface CaddyFacts {
  upstream: string | null;
  readTimeout: string | null;
}

export function readCaddyfile(text: string): CaddyFacts {
  return {
    upstream: /^\s*reverse_proxy\s+(\S+)/m.exec(text)?.[1] ?? null,
    readTimeout: /^\s*read_timeout\s+(\S+)/m.exec(text)?.[1] ?? null,
  };
}

export function checkCaddyAgreement(
  files: readonly { path: string; text: string }[],
): DeploymentViolation[] {
  const out: DeploymentViolation[] = [];
  if (files.length < 2) {
    // Fail closed: "I found fewer than two configurations to compare" must not
    // read the same as "the two configurations agree".
    push(
      out,
      'P2',
      files[0]?.path ?? 'deploy/Caddyfile',
      `expected at least two Caddy configurations to compare and found ${files.length}`,
    );
    return out;
  }
  const facts = files.map((file) => ({ path: file.path, ...readCaddyfile(file.text) }));
  const first = facts[0]!;
  for (const other of facts.slice(1)) {
    if (first.upstream === null || other.upstream === null) {
      push(out, 'P2', other.path, 'no `reverse_proxy` line was found, so the two cannot be compared');
      continue;
    }
    if (first.upstream !== other.upstream) {
      push(
        out,
        'P2',
        other.path,
        `proxies to ${other.upstream} while ${first.path} proxies to ${first.upstream}`,
      );
    }
    if (first.readTimeout !== other.readTimeout) {
      push(
        out,
        'P2',
        other.path,
        `read_timeout is ${other.readTimeout ?? 'unset'} while ${first.path} uses ${first.readTimeout ?? 'unset'} — ` +
          'the plugin holds a long-poll open for 25 seconds and a run stream for longer, so this is the setting that reads to a user as a broken bridge',
      );
    }
  }
  return out;
}

// ── P3: pinned images ────────────────────────────────────────────────────────

export function checkImagePins(path: string, compose: string): DeploymentViolation[] {
  const out: DeploymentViolation[] = [];
  compose.split('\n').forEach((raw) => {
    const line = raw.replace(/#.*$/, '');
    const image = /^\s*image:\s*(\S+)/.exec(line)?.[1];
    if (image === undefined) return;
    if (image.includes('@sha256:')) return;
    const tag = image.split(':')[1];
    if (tag === undefined) {
      push(out, 'P3', path, `image "${image}" has no tag, so it means "latest" and will change under a deployment nobody touched`);
      return;
    }
    if (tag === 'latest') {
      push(out, 'P3', path, `image "${image}" is pinned to latest, which is not a pin`);
    }
  });
  return out;
}

// ── P4: only the proxy publishes ─────────────────────────────────────────────

export interface ComposeService {
  name: string;
  text: string;
}

/** Split a compose file's `services:` block into one entry per service. */
export function composeServices(compose: string): ComposeService[] {
  const lines = compose.split('\n');
  const start = lines.findIndex((line) => /^services:\s*$/.test(line));
  if (start === -1) return [];
  const services: ComposeService[] = [];
  let current: ComposeService | null = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^\S/.test(line) && line.trim() !== '') break;
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header?.[1]) {
      current = { name: header[1], text: '' };
      services.push(current);
      continue;
    }
    if (current !== null) current.text += `${line}\n`;
  }
  return services;
}

/** The one service allowed to publish ports: the TLS terminator in front of everything. */
export const PUBLISHING_SERVICE = 'caddy';

export function checkPublishedPorts(path: string, compose: string): DeploymentViolation[] {
  const out: DeploymentViolation[] = [];
  const services = composeServices(compose);
  if (services.length === 0) {
    push(out, 'P4', path, 'no services block was found, so no port could be checked');
    return out;
  }
  for (const service of services) {
    if (service.name === PUBLISHING_SERVICE) continue;
    if (!/^\s*ports:\s*$/m.test(service.text)) continue;
    push(
      out,
      'P4',
      path,
      `service "${service.name}" publishes a port to the host. Only "${PUBLISHING_SERVICE}" may: ` +
        'with the relay unpublished there is no path to it that skips the proxy, which is what makes RELAY_PROXY_HOPS=1 a fact rather than a hope.',
    );
  }
  return out;
}

// ── P5: every built service names a real Dockerfile ──────────────────────────

export function dockerfilesReferenced(compose: string): string[] {
  return [...compose.matchAll(/^\s*dockerfile:\s*(\S+)/gm)].map((match) => match[1] ?? '');
}

export function checkDockerfilesExist(
  path: string,
  compose: string,
  exists: (rel: string) => boolean,
): DeploymentViolation[] {
  const out: DeploymentViolation[] = [];
  for (const dockerfile of dockerfilesReferenced(compose)) {
    if (exists(dockerfile)) continue;
    push(out, 'P5', path, `builds from "${dockerfile}", which is not a file in this repository`);
  }
  return out;
}

// ── P6: one runnable example per connector ───────────────────────────────────

/**
 * The connectors M50 asks for an example of, and the directory under
 * `examples/` each one's example lives in.
 *
 * Written as a map rather than derived from `packages/`, because not every
 * package is a connector: `packages/protocol` is a contract and
 * `packages/conformance` is a test suite, and demanding an example of either
 * would be a rule people route around rather than satisfy.
 */
export const CONNECTOR_EXAMPLES: Readonly<Record<string, string>> = {
  'packages/sdk-ts': 'examples/typescript',
  'packages/sdk-python': 'examples/python',
  'packages/cli': 'examples/cli',
  'packages/mcp': 'examples/mcp',
  'packages/a2a': 'examples/a2a',
  'packages/opencloud': 'examples/opencloud',
};

export function checkExamples(
  exists: (rel: string) => boolean,
  isDirectory: (rel: string) => boolean,
): DeploymentViolation[] {
  const out: DeploymentViolation[] = [];
  for (const [connector, example] of Object.entries(CONNECTOR_EXAMPLES)) {
    // A connector that does not exist owes no example. This keeps the rule from
    // firing on a package somebody has not written yet, while still firing the
    // day they do.
    if (!exists(connector)) continue;
    if (!isDirectory(example)) {
      push(out, 'P6', example, `${connector} exists and has no runnable example`);
      continue;
    }
    if (!exists(`${example}/README.md`)) {
      push(
        out,
        'P6',
        example,
        'has no README.md — an example nobody can run without reading the source is a sample, not an example',
      );
    }
  }
  return out;
}
