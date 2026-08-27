import { describe, expect, it } from 'vitest';
import { API_KEY_ENV, createOpenCloudClient, run } from '../src/index.js';
import { TEST_KEY, fakeFetch, type FakeResponse } from './helpers.js';

function deps(...responses: readonly FakeResponse[]) {
  const fetch = fakeFetch(...responses);
  return {
    fetch,
    deps: {
      environment: { [API_KEY_ENV]: TEST_KEY },
      createClient: () => createOpenCloudClient({ apiKey: TEST_KEY, fetch, retry: { attempts: 1 } }),
      readPlaceFile: async () => new Uint8Array([1, 2, 3]),
    },
  };
}

describe('publish-from-CLI, end to end', () => {
  it('publishes a place and prints the version number', async () => {
    const { fetch, deps: d } = deps({ status: 200, body: '{"versionNumber":42}' });

    const result = await run(
      [
        'publish-place',
        '--universe', '1234',
        '--place', '5678',
        '--file', 'build/game.rbxl',
        '--version-type', 'Published',
      ],
      d,
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ versionNumber: 42 });
    expect(fetch.calls[0]!.url).toBe(
      'https://apis.roblox.com/universes/v1/1234/places/5678/versions?versionType=Published',
    );
    expect(fetch.calls[0]!.headers['content-type']).toBe('application/octet-stream');
  });

  it('exits non-zero and prints nothing on stdout when the publish is refused', async () => {
    // The contract: 0 did it, non-zero did not, and there is no third state
    // where a script reads a version number out of a failed publish.
    const { deps: d } = deps({ status: 401, body: '{"message":"Invalid API key"}' });
    const result = await run(
      ['publish-place', '--universe', '1', '--place', '2', '--file', 'g.rbxl', '--version-type', 'Saved'],
      d,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Invalid API key');
  });

  it('refuses a file extension it cannot map to a content type', async () => {
    const { fetch, deps: d } = deps();
    const result = await run(
      ['publish-place', '--universe', '1', '--place', '2', '--file', 'g.rbxm', '--version-type', 'Saved'],
      d,
    );
    expect(result.code).toBe(1);
    expect(fetch.calls).toHaveLength(0);
  });

  it('refuses a --version-type it was not given', async () => {
    const { deps: d } = deps();
    const result = await run(['publish-place', '--universe', '1', '--place', '2', '--file', 'g.rbxl'], d);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--version-type is required');
  });
});

describe('the data store subcommands', () => {
  it('sets an entry from JSON on the command line', async () => {
    const { fetch, deps: d } = deps({ status: 200, body: '{"version":"v2"}' });
    const result = await run(
      ['datastore', 'set', '--universe', '1', '--datastore', 'Saves', '--key', 'u_1', '--value', '{"coins":9}'],
      d,
    );
    expect(result.code).toBe(0);
    expect(fetch.calls[0]!.body).toBe('{"coins":9}');
  });

  it('refuses a --value that is not JSON, and says how to store a bare string', async () => {
    const { deps: d } = deps();
    const result = await run(
      ['datastore', 'set', '--universe', '1', '--datastore', 'S', '--key', 'k', '--value', 'coins'],
      d,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('must be JSON');
  });

  it('passes --exclusive-create through as a boolean flag', async () => {
    const { fetch, deps: d } = deps({ status: 200, body: '{"version":"v1"}' });
    await run(
      ['datastore', 'set', '--universe', '1', '--datastore', 'S', '--key', 'k', '--value', '1', '--exclusive-create'],
      d,
    );
    expect(fetch.calls[0]!.url).toContain('exclusiveCreate=true');
  });

  it('increments and reports the new total', async () => {
    const { deps: d } = deps({ status: 200, body: '7' });
    const result = await run(
      ['datastore', 'incr', '--universe', '1', '--datastore', 'S', '--key', 'k', '--by', '2'],
      d,
    );
    expect(JSON.parse(result.stdout).value).toBe(7);
  });
});

describe('argument handling', () => {
  it('treats an unknown flag as an error rather than dropping it', async () => {
    // A silently dropped `--exclusive-creat` turns "only if absent" into
    // "overwrite whatever is there", and the output looks the same either way.
    const { fetch, deps: d } = deps();
    const result = await run(
      ['datastore', 'set', '--universe', '1', '--datastore', 'S', '--key', 'k', '--value', '1', '--exclusive-creat'],
      d,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unknown option "--exclusive-creat"');
    expect(fetch.calls).toHaveLength(0);
  });

  it('prints usage and exits 2 with no arguments', async () => {
    const result = await run([], { environment: {} });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('forgebridge-opencloud');
  });

  it('prints usage and exits 0 for --help, without needing a key', async () => {
    const result = await run(['--help'], { environment: {} });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('Usage:');
  });

  it('rejects an unknown subcommand', async () => {
    const result = await run(['deploy'], { environment: { [API_KEY_ENV]: TEST_KEY } });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown command "deploy"');
  });

  it('fails at the door when the key is not in the environment', async () => {
    const { fetch, deps: d } = deps();
    const result = await run(['message', 'publish', '--universe', '1', '--topic', 't', '--message', 'm'], {
      ...d,
      environment: {},
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(API_KEY_ENV);
    expect(fetch.calls).toHaveLength(0);
  });
});
