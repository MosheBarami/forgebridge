import { describe, expect, it } from 'vitest';
import { DEFAULT_DAEMON_PORT, PRODUCER_TOKEN_ENV } from '@forgebridge/daemon';
import {
  ConfigError,
  DAEMON_URL_ENV,
  DEFAULT_HTTP_PORT,
  HTTP_HOST_ENV,
  HTTP_PORT_ENV,
  PROJECT_ID_ENV,
  TRANSPORT_ENV,
  bindsPublicly,
  resolveConfig,
  resolveTransport,
} from '../src/config.js';

/**
 * Transport selection.
 *
 * One server implementation, two bindings, and the choice between them has to
 * be boring: an editor spawns this process and speaks over its pipes, so stdio
 * is what you get unless somebody asked out loud for a socket.
 */

const withToken = { [PRODUCER_TOKEN_ENV]: 'a-token' } as NodeJS.ProcessEnv;

describe('choosing a binding', () => {
  it('is stdio by default', () => {
    expect(resolveTransport([], {})).toBe('stdio');
  });

  it('takes --http and --stdio, and refuses both at once', () => {
    expect(resolveTransport(['--http'], {})).toBe('http');
    expect(resolveTransport(['--stdio'], {})).toBe('stdio');
    expect(() => resolveTransport(['--http', '--stdio'], {})).toThrow(ConfigError);
  });

  it('takes the environment when no flag says otherwise, and a flag wins over it', () => {
    expect(resolveTransport([], { [TRANSPORT_ENV]: 'http' })).toBe('http');
    expect(resolveTransport(['--stdio'], { [TRANSPORT_ENV]: 'http' })).toBe('stdio');
  });

  it('refuses a transport it does not have rather than falling back silently', () => {
    // A silent fallback to stdio here would present as "the server started and
    // then nothing could reach it".
    expect(() => resolveTransport([], { [TRANSPORT_ENV]: 'websocket' })).toThrow(ConfigError);
  });
});

describe('resolving the rest of the configuration', () => {
  it('defaults the daemon to the port the daemon package declares', () => {
    const config = resolveConfig([], withToken);
    expect(config.daemonUrl).toBe(`http://127.0.0.1:${DEFAULT_DAEMON_PORT}`);
    expect(config.httpPort).toBe(DEFAULT_HTTP_PORT);
    expect(config.httpHost).toBe('127.0.0.1');
    expect(config.toolSeparator).toBe('.');
  });

  it('refuses to start with no producer token', () => {
    // Starting without one would produce eleven tools that all fail 401 at the
    // first call, which reads to a user as a broken bridge rather than as an
    // unset variable.
    expect(() => resolveConfig([], {})).toThrow(ConfigError);
    expect(() => resolveConfig([], { [PRODUCER_TOKEN_ENV]: '   ' })).toThrow(ConfigError);
  });

  it('takes flags over environment', () => {
    const config = resolveConfig(['--daemon-url', 'http://127.0.0.1:9999', '--port', '9100', '--project', 'p-1'], {
      ...withToken,
      [DAEMON_URL_ENV]: 'http://127.0.0.1:1111',
      [HTTP_PORT_ENV]: '2222',
      [PROJECT_ID_ENV]: 'p-2',
    });
    expect(config.daemonUrl).toBe('http://127.0.0.1:9999');
    expect(config.httpPort).toBe(9100);
    expect(config.defaultProjectId).toBe('p-1');
  });

  it('refuses a daemon URL that is not http', () => {
    expect(() => resolveConfig([], { ...withToken, [DAEMON_URL_ENV]: 'ws://127.0.0.1:7317' })).toThrow(ConfigError);
    expect(() => resolveConfig([], { ...withToken, [DAEMON_URL_ENV]: 'not a url' })).toThrow(ConfigError);
  });

  it('refuses a port that is not one', () => {
    expect(() => resolveConfig(['--port', '0'], withToken)).toThrow(ConfigError);
    expect(() => resolveConfig(['--port', '70000'], withToken)).toThrow(ConfigError);
    expect(() => resolveConfig(['--port', 'eight'], withToken)).toThrow(ConfigError);
    expect(() => resolveConfig(['--port'], withToken)).toThrow(ConfigError);
  });

  it('refuses a separator that is not one of the three', () => {
    expect(resolveConfig(['--tool-name-separator', '_'], withToken).toolSeparator).toBe('_');
    expect(() => resolveConfig(['--tool-name-separator', '/'], withToken)).toThrow(ConfigError);
  });
});

describe('what the HTTP binding exposes', () => {
  it('is loopback unless the operator names something else', () => {
    expect(bindsPublicly(resolveConfig([], withToken).httpHost)).toBe(false);
    expect(bindsPublicly(resolveConfig([], { ...withToken, [HTTP_HOST_ENV]: 'localhost' }).httpHost)).toBe(false);
    expect(bindsPublicly(resolveConfig([], { ...withToken, [HTTP_HOST_ENV]: '::1' }).httpHost)).toBe(false);
    expect(bindsPublicly(resolveConfig(['--host', '0.0.0.0'], withToken).httpHost)).toBe(true);
  });
});
