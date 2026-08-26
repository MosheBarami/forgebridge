import { describe, expect, it } from 'vitest';
import { ChangeSet, ProtocolError } from '@forgebridge/protocol';
import { MAX_ERROR_MESSAGE_CHARS, invalidRequest } from '../src/http.js';

/** The ZodError a real request produces, not one hand-built to be long. */
function rejectionOf(value: unknown) {
  const result = ChangeSet.safeParse(value);
  if (result.success) throw new Error('expected this fixture to be rejected');
  return result.error;
}

function changeSetWith(operations: unknown[]): unknown {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    projectId: '00000000-0000-4000-8000-000000000001',
    baseVersion: 0,
    summary: 'oversized',
    operations,
    createdAt: new Date().toISOString(),
  };
}

describe('invalidRequest', () => {
  it('stays inside the 500 characters ProtocolError.message allows', () => {
    // The offending property key is interpolated into the Zod message verbatim
    // and nothing bounds it before it is rejected, so the caller would
    // otherwise be choosing the size of the error it gets back.
    const error = invalidRequest(
      'changeset',
      rejectionOf(
        changeSetWith([
          {
            op: 'createInstance',
            path: 'Workspace.Crate',
            className: 'Part',
            properties: { [`a${'x'.repeat(10_000)}`]: { t: 'Bool', v: true } },
          },
        ]),
      ),
    );

    expect(error.message.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_CHARS);
    expect(ProtocolError.safeParse(error.toPayload()).success).toBe(true);
  });

  it('stays inside the cap when several issues are long at once', () => {
    const error = invalidRequest(
      'changeset',
      rejectionOf(
        changeSetWith(
          Array.from({ length: 3 }, (_, i) => ({
            op: 'createInstance',
            path: 'Workspace.Crate',
            className: 'Part',
            properties: { [`a${i}${'x'.repeat(4_000)}`]: { t: 'Bool', v: true } },
          })),
        ),
      ),
    );

    expect(error.message.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_CHARS);
    expect(ProtocolError.safeParse(error.toPayload()).success).toBe(true);
  });

  it('still names the field a human has to fix', () => {
    const error = invalidRequest('changeset', rejectionOf({ id: 'not-a-uuid' }));
    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('id');
    expect(error.remedy).toBeTruthy();
  });
});
