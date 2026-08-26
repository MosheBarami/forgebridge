import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ErrorCode, ForgeBridgeError, HTTP_STATUS } from '@forgebridge/protocol';
import { CODE_GUIDANCE, DaemonRequestError, asProtocolError, codeOfFailure, toolFailure } from '../src/errors.js';

/**
 * The error mapping, which is the part of this connector a model reads most
 * often and the part most able to waste its time.
 *
 * Two properties matter. Every protocol code must arrive with something the
 * model can act on — a code with no guidance is a code that produces a retry
 * loop. And nothing that was not meant for a caller may leak: an unrecognised
 * throw becomes a detail-free `internal`, the same rule the daemon applies to
 * its own responses.
 */

describe('every protocol error code is mapped', () => {
  it('has guidance, with no gaps and no strays', () => {
    const codes = ErrorCode.options;
    expect(Object.keys(CODE_GUIDANCE).sort()).toEqual([...codes].sort());
    for (const code of codes) {
      expect(CODE_GUIDANCE[code].agentShould.length).toBeGreaterThan(20);
    }
  });

  it('carries the code, the status, the remedy and the retry advice into the result', () => {
    const result = toolFailure(
      new ForgeBridgeError('stale_base', 'built against version 3; the project is at 7', 'Rebuild against version 7.'),
    );
    const body = JSON.parse(result.content[0]!.text.slice(result.content[0]!.text.indexOf('{'))) as {
      error: Record<string, unknown>;
    };

    expect(result.isError).toBe(true);
    expect(body.error['code']).toBe('stale_base');
    expect(body.error['httpStatus']).toBe(HTTP_STATUS.stale_base);
    expect(body.error['remedy']).toBe('Rebuild against version 7.');
    expect(body.error['retryable']).toBe(false);
    expect(body.error['agentShould']).toMatch(/rebase|rebuild/i);
  });

  it('does not tell an agent to retry a refusal that will never change its mind', () => {
    for (const code of ['policy_violation', 'invalid_request', 'stale_base', 'too_large'] as const) {
      expect(CODE_GUIDANCE[code].retryable).toBe(false);
    }
    for (const code of ['rate_limited', 'link_unpaired', 'not_approved'] as const) {
      expect(CODE_GUIDANCE[code].retryable).toBe(true);
    }
  });
});

describe('what crosses the boundary', () => {
  it('passes a daemon ProtocolError through untouched', () => {
    const payload = { code: 'policy_violation' as const, message: 'outside the allowed paths', remedy: 'Stay inside them.' };
    expect(asProtocolError(new DaemonRequestError(payload, 403))).toEqual(payload);
  });

  it('turns a schema failure into invalid_request naming the field', () => {
    const parsed = z.object({ changeSetId: z.string().uuid() }).safeParse({ changeSetId: 'nope' });
    expect(parsed.success).toBe(false);
    const error = asProtocolError(parsed.success ? null : parsed.error);
    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('changeSetId');
  });

  it('never lets an unrecognised throw carry its own message out', () => {
    const leaky = new Error('ECONNREFUSED /opt/forgebridge/state/secrets.sqlite');
    const error = asProtocolError(leaky);

    expect(error.code).toBe('internal');
    expect(error.message).not.toContain('secrets.sqlite');
    expect(error.message).not.toContain('/opt/');
  });

  it('never carries a stack trace', () => {
    const error = new Error('boom');
    error.stack = 'Error: boom\n    at Object.<anonymous> (/opt/forgebridge/src/x.ts:1:1)';
    const result = toolFailure(error);
    expect(result.content[0]?.text).not.toContain('at Object');
    expect(result.content[0]?.text).not.toContain('.ts:');
  });

  it('is machine-readable enough to branch on', () => {
    expect(codeOfFailure(toolFailure(new ForgeBridgeError('link_unpaired', 'no studio')))).toBe('link_unpaired');
  });

  it('clips a schema failure to the protocol message ceiling', () => {
    const parsed = z.object({ summary: z.string().max(1) }).safeParse({ summary: 'x'.repeat(4000) });
    const error = asProtocolError(parsed.success ? null : parsed.error);
    expect(error.message.length).toBeLessThanOrEqual(500);
  });
});
