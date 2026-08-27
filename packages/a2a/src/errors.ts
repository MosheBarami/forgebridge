import type { ErrorCode as ForgeBridgeErrorCode, ProtocolError } from '@forgebridge/protocol';
import { ErrorCode as ForgeBridgeErrorCodeSchema, ForgeBridgeError, ProtocolError as ProtocolErrorSchema } from '@forgebridge/protocol';
import type { TaskState } from './spec.js';

/**
 * Errors, in both directions.
 *
 * A2A splits failure into two layers and the split is load-bearing, so this
 * file keeps them apart:
 *
 *   1. **Protocol failure** — the request itself was unusable: an unknown
 *      method, an unparseable body, a task id that does not exist. These are
 *      JSON-RPC error objects (§9.5) and no task is created or changed.
 *
 *   2. **Execution failure** — a task was accepted and then did not succeed.
 *      This is *not* a JSON-RPC error. §3.3.3 says operations return a Task and
 *      processing continues; a run that fails does so by reaching
 *      `TASK_STATE_FAILED` or `TASK_STATE_REJECTED`, with the reason in the
 *      status message. Returning `-32603` because a ChangeSet was stale would
 *      tell the caller its *request* was broken, which is a different and
 *      wrong fact.
 *
 * Everything the daemon rejects is layer 2. Everything this connector rejects
 * before it has a task is layer 1.
 */

/** §9.5, "Standard JSON-RPC Error Codes", with the spec's own message strings. */
export const JSONRPC_ERRORS = {
  parse: { code: -32700, message: 'Invalid JSON payload' },
  invalidRequest: { code: -32600, message: 'Request payload validation error' },
  methodNotFound: { code: -32601, message: 'Method not found' },
  invalidParams: { code: -32602, message: 'Invalid parameters' },
  internal: { code: -32603, message: 'Internal error' },
} as const;

/**
 * §5.4, "Error Code Mappings". The A2A-specific range is `-32001` to `-32099`;
 * these nine are the codes the specification assigns names to.
 */
export const A2A_ERRORS = {
  taskNotFound: { code: -32001, message: 'Task not found', reason: 'TASK_NOT_FOUND' },
  taskNotCancelable: { code: -32002, message: 'Task not cancelable', reason: 'TASK_NOT_CANCELABLE' },
  pushNotificationNotSupported: {
    code: -32003,
    message: 'Push notifications are not supported',
    reason: 'PUSH_NOTIFICATION_NOT_SUPPORTED',
  },
  unsupportedOperation: { code: -32004, message: 'Unsupported operation', reason: 'UNSUPPORTED_OPERATION' },
  contentTypeNotSupported: { code: -32005, message: 'Content type not supported', reason: 'CONTENT_TYPE_NOT_SUPPORTED' },
  invalidAgentResponse: { code: -32006, message: 'Invalid agent response', reason: 'INVALID_AGENT_RESPONSE' },
  extendedAgentCardNotConfigured: {
    code: -32007,
    message: 'Extended agent card is not configured',
    reason: 'EXTENDED_AGENT_CARD_NOT_CONFIGURED',
  },
  extensionSupportRequired: { code: -32008, message: 'Extension support required', reason: 'EXTENSION_SUPPORT_REQUIRED' },
  versionNotSupported: { code: -32009, message: 'Version not supported', reason: 'VERSION_NOT_SUPPORTED' },
} as const;

/** The `domain` on `google.rpc.ErrorInfo` details the specification itself owns (§9.5 example). */
export const A2A_ERROR_DOMAIN = 'a2a-protocol.org' as const;

/** The `domain` for a failure that came out of ForgeBridge rather than out of A2A. */
export const FORGEBRIDGE_ERROR_DOMAIN = 'forgebridge.protocol' as const;

/**
 * One entry of a JSON-RPC `error.data` array. §9.5: each object **MUST** carry
 * an `@type` naming its type, in ProtoJSON `Any` form.
 */
export interface ErrorDetail {
  '@type': string;
  [key: string]: unknown;
}

export function errorInfo(reason: string, domain: string, metadata?: Record<string, string>): ErrorDetail {
  return {
    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
    reason,
    domain,
    ...(metadata ? { metadata } : {}),
  };
}

export function badRequest(violations: readonly { field: string; description: string }[]): ErrorDetail {
  return {
    '@type': 'type.googleapis.com/google.rpc.BadRequest',
    fieldViolations: violations.map((violation) => ({ ...violation })),
  };
}

/** A layer-1 failure: it becomes a JSON-RPC `error` object and creates no task. */
export class A2AProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly details: readonly ErrorDetail[] = [],
  ) {
    super(message);
    this.name = 'A2AProtocolError';
  }

  toJsonRpcError(): { code: number; message: string; data?: ErrorDetail[] } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details.length > 0 ? { data: [...this.details] } : {}),
    };
  }
}

export function taskNotFound(taskId: string): A2AProtocolError {
  // §3.3.2: a not-found and a not-authorised are reported identically, so that
  // probing this endpoint cannot enumerate the tasks of other callers.
  const spec = A2A_ERRORS.taskNotFound;
  return new A2AProtocolError(spec.code, spec.message, [
    errorInfo(spec.reason, A2A_ERROR_DOMAIN, { taskId }),
  ]);
}

export function taskNotCancelable(taskId: string, state: TaskState): A2AProtocolError {
  const spec = A2A_ERRORS.taskNotCancelable;
  return new A2AProtocolError(spec.code, spec.message, [
    errorInfo(spec.reason, A2A_ERROR_DOMAIN, { taskId, state }),
  ]);
}

/**
 * §3.3.4: an operation whose capability the Agent Card does not declare must be
 * refused with `UnsupportedOperationError`. This connector declares `streaming`
 * and `extendedAgentCard` absent, so `SendStreamingMessage`, `SubscribeToTask`
 * and `GetExtendedAgentCard` all land here rather than being "not implemented".
 */
export function unsupportedOperation(operation: string, detail: string): A2AProtocolError {
  const spec = A2A_ERRORS.unsupportedOperation;
  return new A2AProtocolError(spec.code, `${spec.message}: ${detail}`, [
    errorInfo(spec.reason, A2A_ERROR_DOMAIN, { operation }),
  ]);
}

/** §3.3.4: `pushNotifications` is not declared, so every push config method is refused. */
export function pushNotificationNotSupported(operation: string): A2AProtocolError {
  const spec = A2A_ERRORS.pushNotificationNotSupported;
  return new A2AProtocolError(spec.code, spec.message, [
    errorInfo(spec.reason, A2A_ERROR_DOMAIN, { operation }),
  ]);
}

/** §3.6.2: an unsupported `Major.Minor` is refused, not silently accepted. */
export function versionNotSupported(requested: string, supported: string): A2AProtocolError {
  const spec = A2A_ERRORS.versionNotSupported;
  return new A2AProtocolError(
    spec.code,
    `${spec.message}: this interface speaks A2A ${supported}; the request declared ${requested}`,
    [errorInfo(spec.reason, A2A_ERROR_DOMAIN, { requested, supported })],
  );
}

export function invalidParams(message: string, details: readonly ErrorDetail[] = []): A2AProtocolError {
  return new A2AProtocolError(JSONRPC_ERRORS.invalidParams.code, `${JSONRPC_ERRORS.invalidParams.message}: ${message}`, details);
}

export function methodNotFound(method: string): A2AProtocolError {
  return new A2AProtocolError(JSONRPC_ERRORS.methodNotFound.code, JSONRPC_ERRORS.methodNotFound.message, [
    errorInfo('METHOD_NOT_FOUND', A2A_ERROR_DOMAIN, { method }),
  ]);
}

// ─────────────────── layer 2: ForgeBridge failures become task states ───────────────────

/**
 * Which terminal state a ForgeBridge failure lands in.
 *
 * The distinction the specification draws is about *whose* problem it is.
 * `TASK_STATE_REJECTED` is "the agent has decided to not perform the task" —
 * the work was understood and refused. `TASK_STATE_FAILED` is "finished with an
 * error" — the agent tried and could not.
 *
 * So a ChangeSet that violates the project's path policy is REJECTED: the
 * daemon read it and said no. A ChangeSet that could not be delivered because
 * no Studio session is paired is FAILED: nobody refused anything, the far end
 * was not there. Getting this backwards matters to a calling orchestrator,
 * because REJECTED means "do not retry this as-is" and FAILED means "the same
 * request may work later".
 */
export const REJECTING_CODES: ReadonlySet<ForgeBridgeErrorCode> = new Set<ForgeBridgeErrorCode>([
  'invalid_request',
  'policy_violation',
  'not_approved',
  'too_large',
]);

export function taskStateForFailure(code: ForgeBridgeErrorCode): Extract<TaskState, 'TASK_STATE_REJECTED' | 'TASK_STATE_FAILED'> {
  return REJECTING_CODES.has(code) ? 'TASK_STATE_REJECTED' : 'TASK_STATE_FAILED';
}

/**
 * A failure rendered for a task's status message.
 *
 * `remedy` is carried through because the daemon writes one for almost every
 * error and it is the half a calling agent can act on. `traceId` is not carried:
 * it is support correlation for a human, not something a remote agent should be
 * handed.
 */
export interface RenderedFailure {
  state: Extract<TaskState, 'TASK_STATE_REJECTED' | 'TASK_STATE_FAILED'>;
  summary: string;
  detail: ErrorDetail;
}

export function renderFailure(error: unknown): RenderedFailure {
  if (error instanceof ForgeBridgeError) {
    return {
      state: taskStateForFailure(error.code),
      summary: error.remedy ? `${error.message} — ${error.remedy}` : error.message,
      detail: errorInfo(error.code.toUpperCase(), FORGEBRIDGE_ERROR_DOMAIN, {
        code: error.code,
        message: error.message,
        ...(error.remedy ? { remedy: error.remedy } : {}),
      }),
    };
  }

  // Anything else is this connector misbehaving, and it says so without
  // quoting itself: the daemon's own rule is that an internal error never
  // carries an internal detail, and a remote agent is a weaker audience for a
  // stack trace than a local one.
  return {
    state: 'TASK_STATE_FAILED',
    summary: 'the ForgeBridge A2A connector failed to complete this task',
    detail: errorInfo('INTERNAL', FORGEBRIDGE_ERROR_DOMAIN),
  };
}

/**
 * A failure, reduced to the protocol code a caller branches on.
 *
 * This is `renderFailure`'s other half. That one answers "what does this task's
 * status say"; this one answers "what happened", in the closed vocabulary of
 * `packages/protocol`. A calling agent needs both: the task state tells it
 * whether to retry, and the code tells it what to fix.
 *
 * `recognised` travels beside the code rather than being inferred from it,
 * because `internal` is also a real answer the daemon sends. An unrecognised
 * failure reported as `internal` is correct; an unrecognised failure reported as
 * `not_approved` would be this connector inventing an approval decision out of
 * a socket timeout.
 *
 * Three shapes reach here, and all three are real: a `ForgeBridgeError`, which
 * is how the backend raises every `/v1` refusal; a bare `ProtocolError` payload,
 * which is what a caller parsing a response body holds; and the `ErrorInfo`
 * detail this connector puts on a failed task, which is what a *remote* agent
 * actually receives and is the only one of the three it can read.
 */
export interface FailureView {
  code: ForgeBridgeErrorCode;
  recognised: boolean;
  /** The A2A task state this failure lands a task in. */
  state: Extract<TaskState, 'TASK_STATE_REJECTED' | 'TASK_STATE_FAILED'>;
  message: string;
  remedy?: string;
}

export function classifyFailure(error: unknown): FailureView {
  const view = (payload: ProtocolError): FailureView => ({
    code: payload.code,
    recognised: true,
    state: taskStateForFailure(payload.code),
    message: payload.message,
    ...(payload.remedy ? { remedy: payload.remedy } : {}),
  });

  if (error instanceof ForgeBridgeError) return view(error.toPayload());

  const payload = ProtocolErrorSchema.safeParse(error);
  if (payload.success) return view(payload.data);

  // The shape a remote agent holds: the `google.rpc.ErrorInfo` detail this
  // connector attaches to a failed or rejected task, whose metadata carries the
  // protocol code that caused it.
  const metadata = (error as { metadata?: { code?: unknown; message?: unknown; remedy?: unknown } } | null | undefined)
    ?.metadata;
  const fromDetail = ForgeBridgeErrorCodeSchema.safeParse(metadata?.code);
  if (fromDetail.success) {
    return {
      code: fromDetail.data,
      recognised: true,
      state: taskStateForFailure(fromDetail.data),
      message: typeof metadata?.message === 'string' ? metadata.message : '',
      ...(typeof metadata?.remedy === 'string' ? { remedy: metadata.remedy } : {}),
    };
  }

  return {
    code: 'internal',
    recognised: false,
    state: 'TASK_STATE_FAILED',
    message: 'the ForgeBridge A2A connector could not classify this failure',
  };
}
