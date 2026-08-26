import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ForgeBridgeError } from '@forgebridge/protocol';
import { DaemonBackend } from '../src/backend.js';
import type { ApplyApprovalGrant } from '../src/approval.js';
import { makeChangeSet, okValidation } from './helpers.js';

/**
 * The translation onto the daemon's `/v1` surface.
 *
 * ADR-009 says a connector holds no business logic, which is a claim about
 * these six methods: each one is a URL, a body and a parse. What is worth
 * testing is therefore not behaviour but *fidelity* — that the right endpoint
 * is called, that the producer token rides along, that the approve body is
 * built from the grant and nothing else, and that the daemon's own error words
 * survive the trip rather than being replaced by an HTTP status.
 */

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function backendWith(
  respond: (recorded: Recorded) => { status: number; body: unknown },
): { backend: DaemonBackend; seen: Recorded[] } {
  const seen: Recorded[] = [];
  const fetchImpl = (async (input: any, init: any) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    const recorded: Recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
    };
    seen.push(recorded);
    const { status, body } = respond(recorded);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;

  return {
    backend: new DaemonBackend({
      baseUrl: 'http://127.0.0.1:7317/',
      producerToken: 'producer-secret',
      fetch: fetchImpl,
    }),
    seen,
  };
}

const grant: ApplyApprovalGrant = {
  skill: 'apply-approved-changeset',
  subject: '11111111-1111-4111-8111-111111111111',
  approvedBy: 'operator@workstation',
  contentDigest: 'sha256:the-digest-the-diff-reported',
  confirmBulkDelete: true,
  note: 'reviewed',
};

describe('daemon endpoint fidelity', () => {
  it('proposes to POST /v1/changesets carrying the producer token', async () => {
    const changeSet = makeChangeSet();
    const { backend, seen } = backendWith(() => ({
      status: 201,
      body: { changeSetId: changeSet.id, status: 'validated', baseVersion: 0, validation: okValidation },
    }));

    await backend.propose(changeSet);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('http://127.0.0.1:7317/v1/changesets');
    expect(seen[0]?.headers['x-forgebridge-token']).toBe('producer-secret');
    expect((seen[0]?.body as { id: string }).id).toBe(changeSet.id);
  });

  it('reads a diff from GET /v1/changesets/:id/diff', async () => {
    const id = randomUUID();
    const { backend, seen } = backendWith(() => ({
      status: 200,
      body: {
        changeSetId: id,
        projectId: randomUUID(),
        summary: 's',
        status: 'validated',
        baseVersion: 0,
        currentVersion: 0,
        stale: false,
        counts: { total: 0, creates: 0, setProperties: 0, scripts: 0, moves: 0, deletes: 0 },
        operations: [],
      },
    }));

    await backend.diff(id);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.url).toBe(`http://127.0.0.1:7317/v1/changesets/${id}/diff`);
  });

  it('builds the approve body out of the grant, and out of nothing else', async () => {
    const { backend, seen } = backendWith(() => ({
      status: 202,
      body: { changeSetId: grant.subject, status: 'approved', nonce: 1 },
    }));

    await backend.approve(grant);
    expect(seen[0]?.url).toBe(`http://127.0.0.1:7317/v1/changesets/${grant.subject}/approve`);
    expect(seen[0]?.body).toEqual({
      contentDigest: 'sha256:the-digest-the-diff-reported',
      approvedBy: 'operator@workstation',
      confirmBulkDelete: true,
      note: 'reviewed',
    });
  });

  it('carries the digest the approver was shown, so the daemon can bind the yes to it', async () => {
    // The daemon refuses an approve whose digest does not match the operations
    // it holds. Sending the grant's digest is what makes this connector's
    // approve a statement about reviewed content rather than about an id, and
    // the field can only have come from `record` — there is no path from an A2A
    // request to it.
    const { backend, seen } = backendWith(() => ({
      status: 202,
      body: { changeSetId: grant.subject, status: 'approved', nonce: 1 },
    }));

    await backend.approve({ ...grant, contentDigest: 'sha256:what-the-human-actually-read' });
    expect((seen[0]?.body as { contentDigest: string }).contentDigest).toBe('sha256:what-the-human-actually-read');
  });

  it('defaults confirmBulkDelete to false when the approver did not confirm one', async () => {
    const { backend, seen } = backendWith(() => ({
      status: 202,
      body: { changeSetId: grant.subject, status: 'approved', nonce: 1 },
    }));

    await backend.approve({
      skill: 'apply-approved-changeset',
      subject: grant.subject,
      approvedBy: 'a human',
      contentDigest: 'sha256:the-digest-the-diff-reported',
    });
    expect((seen[0]?.body as { confirmBulkDelete: boolean }).confirmBulkDelete).toBe(false);
  });

  it('rolls back through POST /v1/journal/:id/rollback', async () => {
    const journalId = randomUUID();
    const { backend, seen } = backendWith(() => ({
      status: 202,
      body: { journalId, changeSetId: randomUUID(), status: 'dispatched', nonce: 4 },
    }));

    await backend.rollback(
      { skill: 'rollback-apply', subject: journalId, approvedBy: 'a human' },
      { journalId, expectedVersion: 9, reason: 'broke spawns' },
    );
    expect(seen[0]?.url).toBe(`http://127.0.0.1:7317/v1/journal/${journalId}/rollback`);
    expect(seen[0]?.body).toEqual({ journalId, expectedVersion: 9, reason: 'broke spawns' });
  });

  it('escapes an identifier rather than letting it shape the path', async () => {
    // A ChangeSet id reaches this function from a remote agent's payload. If it
    // were interpolated raw, "../../.." would address a different endpoint --
    // and the one next door dispatches rollbacks.
    const { backend, seen } = backendWith(() => ({ status: 404, body: { code: 'not_found', message: 'no' } }));
    await expect(backend.diff('../../v1/journal/x')).rejects.toThrow(ForgeBridgeError);
    expect(seen[0]?.url).toBe('http://127.0.0.1:7317/v1/changesets/..%2F..%2Fv1%2Fjournal%2Fx/diff');
  });
});

describe('daemon failures survive the trip intact', () => {
  it('rebuilds the daemon’s code, message and remedy', async () => {
    const { backend } = backendWith(() => ({
      status: 409,
      body: {
        code: 'stale_base',
        message: 'changeset was built against version 3; the project is at 7',
        remedy: 'Rebuild against version 7 and resubmit.',
      },
    }));

    await expect(backend.propose(makeChangeSet())).rejects.toMatchObject({
      code: 'stale_base',
      remedy: 'Rebuild against version 7 and resubmit.',
    });
  });

  it('reports a body it cannot recognise as a version mismatch, not an internal error', async () => {
    // Almost always what it is: a daemon newer or older than this connector.
    // "internal error" would send an operator looking in the wrong place.
    const { backend } = backendWith(() => ({ status: 200, body: { unexpected: true } }));
    await expect(backend.models()).rejects.toMatchObject({ code: 'unsupported_version' });
  });

  it('reports an unreachable daemon as provider_unconfigured with something actionable', async () => {
    const backend = new DaemonBackend({
      baseUrl: 'http://127.0.0.1:7317',
      producerToken: 'producer-secret',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof globalThis.fetch,
    });

    await expect(backend.linkStatus()).rejects.toMatchObject({ code: 'provider_unconfigured' });
    await backend.linkStatus().catch((error: ForgeBridgeError) => {
      expect(error.remedy).toContain('daemon is running');
    });
  });

  it('does not repeat an HTTP status back as a protocol error when there is no payload', async () => {
    const { backend } = backendWith(() => ({ status: 502, body: 'gateway' }));
    await expect(backend.models()).rejects.toMatchObject({ code: 'internal' });
  });
});
