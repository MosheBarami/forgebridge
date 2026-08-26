import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CliError, EXIT } from '../src/exit.js';
import {
  BASE_URL_ENV,
  COMMANDS,
  DEFAULT_APPLY_TIMEOUT_SECONDS,
  DEFAULT_BASE_URL,
  TOKEN_ENV,
  parseInvocation,
} from '../src/args.js';

const NO_ENV: NodeJS.ProcessEnv = {};

/** Every malformed line should leave with 2 and say something about the flag it tripped on. */
function expectUsageError(argv: readonly string[], matching?: RegExp): CliError {
  let thrown: unknown;
  try {
    parseInvocation(argv, NO_ENV);
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected \`forgebridge ${argv.join(' ')}\` to be refused`).toBeInstanceOf(CliError);
  const error = thrown as CliError;
  expect(error.exitCode).toBe(EXIT.USAGE);
  if (matching) expect(error.message).toMatch(matching);
  return error;
}

describe('dispatch', () => {
  it('treats a bare invocation, help and --help as the same request', () => {
    for (const argv of [[], ['help'], ['--help'], ['-h']]) {
      expect(parseInvocation(argv, NO_ENV)).toEqual({ command: 'help', topic: null });
    }
  });

  it('routes --help after a command to that command', () => {
    expect(parseInvocation(['apply', '--help'], NO_ENV)).toEqual({ command: 'help', topic: 'apply' });
    expect(parseInvocation(['help', 'rollback'], NO_ENV)).toEqual({ command: 'help', topic: 'rollback' });
    // Before the required positional is even supplied: someone who does not
    // know the arguments is exactly who is asking.
    expect(parseInvocation(['diff', '-h'], NO_ENV)).toEqual({ command: 'help', topic: 'diff' });
  });

  it('reports --version', () => {
    expect(parseInvocation(['--version'], NO_ENV)).toEqual({ command: 'version' });
  });

  it('refuses an unknown command and lists the real ones', () => {
    const error = expectUsageError(['appply'], /unknown command: appply/);
    for (const command of COMMANDS) expect(error.remedy).toContain(command);
  });

  it('refuses an unknown help topic', () => {
    expectUsageError(['help', 'frobnicate'], /unknown command: frobnicate/);
  });
});

describe('global options', () => {
  it('defaults the base address to loopback', () => {
    const invocation = parseInvocation(['status'], NO_ENV);
    expect(invocation).toMatchObject({ command: 'status', global: { baseUrl: DEFAULT_BASE_URL, json: false } });
  });

  it('prefers --url over the environment, and the environment over the default', () => {
    const env = { [BASE_URL_ENV]: 'http://127.0.0.1:9000' };
    expect(parseInvocation(['status'], env)).toMatchObject({ global: { baseUrl: 'http://127.0.0.1:9000' } });
    expect(parseInvocation(['status', '--url', 'https://relay.example'], env)).toMatchObject({
      global: { baseUrl: 'https://relay.example' },
    });
  });

  it('reads the producer token from the same variable the daemon uses', () => {
    expect(parseInvocation(['status'], { [TOKEN_ENV]: 'from-env' })).toMatchObject({
      global: { token: 'from-env' },
    });
    expect(parseInvocation(['status', '--token', 'from-flag'], { [TOKEN_ENV]: 'from-env' })).toMatchObject({
      global: { token: 'from-flag' },
    });
  });

  it('refuses a --url that is not an absolute http address', () => {
    expectUsageError(['status', '--url', 'not-a-url'], /absolute URL/);
    expectUsageError(['status', '--url', '127.0.0.1:7317'], /absolute URL/);
    // A file: or ws: base would produce requests nothing on the /v1 surface serves.
    expectUsageError(['status', '--url', 'file:///etc/passwd'], /must be http or https/);
    expectUsageError(['status', '--url', 'ws://127.0.0.1:7317'], /must be http or https/);
  });

  it('refuses a repeated single-valued flag rather than silently picking one', () => {
    // Which machine a ChangeSet is sent to is not a good thing to guess at.
    expectUsageError(['status', '--url', 'http://a.test', '--url', 'http://b.test'], /--url was given more than once/);
    expectUsageError(['status', '--token', 'a', '--token', 'b'], /--token was given more than once/);
  });

  it('refuses a value-taking flag with an empty value', () => {
    expectUsageError(['status', '--token', ''], /--token requires a non-empty value/);
  });

  it('refuses an unknown option', () => {
    expectUsageError(['status', '--verbose'], /verbose/);
    expectUsageError(['models', '--fre'], /fre/);
  });

  it('refuses a flag that needs a value and was given none', () => {
    expectUsageError(['status', '--url']);
  });
});

describe('daemon', () => {
  it('defaults the port and leaves the project id to the daemon', () => {
    expect(parseInvocation(['daemon'], NO_ENV)).toMatchObject({
      command: 'daemon',
      port: 7317,
      projectId: null,
      allowPaths: [],
      allowOrigins: [],
      allowHttpHosts: [],
    });
  });

  it('accepts repeated --allow-path and --allow-origin', () => {
    expect(
      parseInvocation(
        ['daemon', '--allow-path', 'ServerScriptService.Shop', '--allow-path', 'ReplicatedStorage', '--allow-origin', 'http://localhost:3000'],
        NO_ENV,
      ),
    ).toMatchObject({
      allowPaths: ['ServerScriptService.Shop', 'ReplicatedStorage'],
      allowOrigins: ['http://localhost:3000'],
    });
  });

  it('refuses a port outside the range, or one that is not a number', () => {
    expectUsageError(['daemon', '--port', '0'], /between 1 and 65535/);
    expectUsageError(['daemon', '--port', '65536'], /between 1 and 65535/);
    expectUsageError(['daemon', '--port=-1'], /between 1 and 65535/);
    // A bare `--port -1` is refused by parseArgs itself as ambiguous. Still a
    // usage error, still exit 2, and its message says to write `--port=-1`.
    expectUsageError(['daemon', '--port', '-1'], /ambiguous/);
    expectUsageError(['daemon', '--port', '80x'], /must be an integer/);
    expectUsageError(['daemon', '--port', '80.5'], /must be an integer/);
    expectUsageError(['daemon', '--port', 'http'], /must be an integer/);
  });

  it('refuses a project id that is not a uuid', () => {
    expectUsageError(['daemon', '--project', 'my-game'], /must be a uuid/);
    expect(parseInvocation(['daemon', '--project', randomUUID()], NO_ENV)).toMatchObject({ command: 'daemon' });
  });

  it('refuses an --allow-path that is not a valid instance path', () => {
    // A prefix that parses as nothing matches nothing, which is exactly what a
    // working policy looks like from the outside.
    expectUsageError(['daemon', '--allow-path', 'NotAService.Thing'], /not a valid instance path/);
    expectUsageError(['daemon', '--allow-path', 'ServerScriptService.has space'], /not a valid instance path/);
    expectUsageError(['daemon', '--allow-path', ''], /--allow-path requires a non-empty value/);
  });

  it('normalises --allow-http-host so a URL and a bare host are one entry', () => {
    // The daemon compares against what the analyser's own `normaliseHost`
    // produces. A value typed with a scheme, a port or a path on it would match
    // nothing otherwise, which looks exactly like a working allowlist.
    expect(
      parseInvocation(
        ['daemon', '--allow-http-host', 'https://API.Example.com:443/v1', '--allow-http-host', '*.example.org'],
        NO_ENV,
      ),
    ).toMatchObject({ allowHttpHosts: ['api.example.com', '*.example.org'] });
  });

  it('refuses an --allow-http-host that names no host', () => {
    expectUsageError(['daemon', '--allow-http-host', ''], /--allow-http-host requires a non-empty value/);
    expectUsageError(['daemon', '--allow-http-host', 'https://'], /names no host/);
  });

  it('takes no positional arguments', () => {
    expectUsageError(['daemon', 'start'], /takes no arguments/);
  });
});

describe('link', () => {
  it('defaults to showing status', () => {
    expect(parseInvocation(['link'], NO_ENV)).toMatchObject({ command: 'link', code: null });
  });

  it('carries --code through to the command, which refuses it with a reason', () => {
    // Parsed rather than rejected as unknown so the refusal can explain that a
    // pairing code belongs to the Studio plugin, not to a producer.
    expect(parseInvocation(['link', '--code', 'ABCD2345'], NO_ENV)).toMatchObject({ code: 'ABCD2345' });
  });

  it('takes no positional arguments', () => {
    expectUsageError(['link', 'ABCD2345'], /takes no arguments/);
  });
});

describe('models', () => {
  it('parses --free and both --caps spellings identically', () => {
    expect(parseInvocation(['models', '--free'], NO_ENV)).toMatchObject({ free: true, capabilities: [] });
    expect(parseInvocation(['models', '--caps', 'tools,vision'], NO_ENV)).toMatchObject({
      capabilities: ['tools', 'vision'],
    });
    expect(parseInvocation(['models', '--caps', 'tools', '--caps', 'vision'], NO_ENV)).toMatchObject({
      capabilities: ['tools', 'vision'],
    });
    expect(parseInvocation(['models', '--caps', ' tools , vision '], NO_ENV)).toMatchObject({
      capabilities: ['tools', 'vision'],
    });
  });

  it('refuses a capability that is not a lowercase token', () => {
    expectUsageError(['models', '--caps', 'Tools'], /lowercase tokens/);
    expectUsageError(['models', '--caps', 'tool-choice!'], /lowercase tokens/);
  });

  it('takes no positional arguments', () => {
    expectUsageError(['models', 'free'], /takes no arguments/);
  });
});

describe('run', () => {
  it('takes exactly one prompt', () => {
    expect(parseInvocation(['run', 'build a shop'], NO_ENV)).toMatchObject({
      command: 'run',
      prompt: 'build a shop',
    });
  });

  it('refuses a missing, empty or whitespace-only prompt', () => {
    expectUsageError(['run'], /a prompt is required/);
    // An empty string was supplied, so it is reported as empty, not as missing.
    expectUsageError(['run', ''], /the prompt is empty/);
    expectUsageError(['run', '   '], /the prompt is empty/);
  });

  it('refuses more than one prompt, rather than silently using the first', () => {
    expectUsageError(['run', 'build a shop', 'and a door'], /expected one a prompt, got 2/);
  });

  it('refuses a prompt longer than the protocol allows', () => {
    expectUsageError(['run', 'x'.repeat(50_001)], /caps Run\.prompt at 50000/);
    expect(parseInvocation(['run', 'x'.repeat(50_000)], NO_ENV)).toMatchObject({ command: 'run' });
  });

  it('accepts a prompt that begins with a dash after --', () => {
    expect(parseInvocation(['run', '--', '--not-a-flag'], NO_ENV)).toMatchObject({ prompt: '--not-a-flag' });
  });
});

describe('diff', () => {
  it('requires exactly one uuid', () => {
    const id = randomUUID();
    expect(parseInvocation(['diff', id], NO_ENV)).toMatchObject({ command: 'diff', changeSetId: id });
    expectUsageError(['diff'], /a changeset id is required/);
    expectUsageError(['diff', 'not-a-uuid'], /must be a uuid/);
    expectUsageError(['diff', randomUUID(), randomUUID()], /expected one a changeset id, got 2/);
  });
});

describe('apply', () => {
  it('defaults the wait and accepts zero as "do not wait"', () => {
    const id = randomUUID();
    expect(parseInvocation(['apply', id], NO_ENV)).toMatchObject({
      command: 'apply',
      changeSetId: id,
      timeoutSeconds: DEFAULT_APPLY_TIMEOUT_SECONDS,
    });
    expect(parseInvocation(['apply', id, '--timeout', '0'], NO_ENV)).toMatchObject({ timeoutSeconds: 0 });
  });

  it('refuses a changeset id that is not a uuid, and a negative timeout', () => {
    expectUsageError(['apply', 'nope'], /must be a uuid/);
    expectUsageError(['apply', randomUUID(), '--timeout=-5'], /between 0 and 86400/);
    expectUsageError(['apply', randomUUID(), '--timeout', 'soon'], /must be an integer/);
  });

  it('has no flag that approves', () => {
    // The guarantee is structural: there is no option to parse, so there is
    // nothing for a future branch to honour (ADR-012).
    for (const flag of ['--yes', '-y', '--force', '--approve', '--auto-approve', '--confirm']) {
      expectUsageError(['apply', randomUUID(), flag]);
    }
  });
});

describe('rollback', () => {
  it('requires a journal id and an expected version', () => {
    const id = randomUUID();
    expect(parseInvocation(['rollback', id, '--expected-version', '7'], NO_ENV)).toMatchObject({
      command: 'rollback',
      journalId: id,
      expectedVersion: 7,
      reason: null,
    });
    expect(
      parseInvocation(['rollback', id, '--expected-version', '7', '--reason', 'bad shop'], NO_ENV),
    ).toMatchObject({ reason: 'bad shop' });
  });

  it('refuses to guess the expected version', () => {
    // Filling it in — from a default, or by reading the daemon's own
    // stale_base refusal and retrying — would defeat the guard it exists to be.
    const error = expectUsageError(['rollback', randomUUID()], /--expected-version is required/);
    expect(error.remedy).toMatch(/tree that has moved/);
  });

  it('refuses a malformed journal id or version', () => {
    expectUsageError(['rollback', 'nope', '--expected-version', '1'], /must be a uuid/);
    expectUsageError(['rollback', randomUUID(), '--expected-version=-1'], /between 0 and/);
    expectUsageError(['rollback', randomUUID(), '--expected-version', 'latest'], /must be an integer/);
    expectUsageError(['rollback'], /a journal id is required/);
  });
});

describe('status', () => {
  it('takes no arguments', () => {
    expect(parseInvocation(['status'], NO_ENV)).toMatchObject({ command: 'status' });
    expectUsageError(['status', 'now'], /takes no arguments/);
  });
});
