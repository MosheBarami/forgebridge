import { describe, expect, it } from 'vitest';
import {
  LOCAL_FREE_REASON,
  LOCAL_RUNTIMES,
  LocalModel,
  ProviderId,
  UNKNOWN_CONTEXT_TOKENS,
  capabilitiesFromRuntime,
  deriveFree,
  localCandidate,
  localSnapshotRow,
} from '../src/index.js';

/**
 * Locally-served models (M24).
 *
 * The claim this file defends is narrow and it is the one ADR-007 cares about:
 * a local model is called free for a *stated* reason — nobody bills for it —
 * and not by running a price nobody published through the price-based
 * derivation. The test that matters most is the last one in the first block: it
 * takes the zeroed pricing a local candidate carries, feeds it to `deriveFree`,
 * and shows that the answer would have been the same for a paid model that
 * happens to bill per song. That is why the two paths are separate.
 */

function model(over: Partial<LocalModel> = {}): LocalModel {
  return {
    id: 'qwen3:8b',
    provider: 'ollama',
    displayName: 'qwen3:8b',
    endpoint: 'http://127.0.0.1:11434/v1',
    contextTokens: null,
    capabilities: [],
    discoveredAt: '2026-08-27T09:00:00.000Z',
    ...over,
  };
}

describe('a local model is free for a stated reason, not a derived one', () => {
  it('says why in words that do not mention a price', () => {
    expect(localSnapshotRow(model())).toMatchObject({
      free: true,
      freeReason: LOCAL_FREE_REASON,
      pricing: null,
    });
    expect(LOCAL_FREE_REASON).not.toMatch(/token-priced/);
  });

  it('carries no pricing into the snapshot, so nothing can render a price nobody quoted', () => {
    expect(localSnapshotRow(model())['pricing']).toBeNull();
    expect(localSnapshotRow(model())['local']).toBe(true);
  });

  it('CONTROL: the zeroed pricing on a candidate is not what makes it free', () => {
    // `deriveFree` given the same zeros returns free — which is exactly the
    // trap: it would return free for a music model billed $0.08 a song too,
    // because a synthesised `unit: 'token'` is an assertion, not an observation.
    // The local path never asks it.
    const asIfCatalogued = deriveFree({
      pricing: { inputPerMTok: 0, outputPerMTok: 0, unit: 'token' },
      outputModalities: ['text'],
    });
    expect(asIfCatalogued.free).toBe(true);
    expect(asIfCatalogued.reason).not.toBe(LOCAL_FREE_REASON);
  });
});

describe('nothing about a discovered model is invented', () => {
  it('hands the router zero for a context window the runtime did not report', () => {
    expect(localCandidate(model()).contextTokens).toBe(UNKNOWN_CONTEXT_TOKENS);
    // Zero is chosen for its effect: any run stating a minimum filters it out.
    expect(UNKNOWN_CONTEXT_TOKENS).toBe(0);
  });

  it('keeps the honest null in the snapshot, so a UI says unknown rather than zero', () => {
    expect(localSnapshotRow(model())['contextTokens']).toBeNull();
  });

  it('passes a reported context window through unchanged', () => {
    expect(localCandidate(model({ contextTokens: 32_768 })).contextTokens).toBe(32_768);
    expect(localSnapshotRow(model({ contextTokens: 32_768 }))['contextTokens']).toBe(32_768);
  });

  it('leaves capabilities empty when the runtime reported none, so the router will not offer it', () => {
    const candidate = localCandidate(model());
    expect(candidate.capabilities).toEqual([]);
    // The router requires `tools` to drive a ChangeSet. An empty list is the
    // fail-closed answer to "we do not know".
    expect(candidate.capabilities).not.toContain('tools');
  });

  it('never claims an expiry it has no basis for', () => {
    expect(localCandidate(model()).expiresAt).toBeNull();
    expect(localCandidate(model()).expiringSoon).toBe(false);
  });
});

describe('capabilities reported by a runtime', () => {
  it('maps the names the router branches on and drops the rest', () => {
    expect(capabilitiesFromRuntime(['completion', 'tools', 'vision'])).toEqual(['tools', 'vision']);
  });

  it('drops anything unrecognised rather than passing it through as a capability', () => {
    // The registry's capability vocabulary is closed on purpose: the router
    // branches on it. A runtime word nobody has mapped is not a capability.
    expect(capabilitiesFromRuntime(['thinking', 'embedding', 'insert'])).toEqual([]);
    expect(capabilitiesFromRuntime([42, null, { tools: true }])).toEqual([]);
  });

  it('does not repeat a capability a runtime listed twice', () => {
    expect(capabilitiesFromRuntime(['tools', 'TOOLS'])).toEqual(['tools']);
  });
});

describe('the shape', () => {
  it('validates a well-formed local model', () => {
    expect(LocalModel.safeParse(model()).success).toBe(true);
  });

  it('refuses a runtime it does not know, because a probe gains one only by code', () => {
    expect(LocalModel.safeParse(model({ provider: 'some-new-runtime' as never })).success).toBe(false);
  });

  it('refuses a context window of zero — unknown is null, and zero would be a claim', () => {
    expect(LocalModel.safeParse(model({ contextTokens: 0 })).success).toBe(false);
  });

  it('gives every runtime a slug the catalog would accept as a provider id', () => {
    for (const runtime of LOCAL_RUNTIMES) {
      expect(ProviderId.safeParse(runtime).success).toBe(true);
    }
  });
});
