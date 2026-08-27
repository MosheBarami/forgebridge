/**
 * `POST /v1/runs` on a transport that runs no models.
 *
 * The daemon's run route calls `executeRun` from `@forgebridge/core`, holds the
 * user's provider credential, orders candidate models and computes a verdict
 * over what came back. The relay does none of that and must not: ADR-006 puts
 * key custody on the user's machine, ADR-010's whole cost argument is that the
 * default path spends nothing of ours, and a relay holding provider keys for
 * every user is the single most valuable target this project could build.
 *
 * But the route still has to exist, because ADR-004 freezes the surface and the
 * plugin's producer — the web app — is configured with one base URL. So the
 * relay does what a pipe does: it applies the gates that protect the money
 * (M45, `abuse/`), hands the request to whatever run service the operator wired
 * behind this port, and forwards the answer back without reading it.
 *
 * "Without reading it" is literal. `RunDispatchResponse.body` is `unknown` and
 * is serialised straight through. The relay does not parse `RunResponse`, does
 * not restate the core's routing vocabulary, and therefore cannot start
 * refusing a field the pipeline added last week — which is what a pipe with a
 * schema of its own eventually does.
 *
 * With no port wired, `POST /v1/runs` answers `provider_unconfigured` and names
 * BYOK and the local daemon. That is the same answer the daemon gives with no
 * model client wired, and it is the honest one: the route exists, the
 * capability does not, and nothing was silently queued or downgraded.
 */

export interface RunDispatchRequest {
  /** Which relay session is asking. Every dispatch is scoped to one. */
  sessionId: string;
  projectId: string;
  /**
   * The request body as it arrived, minus nothing.
   *
   * The relay validated only `prompt` and `projectId` (see `RelayRunRequest`);
   * everything else — routing policy, pinned model, streaming — is the run
   * service's to understand.
   */
  body: unknown;
  /** The verified account the sponsored run was granted to, when there was one. */
  sponsoredFor: { userId: string } | null;
  signal: AbortSignal;
}

export interface RunDispatchResponse {
  /** HTTP status to forward. */
  status: number;
  /** Body to forward, serialised as JSON. Never inspected. */
  body: unknown;
}

export interface RunEventFrame {
  event: string;
  data: unknown;
  id?: number;
}

export interface RunDispatchPort {
  /** Named in refusals so an operator can tell which service answered. */
  readonly name: string;

  startRun(request: RunDispatchRequest): Promise<RunDispatchResponse>;

  /** `GET /v1/runs/:id`. Scoped to the session, or the relay leaks other tenants' runs. */
  runStatus(request: { sessionId: string; runId: string; signal: AbortSignal }): Promise<RunDispatchResponse>;

  /**
   * `GET /v1/runs/:id/events`. Optional: a run service that cannot stream is a
   * service whose runs are still readable by polling `GET /v1/runs/:id`, and
   * the relay says so in a `closed` frame rather than by hanging up — a stream
   * that stops without a word is indistinguishable from one with more to say.
   */
  runEvents?(request: {
    sessionId: string;
    runId: string;
    since: number;
    signal: AbortSignal;
  }): AsyncIterable<RunEventFrame>;
}
