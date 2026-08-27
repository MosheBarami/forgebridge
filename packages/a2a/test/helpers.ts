import { randomUUID } from 'node:crypto';
import { ChangeSet, ForgeBridgeError, type Validation } from '@forgebridge/protocol';
import type { ApplyApprovalGrant, ApprovalGrant, RollbackApprovalGrant } from '../src/approval.js';
import type { ForgeBridgeBackend, StartRunRequest } from '../src/backend.js';
import type {
  ApproveResponse,
  DiffResponse,
  LinkStatusResponse,
  ModelsResponse,
  ProposeResponse,
  RollbackResponse,
  RunResponse,
} from '../src/daemon-wire.js';
import { SKILL_INVOCATION_EXTENSION_URI, type SkillId } from '../src/skills.js';
import { A2A_EXTENSIONS_HEADER, A2A_PROTOCOL_VERSION, A2A_VERSION_HEADER, type Message } from '../src/spec.js';
import { A2AServer, type A2AServerOptions } from '../src/server.js';

export const okValidation: Validation = {
  luau: { status: 'ok', findings: [] },
  policy: { status: 'ok', violations: [] },
  computedAt: '2026-01-01T00:00:00.000Z',
  computedBy: 'forgebridge-daemon@0.1.0',
};

export function makeChangeSet(overrides: Record<string, unknown> = {}): ChangeSet {
  // Built through the frozen schema, so a fixture that drifts from the contract
  // fails here rather than inside a handler.
  return ChangeSet.parse({
    id: randomUUID(),
    projectId: randomUUID(),
    baseVersion: 0,
    summary: 'add a shop script',
    operations: [
      { op: 'writeScript', path: 'ServerScriptService.Shop', scriptType: 'Script', source: 'print("hello")' },
    ],
    createdAt: new Date().toISOString(),
    ...overrides,
  });
}

/**
 * The digest `FakeBackend.diff` reports, and the one an apply grant in these
 * tests carries. A constant rather than a random value so that a test which
 * means "the approver read a different set" has to say so explicitly.
 */
export const FAKE_CONTENT_DIGEST = 'sha256:fake-digest-of-the-reviewed-operations';

export interface BackendCall {
  method: keyof ForgeBridgeBackend;
  argument: unknown;
  grant?: ApprovalGrant;
}

/**
 * A backend that records what it was asked to do.
 *
 * The recording is what most of the approval tests assert against: the question
 * "could a remote caller cause an approve?" is answered by looking at whether
 * `approve` was ever reached, not by inspecting a return value.
 */
export class FakeBackend implements ForgeBridgeBackend {
  readonly calls: BackendCall[] = [];
  /** Set to make the next call of that method throw instead of returning. */
  failures = new Map<keyof ForgeBridgeBackend, unknown>();

  async startRun(request: StartRunRequest): Promise<RunResponse> {
    this.#record('startRun', request);
    const changeSetId = randomUUID();
    return {
      run: {
        id: randomUUID(),
        projectId: request.projectId ?? randomUUID(),
        stage: 'awaiting-approval',
        status: 'running',
        // Two attempts, never one: a fake whose run only tried the model that
        // worked would let a connector reporting the winner alone pass every
        // assertion about the attempt list (ADR-008).
        attempts: [
          { modelId: 'glm-5.2:free', outcome: 'rate-limited', startedAt: '2026-01-01T00:00:00.000Z', durationMs: 900 },
          { modelId: 'minimax-m3:free', outcome: 'ok', startedAt: '2026-01-01T00:00:01.000Z', durationMs: 4200 },
        ],
        changeSetIds: [changeSetId],
      },
      plan: { steps: ['write one script'] },
      changeSetId,
      // `validated`, never `approved`: a run stops at the human gate.
      changeSetStatus: 'validated',
      contentDigest: FAKE_CONTENT_DIGEST,
      validation: okValidation,
      skipped: [],
      ordering: null,
      failure: null,
    };
  }

  async propose(changeSet: ChangeSet): Promise<ProposeResponse> {
    this.#record('propose', changeSet);
    return {
      changeSetId: changeSet.id,
      status: 'validated',
      baseVersion: changeSet.baseVersion,
      validation: okValidation,
    };
  }

  async diff(changeSetId: string): Promise<DiffResponse> {
    this.#record('diff', changeSetId);
    return {
      changeSetId,
      projectId: randomUUID(),
      summary: 'add a shop script',
      status: 'validated',
      baseVersion: 0,
      currentVersion: 0,
      stale: false,
      counts: { total: 1, creates: 0, setProperties: 0, scripts: 1, moves: 0, deletes: 0 },
      contentDigest: FAKE_CONTENT_DIGEST,
      operations: [{ index: 0, op: 'writeScript', summary: 'write Script ServerScriptService.Shop' }],
      validation: okValidation,
    };
  }

  async approve(grant: ApplyApprovalGrant): Promise<ApproveResponse> {
    this.calls.push({ method: 'approve', argument: grant.subject, grant });
    this.#maybeThrow('approve');
    return { changeSetId: grant.subject, status: 'approved', nonce: 1 };
  }

  async rollback(
    grant: RollbackApprovalGrant,
    request: { journalId: string; expectedVersion: number; reason?: string },
  ): Promise<RollbackResponse> {
    this.calls.push({ method: 'rollback', argument: request, grant });
    this.#maybeThrow('rollback');
    return { journalId: request.journalId, changeSetId: randomUUID(), status: 'dispatched', nonce: 2 };
  }

  async models(): Promise<ModelsResponse> {
    this.#record('models', undefined);
    return { configured: true, source: 'test registry', verifiedAt: '2026-01-01T00:00:00.000Z', models: [{ id: 'm' }] };
  }

  async linkStatus(): Promise<LinkStatusResponse> {
    this.#record('linkStatus', undefined);
    return {
      transport: 'local-daemon',
      privacyPosture: 'nothing leaves this machine',
      protocolVersion: '1.0.0',
      defaultProjectId: randomUUID(),
      links: [],
      pairing: null,
    };
  }

  /** Every call this backend saw of one method. */
  callsTo(method: keyof ForgeBridgeBackend): BackendCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  failNext(method: keyof ForgeBridgeBackend, error: unknown): void {
    this.failures.set(method, error);
  }

  #record(method: keyof ForgeBridgeBackend, argument: unknown): void {
    this.calls.push({ method, argument });
    this.#maybeThrow(method);
  }

  #maybeThrow(method: keyof ForgeBridgeBackend): void {
    const error = this.failures.get(method);
    if (error !== undefined) {
      this.failures.delete(method);
      throw error;
    }
  }
}

export function forgeBridgeError(code: ForgeBridgeError['code'], message = 'nope', remedy?: string): ForgeBridgeError {
  return new ForgeBridgeError(code, message, remedy);
}

/** A well-formed A2A message carrying a ForgeBridge skill invocation. */
export function invocationMessage(skill: SkillId, input: unknown, overrides: Partial<Message> = {}): Message {
  return {
    messageId: randomUUID(),
    role: 'ROLE_USER',
    parts: [{ data: { skill, input }, mediaType: 'application/json' }],
    ...overrides,
  };
}

export interface StartedServer {
  server: A2AServer;
  port: number;
  backend: FakeBackend;
  /** Raw JSON-RPC call over HTTP with valid headers unless overridden. */
  rpc(
    method: string,
    params?: unknown,
    options?: { headers?: Record<string, string>; id?: string | number | null; declareExtension?: boolean },
  ): Promise<{ status: number; body: any; headers: Headers }>;
}

export async function startServer(
  overrides: Partial<A2AServerOptions> = {},
  backend: FakeBackend = new FakeBackend(),
): Promise<StartedServer> {
  const server = new A2AServer({
    backend,
    endpointUrl: 'https://forgebridge.test/a2a/v1',
    bearerToken: 'test-token',
    // Port 0 so the suite never fights the real default port or itself.
    port: 0,
    ...overrides,
  });
  const { port } = await server.listen();

  return {
    server,
    port,
    backend,
    async rpc(method, params, options = {}) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        authorization: 'Bearer test-token',
        [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
        ...(options.declareExtension === false ? {} : { [A2A_EXTENSIONS_HEADER]: SKILL_INVOCATION_EXTENSION_URI }),
        ...options.headers,
      };
      const response = await fetch(`http://127.0.0.1:${port}/a2a/v1`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: options.id === undefined ? 1 : options.id,
          method,
          ...(params === undefined ? {} : { params }),
        }),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text.length > 0 ? JSON.parse(text) : undefined,
        headers: response.headers,
      };
    },
  };
}
