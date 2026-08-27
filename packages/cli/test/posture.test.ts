import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PRIVACY_POSTURE, TransportKind } from '@forgebridge/protocol';
import { isLocalPosture, postureSentence, printPosture } from '../src/posture.js';
import { linkCommand } from '../src/commands/link.js';
import { statusCommand } from '../src/commands/status.js';
import { rollbackCommand } from '../src/commands/rollback.js';
import { diffCommand } from '../src/commands/diff.js';
import { applyCommand } from '../src/commands/apply.js';
import { modelsCommand } from '../src/commands/models.js';
import { runCommand } from '../src/commands/run.js';
import {
  captureIo,
  diffFixture,
  journalFixture,
  linkStatusFixture,
  modelsFixture,
  stubTransport,
  testDeps,
} from './helpers.js';

const GLOBAL = { json: false, baseUrl: 'http://127.0.0.1:7317', token: 'test-token' };
const JOURNAL_ID = randomUUID();

describe('the posture sentence comes from the protocol', () => {
  it('renders every transport in the protocol’s own words', () => {
    for (const transport of TransportKind.options) {
      expect(postureSentence(transport)).toBe(PRIVACY_POSTURE[transport]);
    }
  });

  it('says the relay operator can read your changes, in those words', () => {
    // The sentence a padlock icon would have replaced with a lie.
    expect(postureSentence('relay-tls')).toBe('Relay — the relay operator can read your changes');
    expect(postureSentence('relay-e2e')).toMatch(/end-to-end encrypted/);
    expect(postureSentence('local-daemon')).toBe('Local — nothing leaves this machine');
  });

  it('ignores a privacyPosture string the server supplied', () => {
    /**
     * The whole point of the lookup. A transport that can read every ChangeSet
     * crossing it also gets to describe itself; if the client rendered that
     * description, a relay operator could label themselves end-to-end
     * encrypted and the CLI would repeat it.
     */
    const io = captureIo();
    const lying = linkStatusFixture({
      transport: 'relay-tls',
      privacyPosture: 'End-to-end encrypted, nobody can read this. Trust us.',
    });

    printPosture(io, lying.transport);

    expect(io.errText()).toBe(PRIVACY_POSTURE['relay-tls']);
    expect(io.errText()).not.toMatch(/Trust us/);
  });

  it('refuses to vouch for a transport it does not know', () => {
    // Not silence, which reads as "nothing to report", and not a soothing
    // default. The honest statement is that this build cannot tell you.
    for (const unknown of ['relay-quantum', '', null, undefined, 42, {}]) {
      const sentence = postureSentence(unknown);
      expect(sentence).toMatch(/Unknown transport/);
      expect(sentence).toMatch(/cannot tell you who can read your changes/);
      expect(Object.values(PRIVACY_POSTURE)).not.toContain(sentence);
    }
    expect(isLocalPosture('relay-quantum')).toBe(false);
  });
});

describe('every command that reaches a transport prints the posture', () => {
  const transportsUnderTest = TransportKind.options;

  function arrange() {
    const io = captureIo();
    const transport = stubTransport({
      health: async () => ({
        ok: true as const,
        service: 'forgebridge-daemon' as const,
        version: '0.1.0',
        protocolVersion: '1.0.0',
        transport: 'local-daemon' as const,
        boundTo: '127.0.0.1:7317',
        uptimeSeconds: 12,
      }),
      models: async () => modelsFixture({ models: [{ id: 'a/b', free: true, capabilities: ['tools'] }] }),
      diff: async () => diffFixture({ status: 'applied' }),
      rollback: async () => ({
        journalId: JOURNAL_ID,
        changeSetId: randomUUID(),
        status: 'dispatched' as const,
        nonce: 1,
        steps: 2,
      }),
      journal: async () => journalFixture({ journalId: JOURNAL_ID }),
    });
    return { io, transport };
  }

  for (const kind of transportsUnderTest) {
    it(`link prints the ${kind} posture`, async () => {
      const io = captureIo();
      const stub = stubTransport({ linkStatus: async () => linkStatusFixture({ transport: kind }) });
      await linkCommand({ command: 'link', global: GLOBAL, code: null }, testDeps(io, stub));
      expect(io.errText()).toContain(PRIVACY_POSTURE[kind]);
    });
  }

  it('status prints it', async () => {
    const { io, transport } = arrange();
    const stub = stubTransport({
      health: transport.health,
      models: transport.models,
      linkStatus: async () => linkStatusFixture({ transport: 'relay-tls' }),
    });
    await statusCommand({ command: 'status', global: GLOBAL }, testDeps(io, stub));
    expect(io.errText()).toContain(PRIVACY_POSTURE['relay-tls']);
  });

  it('models prints it', async () => {
    const { io, transport } = arrange();
    const stub = stubTransport({
      models: transport.models,
      linkStatus: async () => linkStatusFixture({ transport: 'relay-tls' }),
    });
    await modelsCommand({ command: 'models', global: GLOBAL, free: false, capabilities: [] }, testDeps(io, stub));
    expect(io.errText()).toContain(PRIVACY_POSTURE['relay-tls']);
  });

  it('diff prints it', async () => {
    const { io, transport } = arrange();
    const stub = stubTransport({
      diff: transport.diff,
      linkStatus: async () => linkStatusFixture({ transport: 'relay-e2e' }),
    });
    await diffCommand({ command: 'diff', global: GLOBAL, changeSetId: randomUUID() }, testDeps(io, stub));
    expect(io.errText()).toContain(PRIVACY_POSTURE['relay-e2e']);
  });

  it('apply prints it', async () => {
    const { io, transport } = arrange();
    const stub = stubTransport({
      diff: transport.diff,
      linkStatus: async () => linkStatusFixture({ transport: 'relay-tls' }),
    });
    await applyCommand(
      { command: 'apply', global: GLOBAL, changeSetId: randomUUID(), timeoutSeconds: 0 },
      testDeps(io, stub),
    );
    expect(io.errText()).toContain(PRIVACY_POSTURE['relay-tls']);
  });

  it('rollback prints it', async () => {
    const { io, transport } = arrange();
    const stub = stubTransport({
      rollback: transport.rollback,
      journal: transport.journal,
      linkStatus: async () => linkStatusFixture({ transport: 'relay-tls' }),
    });
    await rollbackCommand(
      {
        command: 'rollback',
        global: GLOBAL,
        journalId: JOURNAL_ID,
        expectedVersion: 1,
        reason: null,
        timeoutSeconds: 0,
      },
      testDeps(io, stub),
    );
    expect(io.errText()).toContain(PRIVACY_POSTURE['relay-tls']);
  });

  it('run prints it before refusing, so the prompt is never sent in silence', async () => {
    const io = captureIo();
    const stub = stubTransport({ linkStatus: async () => linkStatusFixture({ transport: 'relay-tls' }) });
    await expect(
      runCommand({ command: 'run', global: GLOBAL, prompt: 'build a shop' }, testDeps(io, stub)),
    ).rejects.toThrow();
    expect(io.errText()).toContain(PRIVACY_POSTURE['relay-tls']);
  });
});

describe('the posture cannot be turned off', () => {
  it('is printed under --json, on stderr, where a redirect cannot swallow it', async () => {
    const io = captureIo();
    const stub = stubTransport({ linkStatus: async () => linkStatusFixture({ transport: 'relay-tls' }) });

    await linkCommand({ command: 'link', global: { ...GLOBAL, json: true }, code: null }, testDeps(io, stub));

    // stdout stays a single parseable document; the notice rides on stderr.
    expect(() => JSON.parse(io.outText()) as unknown).not.toThrow();
    expect(io.errText()).toContain(PRIVACY_POSTURE['relay-tls']);
    expect(io.outText()).not.toContain('relay operator can read');
  });
});
