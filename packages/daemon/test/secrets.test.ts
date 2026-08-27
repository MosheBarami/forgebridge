import { describe, expect, it } from 'vitest';
import {
  EnvironmentSecrets,
  KeychainSecrets,
  LayeredSecrets,
  candidateVariableNames,
  defaultSecrets,
  environmentVariableName,
  serviceFor,
} from '../src/secrets.js';

const OPENROUTER = { scope: 'provider', name: 'openrouter' } as const;

describe('the environment backend', () => {
  it('reads our own name first and the provider\'s own name after it', async () => {
    expect(environmentVariableName(OPENROUTER)).toBe('FORGEBRIDGE_PROVIDER_OPENROUTER');
    expect(candidateVariableNames(OPENROUTER)).toEqual([
      'FORGEBRIDGE_PROVIDER_OPENROUTER',
      'OPENROUTER_API_KEY',
    ]);

    const both = new EnvironmentSecrets({
      FORGEBRIDGE_PROVIDER_OPENROUTER: 'ours',
      OPENROUTER_API_KEY: 'theirs',
    });
    expect(await both.get(OPENROUTER)).toBe('ours');

    const theirs = new EnvironmentSecrets({ OPENROUTER_API_KEY: 'theirs' });
    expect(await theirs.get(OPENROUTER)).toBe('theirs');
  });

  it('treats an empty or whitespace value as absent', async () => {
    // An exported-but-empty variable is the shape of a shell profile that did
    // not do what its author thought. Reading it as a credential would send an
    // empty bearer token and report the provider's refusal as our failure.
    expect(await new EnvironmentSecrets({ OPENROUTER_API_KEY: '' }).get(OPENROUTER)).toBeNull();
    expect(await new EnvironmentSecrets({ OPENROUTER_API_KEY: '   ' }).get(OPENROUTER)).toBeNull();
    expect(await new EnvironmentSecrets({}).get(OPENROUTER)).toBeNull();
  });

  it('lists names, never values', async () => {
    const secrets = new EnvironmentSecrets({
      FORGEBRIDGE_PROVIDER_ANTHROPIC: 'a',
      OPENROUTER_API_KEY: 'b',
      FORGEBRIDGE_SYSTEM_SPONSORED: 'c',
      PATH: '/usr/bin',
    });
    expect(await secrets.listNames('provider')).toEqual(['anthropic', 'openrouter']);
    expect(await secrets.listNames('system')).toEqual(['sponsored']);
    expect(await secrets.listNames('link')).toEqual([]);
  });

  it('refuses to pretend it can store one', async () => {
    const secrets = new EnvironmentSecrets({});
    await expect(secrets.set(OPENROUTER, 'x')).rejects.toThrow(/cannot store/);
    await expect(secrets.delete(OPENROUTER)).rejects.toThrow(/cannot remove/);
    expect(secrets.describe().readableByOtherProcesses).toBe(true);
  });
});

describe('the keychain backend', () => {
  function runner(results: Record<string, { code: number; stdout: string; stderr: string }>) {
    const calls: string[][] = [];
    return {
      calls,
      run: async (args: readonly string[]) => {
        calls.push([...args]);
        return results[args.join(' ')] ?? { code: 44, stdout: '', stderr: '' };
      },
    };
  }

  const found = `find-generic-password -s ${serviceFor(OPENROUTER)} -a openrouter -w`;

  it('reads a value, and reads absence as absence rather than as an error', async () => {
    const present = runner({ [found]: { code: 0, stdout: 'a-value\n', stderr: '' } });
    expect(await new KeychainSecrets({ run: present.run }).get(OPENROUTER)).toBe('a-value');

    const absent = runner({});
    expect(await new KeychainSecrets({ run: absent.run }).get(OPENROUTER)).toBeNull();
  });

  it('raises anything that is not a clean read or a clean miss', async () => {
    const broken = runner({ [found]: { code: 1, stdout: '', stderr: 'User interaction is not allowed.' } });
    await expect(new KeychainSecrets({ run: broken.run }).get(OPENROUTER)).rejects.toThrow(/User interaction/);
  });

  it('enumerates by probing known names, and never asks for the value while doing it', async () => {
    const probe = `find-generic-password -s ${serviceFor(OPENROUTER)} -a openrouter`;
    const present = runner({ [probe]: { code: 0, stdout: '', stderr: '' } });
    const secrets = new KeychainSecrets({ run: present.run, knownNames: { provider: ['openrouter'] } });

    expect(await secrets.listNames('provider')).toEqual(['openrouter']);
    expect(present.calls).toEqual([['find-generic-password', '-s', 'forgebridge.provider', '-a', 'openrouter']]);
    expect(present.calls[0]).not.toContain('-w');
  });

  it('says what to run rather than writing the value insecurely', async () => {
    const secrets = new KeychainSecrets({ run: runner({}).run });
    await expect(secrets.set(OPENROUTER, 'x')).rejects.toThrow(/add-generic-password/);
    await expect(secrets.delete(OPENROUTER)).rejects.toThrow(/delete-generic-password/);
  });
});

describe('the layered backend', () => {
  const nothing = new EnvironmentSecrets({});
  const something = new EnvironmentSecrets({ OPENROUTER_API_KEY: 'from-the-environment' });

  it('takes the first answer, in precedence order', async () => {
    expect(await new LayeredSecrets([nothing, something]).get(OPENROUTER)).toBe('from-the-environment');
    expect(await new LayeredSecrets([nothing, nothing]).get(OPENROUTER)).toBeNull();
  });

  it('reports the weakest posture of the layers, not the strongest', async () => {
    const keychain = new KeychainSecrets({ run: async () => ({ code: 44, stdout: '', stderr: '' }) });
    const layered = new LayeredSecrets([something, keychain]);
    // The environment layer is readable by any process this user runs, so the
    // pair is. A UI that showed the keychain's padlock here would be showing a
    // guarantee the chain does not give.
    expect(layered.describe().readableByOtherProcesses).toBe(true);
    expect(layered.describe().label).toContain('then');
  });

  it('is what the daemon defaults to, environment first', () => {
    expect(defaultSecrets().describe().kind).toBe('env');
  });
});
