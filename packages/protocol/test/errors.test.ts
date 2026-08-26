import { describe, it, expect } from 'vitest';
import { ErrorCode, HTTP_STATUS, ForgeBridgeError } from '../src/errors.js';
import { attemptSummary } from '../src/run.js';
import { isCompatible } from '../src/version.js';
import { PAIRING_ALPHABET, PairingCode } from '../src/link.js';

describe('errors', () => {
  it('maps every error code to a status', () => {
    for (const code of ErrorCode.options) {
      expect(typeof HTTP_STATUS[code]).toBe('number');
    }
  });

  it('never leaks a detail through internal', () => {
    const error = new ForgeBridgeError('internal', 'Something went wrong on our side.');
    const payload = error.toPayload();
    expect(error.status).toBe(500);
    expect(payload.message).not.toMatch(/select |\/Users\/|at Object\./);
  });

  it('carries a remedy when one is given', () => {
    const error = new ForgeBridgeError('stale_base', 'The place changed since this was built.', 'Rebase and resubmit.');
    expect(error.toPayload().remedy).toBe('Rebase and resubmit.');
    expect(error.status).toBe(409);
  });
});

describe('run log', () => {
  it('renders the fallback chain honestly', () => {
    const at = { startedAt: '2026-08-26T12:00:00.000Z', durationMs: 10 };
    expect(attemptSummary([
      { modelId: 'z-ai/glm-5.2:free', outcome: 'rate-limited', ...at },
      { modelId: 'minimax/minimax-m3:free', outcome: 'ok', ...at },
    ])).toBe('z-ai/glm-5.2:free → rate-limited → minimax/minimax-m3:free');
  });

  it('says so when nothing ran', () => {
    expect(attemptSummary([])).toBe('no model attempted');
  });
});

describe('version', () => {
  it('refuses a cross-major apply', () => {
    expect(isCompatible(1, 1)).toBe(true);
    expect(isCompatible(2, 1)).toBe(false);
  });
});

describe('pairing alphabet', () => {
  it('has exactly 30 distinct symbols', () => {
    expect(new Set(PAIRING_ALPHABET).size).toBe(PAIRING_ALPHABET.length);
    expect(PAIRING_ALPHABET.length).toBe(30);
  });

  it('excludes every confusable character', () => {
    for (const excluded of ['I', 'L', 'O', 'U', '0', '1']) {
      expect(PAIRING_ALPHABET).not.toContain(excluded);
    }
  });

  it('validates exactly what the generator can mint — no more', () => {
    // Regression: a hand-written character class readmitted "L", so a code the
    // generator could never produce would have passed validation.
    expect(PairingCode.safeParse('ABCDEFGH').success).toBe(true);
    for (const impossible of ['LLLLLLLL', 'ABCDEFGL', 'ABCDEFG0', 'ABCDEFG1', 'ABCDEFGI', 'ABCDEFGU']) {
      expect(PairingCode.safeParse(impossible).success).toBe(false);
    }
  });

  it('refuses a code of the wrong length', () => {
    expect(PairingCode.safeParse('ABCDEFG').success).toBe(false);
    expect(PairingCode.safeParse('ABCDEFGHJ').success).toBe(false);
  });
});
