import { z } from 'zod';
import {
  A2A_ERRORS,
  A2A_ERROR_DOMAIN,
  A2AProtocolError,
  badRequest,
  errorInfo,
  invalidParams,
  methodNotFound,
  pushNotificationNotSupported,
  taskNotCancelable,
  taskNotFound,
  unsupportedOperation,
} from './errors.js';
import { agentStatusMessage, type SkillExecutor } from './executor.js';
import { InvocationError, SKILL_INVOCATION_EXTENSION_URI, parseInvocation } from './skills.js';
import {
  A2A_METHODS,
  CancelTaskRequest,
  GetTaskRequest,
  ListTasksRequest,
  SendMessageRequest,
  isTerminal,
  type ListTasksResponse,
  type Task,
} from './spec.js';
import { IllegalTaskTransition, type TaskStore } from './tasks.js';

/**
 * The JSON-RPC 2.0 binding (§9): method names, parameter shapes, and which
 * methods this connector answers.
 *
 * Everything the specification names is handled, but not everything is
 * implemented, and the difference is deliberate rather than a gap left open.
 * §3.3.4 says an operation whose capability the Agent Card does not declare
 * **MUST** be refused with a specific named error — `UnsupportedOperationError`
 * for streaming and the extended card, `PushNotificationNotSupportedError` for
 * the four push-config methods. So a client that calls `SubscribeToTask` here
 * does not get "unknown method"; it gets the error the specification says it
 * should get for an agent that declares `streaming: false`, which is a fact it
 * could already have read off the card.
 */

/** Everything about the request that came in below the JSON-RPC envelope. */
export interface RequestContext {
  /**
   * Extension URIs the client declared, from the `A2A-Extensions` header
   * (§3.2.6) or from `message.extensions` (§4.6.1 shows both).
   */
  declaredExtensions: readonly string[];
}

export interface A2AHandlerOptions {
  tasks: TaskStore;
  executor: SkillExecutor;
  /**
   * The `tenant` this interface routes on, when the Agent Card declares one.
   * §8.3.2: a client selecting an interface with a `tenant` **MUST** send that
   * exact value on every request.
   */
  expectedTenant?: string | undefined;
}

export class A2AHandler {
  readonly #tasks: TaskStore;
  readonly #executor: SkillExecutor;
  readonly #expectedTenant: string | undefined;
  readonly #inflight = new Set<Promise<unknown>>();

  constructor(options: A2AHandlerOptions) {
    this.#tasks = options.tasks;
    this.#executor = options.executor;
    this.#expectedTenant = options.expectedTenant;
  }

  /**
   * Settle every task still running because a caller asked for
   * `returnImmediately`. Not part of the A2A surface: it exists so a shutdown,
   * or a test, can wait for background work instead of racing it.
   */
  async settled(): Promise<void> {
    while (this.#inflight.size > 0) {
      await Promise.allSettled([...this.#inflight]);
    }
  }

  /**
   * Dispatch one JSON-RPC call. Returns the `result` value, or throws
   * `A2AProtocolError`, which the transport renders as a JSON-RPC `error`.
   */
  async call(method: string, params: unknown, context: RequestContext): Promise<unknown> {
    switch (method) {
      case A2A_METHODS.sendMessage:
        return await this.#sendMessage(params, context);
      case A2A_METHODS.getTask:
        return this.#getTask(params);
      case A2A_METHODS.listTasks:
        return this.#listTasks(params);
      case A2A_METHODS.cancelTask:
        return this.#cancelTask(params);

      // Declared `streaming: false` on the card, so §3.3.4 mandates this exact error.
      case A2A_METHODS.sendStreamingMessage:
      case A2A_METHODS.subscribeToTask:
        throw unsupportedOperation(
          method,
          'this agent declares capabilities.streaming = false. Use SendMessage and poll with GetTask.',
        );

      // Declared `extendedAgentCard: false`, so §3.3.4 mandates the same error
      // rather than ExtendedAgentCardNotConfiguredError, which is for an agent
      // that declares the capability and then has no card to serve.
      case A2A_METHODS.getExtendedAgentCard:
        throw unsupportedOperation(
          method,
          'this agent declares capabilities.extendedAgentCard = false. The public card is the whole card.',
        );

      // Declared `pushNotifications: false`, so §3.3.4 mandates this one.
      case A2A_METHODS.createTaskPushNotificationConfig:
      case A2A_METHODS.getTaskPushNotificationConfig:
      case A2A_METHODS.listTaskPushNotificationConfigs:
      case A2A_METHODS.deleteTaskPushNotificationConfig:
        throw pushNotificationNotSupported(method);

      default:
        throw methodNotFound(method);
    }
  }

  // ────────────────────────────────── SendMessage (§9.4.1) ──────────────────────────────────

  async #sendMessage(rawParams: unknown, context: RequestContext): Promise<{ task: Task }> {
    const params = parseParams(SendMessageRequest, rawParams);
    this.#assertTenant(params.tenant);

    const declared = new Set([...context.declaredExtensions, ...(params.message.extensions ?? [])]);
    if (!declared.has(SKILL_INVOCATION_EXTENSION_URI)) {
      // §3.3.4: the card marks this extension `required: true`, and a client
      // that has not declared support for a required extension gets
      // ExtensionSupportRequiredError. Enforced rather than waved through
      // because the extension is not decorative — it is the only way a message
      // says which skill it wants, and a message without it cannot be run.
      const spec = A2A_ERRORS.extensionSupportRequired;
      throw new A2AProtocolError(
        spec.code,
        `${spec.message}: declare ${SKILL_INVOCATION_EXTENSION_URI} in the A2A-Extensions header or in message.extensions`,
        [errorInfo(spec.reason, A2A_ERROR_DOMAIN, { uri: SKILL_INVOCATION_EXTENSION_URI })],
      );
    }

    const record = this.#resolveTask(params);

    let invocation;
    try {
      invocation = parseInvocation(params.message);
    } catch (error) {
      if (!(error instanceof InvocationError)) throw error;
      // The message was a valid A2A message and this agent has decided not to
      // perform what it asked for. The proto's own words for TASK_STATE_REJECTED
      // are "the agent has decided to not perform the task... during initial
      // task creation", which is exactly this. A JSON-RPC error would instead
      // claim the *request* was malformed, which it was not.
      this.#tasks.transition(
        record.id,
        'TASK_STATE_REJECTED',
        agentStatusMessage(record.id, error.message, [
          { data: badRequest([{ field: error.field, description: error.message }]), mediaType: 'application/json' },
        ]),
      );
      return { task: this.#snapshot(record.id, params.configuration?.historyLength) };
    }

    const run = this.#executor.execute(record.id, invocation);
    this.#track(run);

    // §3.2.2. Blocking is the default: wait until the task reaches a terminal or
    // an interrupted state. Both of those are guaranteed by `execute`, which
    // never leaves a task in WORKING.
    if (params.configuration?.returnImmediately !== true) {
      await run;
    }

    return { task: this.#snapshot(record.id, params.configuration?.historyLength) };
  }

  /**
   * Continue a task the client named, or open a new one (§3.4.2).
   *
   * A message naming a terminal task is refused. §3.3.3 permits additional
   * messages only "for tasks in non-terminal states", and the alternative —
   * quietly opening a new task under a different id — would answer a client's
   * "continue task X" with a task that is not X.
   */
  #resolveTask(params: z.infer<typeof SendMessageRequest>): { id: string } {
    const taskId = params.message.taskId;
    if (taskId === undefined || taskId === '') {
      return this.#tasks.create(params.message.contextId, params.message);
    }

    const existing = this.#tasks.get(taskId);
    if (!existing) throw taskNotFound(taskId);
    if (isTerminal(existing.state)) {
      throw invalidParams(
        `task ${taskId} is in terminal state ${existing.state} and accepts no further messages`,
        [errorInfo('TASK_TERMINAL', A2A_ERROR_DOMAIN, { taskId, state: existing.state })],
      );
    }
    this.#tasks.appendMessage(taskId, params.message);
    return existing;
  }

  // ────────────────────────────────── reads (§9.4.3, §9.4.4) ──────────────────────────────────

  #getTask(rawParams: unknown): { task: Task } {
    const params = parseParams(GetTaskRequest, rawParams);
    this.#assertTenant(params.tenant);
    const record = this.#tasks.get(params.id);
    if (!record) throw taskNotFound(params.id);
    return { task: this.#tasks.snapshot(record, { historyLength: params.historyLength }) };
  }

  #listTasks(rawParams: unknown): ListTasksResponse {
    const params = parseParams(ListTasksRequest, rawParams ?? {});
    this.#assertTenant(params.tenant);
    return this.#tasks.list({
      contextId: params.contextId,
      status: params.status,
      statusTimestampAfter: params.statusTimestampAfter,
      pageSize: params.pageSize,
      pageToken: params.pageToken,
      historyLength: params.historyLength,
      includeArtifacts: params.includeArtifacts,
    });
  }

  // ────────────────────────────────── CancelTask (§9.4.5) ──────────────────────────────────

  #cancelTask(rawParams: unknown): { task: Task } {
    const params = parseParams(CancelTaskRequest, rawParams);
    this.#assertTenant(params.tenant);
    const record = this.#tasks.get(params.id);
    if (!record) throw taskNotFound(params.id);

    // §5.4 maps TaskNotCancelableError to FAILED_PRECONDITION, and §3.3.2
    // describes it as "an attempt was made to cancel a task that is not in a
    // cancelable state (e.g., it has already reached a terminal state)".
    if (isTerminal(record.state)) throw taskNotCancelable(params.id, record.state);

    try {
      this.#tasks.transition(
        params.id,
        'TASK_STATE_CANCELED',
        agentStatusMessage(params.id, 'canceled at the client’s request'),
      );
    } catch (error) {
      if (error instanceof IllegalTaskTransition) throw taskNotCancelable(params.id, record.state);
      throw error;
    }

    // Cancellation stops this connector from reporting further. It does not
    // recall work already handed to the daemon: an approved ChangeSet is queued
    // for the Studio plugin and cancelling the A2A task that requested it does
    // not un-queue it. Rollback is the mechanism for undoing an apply, and it
    // is a separate, separately-approved skill.
    return { task: this.#tasks.snapshot(record) };
  }

  // ────────────────────────────────── helpers ──────────────────────────────────

  #snapshot(taskId: string, historyLength: number | undefined): Task {
    const record = this.#tasks.get(taskId);
    if (!record) throw taskNotFound(taskId);
    return this.#tasks.snapshot(record, { historyLength });
  }

  #assertTenant(provided: string | undefined): void {
    const expected = this.#expectedTenant;
    if (expected === undefined) {
      // No tenant is declared on this interface, so §8.3.2 says a client must
      // omit the field. A value here means the client selected some other
      // interface's routing key, and answering it as if it had not is how one
      // instance ends up serving another's traffic.
      if (provided !== undefined && provided !== '') {
        throw invalidParams('this interface declares no tenant, so the tenant field must be omitted');
      }
      return;
    }
    if (provided !== expected) {
      throw invalidParams(`tenant must be "${expected}" for this interface`);
    }
  }

  #track(promise: Promise<unknown>): void {
    this.#inflight.add(promise);
    void promise.finally(() => this.#inflight.delete(promise));
  }
}

/**
 * Parse a params object, or raise `-32602` with the field violations attached.
 *
 * §9.5 shows `google.rpc.BadRequest` with `fieldViolations` for exactly this,
 * and it is worth the few lines: "Invalid parameters" alone tells a calling
 * agent nothing it can act on, and a calling agent has no human to squint at
 * the payload for it.
 */
function parseParams<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const violations = parsed.error.issues.slice(0, 5).map((issue) => ({
    field: issue.path.join('.') || '(root)',
    description: issue.message,
  }));
  throw invalidParams(violations.map((violation) => `${violation.field}: ${violation.description}`).join('; '), [
    badRequest(violations),
  ]);
}
