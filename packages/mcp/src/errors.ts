import { z } from 'zod';
import { ErrorCode, ForgeBridgeError, HTTP_STATUS, ProtocolError } from '@forgebridge/protocol';

/**
 * Turning a ForgeBridge failure into something a calling model can act on.
 *
 * Two different things are called "an error" here and they are not
 * interchangeable:
 *
 *   - A **protocol-level** JSON-RPC error means the call itself was malformed —
 *     no such tool, arguments that do not fit the schema. The client sees a
 *     transport failure; the model usually never sees the text.
 *   - A **tool result** carrying `isError: true` means the tool ran and the
 *     answer is a refusal. The model sees it, and can fix its own input.
 *
 * Everything ForgeBridge refuses is the second kind. `stale_base` is not a
 * malformed call — it is the protocol telling the caller to rebase, which is an
 * instruction the model is the one able to follow. Reporting it as a transport
 * error would hide the one sentence that resolves it.
 *
 * No stack trace ever crosses this boundary. An unrecognised throw becomes a
 * bare `internal` with no detail, exactly as the daemon's own `writeError`
 * does: a message that leaks a path out of a process holding the user's token
 * is a finding, not a debugging convenience.
 */

/** JSON-RPC 2.0 reserved codes, for the malformed-call cases. */
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

/**
 * What the calling agent should do next, per protocol error code.
 *
 * This text is written for a model, not for a log reader. `retryable` says
 * whether repeating the same call unchanged could ever succeed — an agent that
 * retries `policy_violation` in a loop is burning the user's time on a refusal
 * that is never going to change its mind.
 */
export interface CodeGuidance {
  readonly retryable: boolean;
  readonly agentShould: string;
}

export const CODE_GUIDANCE: Record<z.infer<typeof ErrorCode>, CodeGuidance> = {
  invalid_request: {
    retryable: false,
    agentShould: 'Fix the arguments named in the message and call again. Do not repeat the same arguments.',
  },
  stale_base: {
    retryable: false,
    agentShould:
      'The place changed underneath this ChangeSet. Read the current version, rebuild the operations against it, and propose again. Never resubmit the same baseVersion.',
  },
  not_approved: {
    retryable: true,
    agentShould:
      'A human has not cleared this work — an unapproved ChangeSet, or a rollback nobody asked for. Report the id named in the message to the user and ask them to clear it in Roblox Studio or in their ForgeBridge client. Do not attempt to approve it yourself and do not try a different id; no tool on this server can approve anything.',
  },
  policy_violation: {
    retryable: false,
    agentShould:
      'The project policy refuses these paths or this source. Read the violations, keep the work inside the allowed paths, and propose a different ChangeSet.',
  },
  link_unpaired: {
    retryable: true,
    agentShould:
      'No Roblox Studio session is paired with this project. Ask the user to open Studio with the ForgeBridge plugin and pair it, then try again.',
  },
  link_unauthenticated: {
    retryable: false,
    agentShould:
      'This server is not authenticated to the daemon. Tell the user to check the producer token in their MCP client configuration against the one the daemon printed.',
  },
  replay_detected: {
    retryable: false,
    agentShould: 'A delivery was replayed. Stop and report this to the user; it is not something to work around.',
  },
  too_large: {
    retryable: false,
    agentShould: 'Split the work into several smaller ChangeSets and propose them in order.',
  },
  rate_limited: { retryable: true, agentShould: 'Wait before calling again, and reduce how often you poll.' },
  budget_exhausted: {
    retryable: false,
    agentShould: "The day's sponsored capacity is spent. Tell the user, and do not retry.",
  },
  provider_unconfigured: {
    retryable: false,
    agentShould: 'No model provider is usable for this request. Tell the user to configure one.',
  },
  unsupported_version: {
    retryable: false,
    agentShould: 'The client and the daemon disagree on the protocol version. Tell the user to update one of them.',
  },
  not_found: { retryable: false, agentShould: 'The thing named does not exist here. Check the id, or read what does exist first.' },
  internal: { retryable: true, agentShould: 'Something failed on the ForgeBridge side. Report it to the user rather than retrying in a loop.' },
};

/** A `/v1` response that carried a `ProtocolError` body. */
export class DaemonRequestError extends Error {
  constructor(
    readonly payload: ProtocolError,
    readonly status: number,
  ) {
    super(payload.message);
    this.name = 'DaemonRequestError';
  }
}

/**
 * Normalise anything thrown inside a tool into the protocol's own error shape.
 *
 * A `ZodError` becomes `invalid_request` because that is what it is: the
 * arguments did not fit the contract. Everything unrecognised becomes a
 * detail-free `internal` — deliberately uninformative, because the alternative
 * is leaking whatever the runtime happened to put in `.message`.
 */
export function asProtocolError(error: unknown): ProtocolError {
  if (error instanceof DaemonRequestError) return error.payload;
  if (error instanceof ForgeBridgeError) return error.toPayload();
  if (error instanceof z.ZodError) {
    const issues = error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    const more = error.issues.length > 3 ? ` (+${error.issues.length - 3} more)` : '';
    return {
      code: 'invalid_request',
      message: clip(`arguments failed schema validation — ${issues}${more}`, 500),
      remedy: 'Fix the fields named above and call the tool again.',
    };
  }
  return { code: 'internal', message: 'the ForgeBridge MCP server failed to handle this call' };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** One content block of an MCP tool result. Only text is used here. */
export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  content: TextContent[];
  isError?: boolean;
  /**
   * MCP's `CallToolResult` is an open object — the spec lets a result carry
   * `_meta` and fields a later revision adds — so the SDK infers it with an
   * index signature. Without one here a `ToolResult` is not assignable to it,
   * and `server.ts` deliberately assigns `McpServer` to `McpServerLike`
   * uncast so that mismatch is a compile error rather than a cast.
   */
  [key: string]: unknown;
}

export function textResult(value: unknown): ToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

/**
 * A refusal the model can read: the protocol's code, the daemon's own message
 * and remedy, and the instruction for what to do about it.
 *
 * Emitted as one JSON object rather than prose so that a client which shows the
 * user raw tool output still shows something structured, and so an agent that
 * branches on the code has a stable field to branch on.
 */
export function toolFailure(error: unknown): ToolResult {
  const payload = asProtocolError(error);
  const guidance = CODE_GUIDANCE[payload.code];
  const body = {
    error: {
      code: payload.code,
      httpStatus: HTTP_STATUS[payload.code],
      message: payload.message,
      ...(payload.remedy ? { remedy: payload.remedy } : {}),
      retryable: guidance.retryable,
      agentShould: guidance.agentShould,
    },
  };
  return {
    content: [{ type: 'text', text: `ForgeBridge refused this call: ${payload.message}\n\n${JSON.stringify(body, null, 2)}` }],
    isError: true,
  };
}

/**
 * Any failure this connector can produce, reduced to the code a caller branches
 * on — and to whether the connector actually recognised it.
 *
 * That second field is the one worth stating. An unrecognised failure reported
 * as `internal` is correct: the protocol's answer for "we do not know" is
 * `internal`, and a connector that reported a socket timeout as, say,
 * `not_approved` would be inventing an approval decision out of a network
 * event. So `recognised: false` travels with the default rather than being
 * inferred from the code, because `internal` is also a real answer the daemon
 * sends.
 *
 * Four shapes reach here, and all four are real:
 *
 *   - a `DaemonRequestError`, which is how every `/v1` refusal arrives;
 *   - a `ForgeBridgeError`, which is how a tool refuses on its own account —
 *     `forge.read_tree`, `forge.rollback` without a clearance;
 *   - a failed `ToolResult`, which is what a caller *outside* this process
 *     sees, since `registerForgeBridgeTools` turns a throw into one;
 *   - a bare `ProtocolError` payload, which is what an embedder holds after
 *     parsing a response body itself.
 *
 * A classifier that understood only its own error class would have a mapping
 * that works in its own tests and nowhere else.
 */
export interface FailureView {
  code: z.infer<typeof ErrorCode>;
  /** False only when nothing in the failure named a protocol code. */
  recognised: boolean;
  httpStatus: number;
  message: string;
  remedy?: string;
}

export function classifyFailure(error: unknown): FailureView {
  const recognised = (payload: ProtocolError): FailureView => ({
    code: payload.code,
    recognised: true,
    httpStatus: HTTP_STATUS[payload.code],
    message: payload.message,
    ...(payload.remedy ? { remedy: payload.remedy } : {}),
  });

  if (error instanceof DaemonRequestError) return recognised(error.payload);
  if (error instanceof ForgeBridgeError) return recognised(error.toPayload());
  if (error instanceof z.ZodError) return recognised(asProtocolError(error));

  // A failed tool result — what a caller on the other side of the transport
  // actually holds, since the registration wrapper turns every throw into one.
  // Read whole rather than for its code alone: `remedy` is the field written
  // for the caller, and a classifier that dropped it would hand back the one
  // half of a refusal nobody can act on.
  if (isToolResult(error) && error.isError === true) {
    const body = failureBodyOf(error);
    if (body) return recognised(body);
  }

  const payload = ProtocolError.safeParse(error);
  if (payload.success) return recognised(payload.data);

  // A protocol code inside a wrapper — how an error usually arrives once it has
  // been through somebody else's transport.
  const wrapped = error as { code?: unknown; payload?: { code?: unknown } } | null | undefined;
  const nested = ErrorCode.safeParse(wrapped?.code ?? wrapped?.payload?.code);
  if (nested.success) {
    return { code: nested.data, recognised: true, httpStatus: HTTP_STATUS[nested.data], message: '' };
  }

  return {
    code: 'internal',
    recognised: false,
    httpStatus: HTTP_STATUS.internal,
    message: 'the ForgeBridge MCP server could not classify this failure',
  };
}

function isToolResult(value: unknown): value is ToolResult {
  return typeof value === 'object' && value !== null && Array.isArray((value as ToolResult).content);
}

/**
 * The `ProtocolError` a failed tool result carries, parsed back out of the JSON
 * `toolFailure` embedded in its text.
 *
 * Null when the result is not one of ours, or carries a code the protocol does
 * not name — in which case the caller falls through to `internal`, rather than
 * this function inventing a code out of whatever string it found.
 */
export function failureBodyOf(result: ToolResult): ProtocolError | null {
  const text = result.content[0]?.text ?? '';
  const start = text.indexOf('{');
  if (start === -1) return null;
  let parsed: { error?: { code?: unknown; message?: unknown; remedy?: unknown } };
  try {
    parsed = JSON.parse(text.slice(start)) as typeof parsed;
  } catch {
    return null;
  }
  const code = ErrorCode.safeParse(parsed.error?.code);
  if (!code.success) return null;
  return {
    code: code.data,
    message: typeof parsed.error?.message === 'string' ? parsed.error.message : '',
    ...(typeof parsed.error?.remedy === 'string' ? { remedy: parsed.error.remedy } : {}),
  };
}

/** The protocol code carried by a tool failure, for tests and for callers that branch. */
export function codeOfFailure(result: ToolResult): string | null {
  return failureBodyOf(result)?.code ?? null;
}
