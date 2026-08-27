import { randomUUID } from 'node:crypto';
import {
  ChangeSet,
  ErrorCode,
  ForgeBridgeError,
  HTTP_STATUS,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  ProtocolError,
} from '@forgebridge/protocol';
import { PRODUCER_TOKEN_HEADER } from '@forgebridge/daemon';
import type {
  ConnectorAdapter,
  ConnectorApplyReport,
  ConnectorDiff,
  ConnectorErrorView,
  ConnectorLinkStatus,
  ConnectorProject,
  ConnectorProposal,
  ConnectorRun,
  ConnectorTree,
  ProposeInput,
  RunInput,
} from '../adapter.js';

/**
 * The reference adapter: the daemon's own `/v1` REST surface, wearing the
 * conformance interface.
 *
 * It exists for three reasons, in this order.
 *
 * 1. To prove the suite runs against something real. A suite that has only ever
 *    been pointed at a fake is a suite whose fake is the specification.
 * 2. To give a connector author a worked example short enough to read in one
 *    sitting: this file is the whole of what MCP, A2A, the CLI and the SDKs are
 *    each doing behind their own vocabulary.
 * 3. To pin the daemon. `POST /v1/runs` has since landed, and `startRun` below
 *    is what that looked like from here: the case stopped being `unsupported`
 *    the day the route arrived, and it would have failed rather than gone along
 *    with it had the shape differed from the one the protocol describes. The
 *    tree read is the same bet still outstanding — `readTree` refuses in the
 *    protocol's own words today and returns a snapshot the day `/v1` serves one.
 *
 * ── The absence that matters ─────────────────────────────────────────────────
 *
 * There is no `approve()` here either, for the reason `packages/mcp/src/
 * daemon-client.ts` states at length: this adapter stands in for the connector,
 * and a connector holding the handle on both sides of the approval gate is the
 * gate switched off (ADR-012). Approval in this suite comes from
 * `daemonHumanApproval`, which is a separate object the adapter cannot reach.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DaemonRestAdapterOptions {
  /** Base URL of the daemon, e.g. `http://127.0.0.1:7317`. */
  baseUrl: string;
  /** The producer token the daemon printed when it started. */
  producerToken: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  newId?: () => string;
  now?: () => Date;
  /**
   * Whether this adapter offers a run surface at all.
   *
   * Off by default, and the default is the point. `POST /v1/runs` calls a
   * language model: pointed at a daemon holding somebody's OpenRouter key it
   * spends their credit, and every other call this adapter makes is a read or a
   * proposal that changes nothing anyone has to pay for. So a run is something
   * the operator asks for — `forgebridge-conformance --run` — and when they have
   * not, `run-reports-every-attempt` is reported `unsupported` because this
   * adapter genuinely declares no `startRun`, not because the route is missing.
   */
  runs?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** The one path this adapter refuses to build, whatever it is handed. */
const FORBIDDEN_PATH_FRAGMENT = '/approve';

/** The daemon's rendered diff, as far as this adapter reads it. */
interface RawDiff {
  changeSetId: string;
  projectId: string;
  summary: string;
  status: string;
  baseVersion: number;
  currentVersion: number;
  stale: boolean;
  counts?: { total: number };
  contentDigest?: string;
  operations: Array<{ index: number; op: string; summary?: string; destructive?: boolean }>;
  validation?: unknown;
}

export class DaemonRestAdapter implements ConnectorAdapter {
  readonly name = '@forgebridge/conformance reference adapter (daemon /v1 REST)';

  /**
   * Present only when the adapter was constructed with `runs: true`.
   *
   * Declared as an optional property rather than a method so that its absence
   * is a real absence: the suite asks `adapter.startRun?` and gets nothing,
   * which is a different fact from a method that exists and refuses.
   */
  readonly startRun?: (input: RunInput) => Promise<ConnectorRun>;

  readonly #baseUrl: string;
  readonly #producerToken: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #newId: () => string;
  readonly #now: () => Date;

  constructor(options: DaemonRestAdapterOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#producerToken = options.producerToken;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#newId = options.newId ?? randomUUID;
    this.#now = options.now ?? ((): Date => new Date());
    if (options.runs) this.startRun = (input): Promise<ConnectorRun> => this.#startRun(input);
  }

  async linkStatus(): Promise<ConnectorLinkStatus> {
    const status = (await this.#request('GET', '/v1/link')) as {
      transport: ConnectorLinkStatus['transport'];
      privacyPosture: string;
      protocolVersion: string;
      defaultProjectId?: string;
      links?: Array<{ id: string; projectId: string; state: string }>;
    };
    return {
      transport: status.transport,
      privacyPosture: status.privacyPosture,
      protocolVersion: status.protocolVersion,
      defaultProjectId: status.defaultProjectId ?? null,
      links: (status.links ?? []).map((link) => ({ linkId: link.id, projectId: link.projectId, state: link.state })),
    };
  }

  /**
   * Projects, assembled from the links the daemon reports plus its default.
   *
   * The daemon has no project list endpoint and no per-project tree version, so
   * `currentVersion` is left off rather than guessed — an adapter that reported
   * a version it had invented would make `propose-returns-id-and-diff` check a
   * number nobody published. TODO(M31) names the additive `/v1` read that would
   * let this be a lookup; the owner is the protocol maintainer.
   */
  async listProjects(): Promise<ConnectorProject[]> {
    const status = await this.linkStatus();
    const ids = new Set<string>(status.links.map((link) => link.projectId));
    if (status.defaultProjectId) ids.add(status.defaultProjectId);

    return [...ids].map((projectId) => ({
      projectId,
      isDefault: projectId === status.defaultProjectId,
      links: status.links.filter((link) => link.projectId === projectId),
    }));
  }

  /**
   * Refused, in the protocol's own words.
   *
   * The local daemon holds no tree snapshot and `/v1` serves none — the same
   * answer `forge.read_tree` gives, for the same reason. The suite reads this
   * refusal, checks that it is a protocol error carrying a remedy, and records
   * the case as `unsupported`. The day a snapshot endpoint lands, this method
   * returns a tree and the case passes.
   */
  async readTree(_projectId: string): Promise<ConnectorTree> {
    throw new ForgeBridgeError(
      'not_found',
      'this ForgeBridge transport serves no tree snapshot',
      'Ask the user for the instance paths you need. A tree read needs a /v1 endpoint that does not exist yet (M09 owns the snapshot, M31 agrees the wire shape).',
    );
  }

  async propose(input: ProposeInput): Promise<ConnectorProposal> {
    // Built through the frozen schema rather than assembled as a literal, so a
    // malformed proposal fails here — where the message names the field — and
    // not as a 400 the connector author has to decode.
    const changeSet = ChangeSet.parse({
      id: this.#newId(),
      projectId: input.projectId,
      baseVersion: input.baseVersion,
      summary: input.summary,
      operations: input.operations,
      createdAt: this.#now().toISOString(),
      // Forwarded untouched when the caller supplies one. The daemon overwrites
      // it with the verdict it computed (PROTOCOL invariant 4); forwarding is
      // what lets the suite prove that from the outside.
      ...(input.claimedValidation ? { validation: input.claimedValidation } : {}),
    });

    const submitted = (await this.#request('POST', '/v1/changesets', changeSet)) as {
      changeSetId?: string;
      status?: string;
      validation?: unknown;
    };
    const changeSetId = submitted.changeSetId ?? changeSet.id;

    return {
      changeSetId,
      status: (submitted.status ?? 'proposed') as ConnectorProposal['status'],
      validation: (submitted.validation ?? null) as ConnectorProposal['validation'],
      diff: await this.diff(changeSetId),
    };
  }

  async diff(changeSetId: string): Promise<ConnectorDiff> {
    const raw = (await this.#request('GET', `/v1/changesets/${encodeURIComponent(changeSetId)}/diff`)) as RawDiff;
    return {
      changeSetId: raw.changeSetId,
      projectId: raw.projectId,
      status: raw.status,
      baseVersion: raw.baseVersion,
      currentVersion: raw.currentVersion,
      stale: raw.stale,
      summary: raw.summary,
      operations: raw.operations,
      ...(raw.counts ? { counts: raw.counts } : {}),
      ...(raw.contentDigest ? { contentDigest: raw.contentDigest } : {}),
      validation: (raw.validation ?? null) as ConnectorDiff['validation'],
    };
  }

  /**
   * Report on a ChangeSet a human has already approved.
   *
   * The branch table is the whole of it, and it is the same one
   * `forge.apply_changeset` uses: the status the daemon holds decides the
   * answer, and every status that is not "a human cleared this" ends in
   * `not_approved`. An unrecognised status ends there too — failing closed is
   * the only safe default for the one gate standing between a model and
   * someone's place.
   */
  async apply(changeSetId: string): Promise<ConnectorApplyReport> {
    const diff = await this.diff(changeSetId);

    switch (diff.status) {
      case 'approved':
      case 'applying':
        return {
          changeSetId,
          status: diff.status,
          accepted: true,
          message: 'A human approved this ChangeSet and the daemon has queued it for the paired Studio session.',
        };

      case 'applied':
      case 'partial':
      case 'failed':
        return {
          changeSetId,
          status: diff.status,
          accepted: true,
          message: `This ChangeSet has already been dispatched and reported back as "${diff.status}".`,
          // TODO(M31): `/v1` records the per-operation ApplyResult but exposes
          // no producer route that returns it, so `outcomes` is left off rather
          // than reconstructed from the status. Owner: the protocol maintainer,
          // as an additive `/v1` read — `apply-refused-without-approval` does
          // not need it, and inventing one here would be this adapter making up
          // a shape the relay would make up differently.
        };

      case 'stale':
        throw new ForgeBridgeError(
          'stale_base',
          'the place moved after this ChangeSet was built, so it can no longer be applied',
          'Rebuild the operations against the current version and propose a new ChangeSet.',
        );

      default:
        throw new ForgeBridgeError(
          'not_approved',
          `changeset ${changeSetId} has not been approved (status: ${diff.status})`,
          'Ask the user to review the diff and approve it in Roblox Studio or in their ForgeBridge client. Approval is a human action; no call on this adapter can perform it (ADR-012).',
        );
    }
  }

  /**
   * `POST /v1/runs` — a prompt in, a proposed ChangeSet out, nothing applied.
   *
   * The whole attempt list is forwarded, in the order the router tried the
   * models, because that list is the reason the route answers 201 with a
   * `failure` field instead of an HTTP error: a `ProtocolError` body has
   * nowhere to put it (ADR-008). An adapter that reported only
   * `resolvedModelId` would be discarding the record of who actually wrote the
   * code.
   *
   * A run that never started — no model client, no candidate — refuses with
   * `provider_unconfigured`, and the suite reads that as a gap in the
   * deployment rather than a breach by the connector. A run that started and
   * then failed is not a refusal: it answers 201 with every attempt listed, and
   * lands here as a run whose status is `failed`.
   *
   * `timeoutMs` applies to this call as it does to every other, and a real run
   * against a real provider can outlast the 30s default. An operator pointing
   * this at a live daemon should raise it rather than read the abort as the
   * daemon being down.
   */
  async #startRun(input: RunInput): Promise<ConnectorRun> {
    const response = (await this.#request('POST', '/v1/runs', {
      prompt: input.prompt,
      projectId: input.projectId,
      producer: { kind: 'rest', client: 'forgebridge conformance reference adapter' },
    })) as {
      run: {
        id: string;
        stage: string;
        status: string;
        attempts: ConnectorRun['attempts'];
        changeSetIds?: string[];
      };
    };

    return {
      runId: response.run.id,
      stage: response.run.stage,
      status: response.run.status,
      attempts: response.run.attempts,
      changeSetIds: response.run.changeSetIds ?? [],
    };
  }

  /**
   * Every failure this adapter can produce, reduced to the code a caller
   * branches on — from a thrown `ForgeBridgeError`, from a `ProtocolError`
   * payload straight off the wire, and from anything else at all.
   *
   * The third case is the one worth stating: an unrecognised failure is
   * `internal` and `recognised: false`. Reporting a socket timeout as, say,
   * `not_approved` would be this adapter inventing an approval decision out of
   * a network event.
   */
  describeError(error: unknown): ConnectorErrorView {
    if (error instanceof ForgeBridgeError) {
      return {
        code: error.code,
        recognised: true,
        transportCode: HTTP_STATUS[error.code],
        message: error.message,
        ...(error.remedy ? { remedy: error.remedy } : {}),
      };
    }

    const payload = ProtocolError.safeParse(error);
    if (payload.success) {
      return {
        code: payload.data.code,
        recognised: true,
        transportCode: HTTP_STATUS[payload.data.code],
        message: payload.data.message,
        ...(payload.data.remedy ? { remedy: payload.data.remedy } : {}),
      };
    }

    // A shape carrying a protocol code inside a wrapper — how a connector's own
    // error class usually arrives once it has been through a transport.
    const nested = (error as { code?: unknown; payload?: { code?: unknown } } | null | undefined);
    const candidate = nested?.code ?? nested?.payload?.code;
    const parsed = ErrorCode.safeParse(candidate);
    if (parsed.success) {
      return { code: parsed.data, recognised: true, transportCode: HTTP_STATUS[parsed.data] };
    }

    return {
      code: 'internal',
      recognised: false,
      transportCode: HTTP_STATUS.internal,
      message: error instanceof Error ? `${error.name}: ${error.message}` : 'a non-error was thrown',
    };
  }

  async #request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    // Belt to the structural braces: no method above builds an approve path, but
    // the check costs nothing and it fails loudly if someone adds one later
    // without reading the note at the top of this file.
    if (path.includes(FORBIDDEN_PATH_FRAGMENT)) {
      throw new ForgeBridgeError(
        'not_approved',
        'the conformance adapter does not make approval requests',
        'Approval is a human action taken in Roblox Studio or in a ForgeBridge client (ADR-012).',
      );
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      [PRODUCER_TOKEN_HEADER]: this.#producerToken,
      [PROTOCOL_VERSION_HEADER]: PROTOCOL_VERSION,
    };
    // The daemon insists on this content type as a CSRF control, so a body
    // without it is refused before it is read.
    if (body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      // TODO(M31): the protocol's ErrorCode has no "the transport is not
      // reachable" member, so this lands on `internal` and carries the truth in
      // its remedy — the same gap `packages/mcp/src/daemon-client.ts` and
      // `packages/daemon/src/auth.ts` both name. Owner: the protocol
      // maintainer. When a code is added, `error-codes-total` covers it the day
      // it lands, because that case iterates `ErrorCode.options` rather than a
      // list written here.
      throw new ForgeBridgeError(
        'internal',
        `the ForgeBridge daemon at ${this.#baseUrl} did not answer (${cause instanceof Error ? cause.name : 'unknown error'})`,
        'Start the daemon with the forgebridge-daemon binary, and check the base URL this adapter was given.',
      );
    }

    if (response.status === 204) return null;

    const text = await response.text();
    if (!response.ok) throw errorFor(response.status, text);
    if (text === '') return null;

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ForgeBridgeError('internal', 'the daemon returned a body that is not JSON');
    }
  }
}

/**
 * The daemon answers every failure with a `ProtocolError`, so the code it chose
 * is passed through untouched — re-deriving one from the HTTP status would
 * throw away the distinction between the four codes that share a status.
 */
function errorFor(status: number, text: string): ForgeBridgeError {
  let parsedBody: unknown = null;
  try {
    parsedBody = JSON.parse(text) as unknown;
  } catch {
    parsedBody = null;
  }
  const parsed = ProtocolError.safeParse(parsedBody);
  if (parsed.success) return new ForgeBridgeError(parsed.data.code, parsed.data.message, parsed.data.remedy);
  return new ForgeBridgeError(status === 404 ? 'not_found' : 'internal', `the daemon answered ${status}`);
}
