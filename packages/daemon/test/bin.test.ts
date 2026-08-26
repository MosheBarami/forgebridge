import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/bin.js';
import { DEFAULT_DAEMON_PORT } from '../src/server.js';

describe('parseArgs', () => {
  it('defaults to the fixed port and a fresh project id', () => {
    const args = parseArgs([]);
    expect(args.port).toBe(DEFAULT_DAEMON_PORT);
    expect(args.projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(args.allowedPaths).toEqual([]);
  });

  it('refuses a --project that is not a uuid', () => {
    // `Link.parse` requires a uuid and runs on the first pair, which is minutes
    // after startup: without this the daemon starts, looks healthy, and answers
    // the first pairing attempt with a bare 500 out of a ZodError.
    expect(() => parseArgs(['--project', 'my-game'])).toThrow(/uuid/);
    expect(() => parseArgs(['--project', '123'])).toThrow(/uuid/);
    expect(() => parseArgs(['--project', ''])).toThrow(/uuid/);
  });

  it('accepts a --project that is a uuid', () => {
    const id = randomUUID();
    expect(parseArgs(['--project', id]).projectId).toBe(id);
  });

  it('refuses a --port outside the range, as it always did', () => {
    expect(() => parseArgs(['--port', '0'])).toThrow(/between 1 and 65535/);
    expect(() => parseArgs(['--port', '70000'])).toThrow(/between 1 and 65535/);
    expect(parseArgs(['--port', '7000']).port).toBe(7000);
  });

  it('refuses an --allow-path that is not an addressable instance path', () => {
    // A prefix that matches nothing is indistinguishable from a policy that is
    // working, which is the worst failure mode a security control has.
    expect(() => parseArgs(['--allow-path', 'NotAService.Thing'])).toThrow(/not a valid instance path/);
    expect(() => parseArgs(['--allow-path', 'Workspace..Crate'])).toThrow(/not a valid instance path/);
    expect(parseArgs(['--allow-path', 'ServerScriptService.Shop']).allowedPaths).toEqual([
      'ServerScriptService.Shop',
    ]);
  });

  it('collects repeated paths and origins', () => {
    const args = parseArgs([
      '--allow-path',
      'Workspace',
      '--allow-path',
      'ServerScriptService',
      '--allow-origin',
      'http://localhost:3000',
    ]);
    expect(args.allowedPaths).toEqual(['Workspace', 'ServerScriptService']);
    expect(args.allowedOrigins).toEqual(['http://localhost:3000']);
  });

  it('refuses an unknown option rather than ignoring it', () => {
    expect(() => parseArgs(['--allow-everything'])).toThrow(/unknown option/);
  });
});
