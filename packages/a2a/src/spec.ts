import { z } from 'zod';

/**
 * The A2A protocol surface, transcribed from the specification.
 *
 * Nothing in this file is a ForgeBridge decision. Every constant, field name
 * and enum value below was read out of the A2A specification at the version
 * pinned in `A2A_SPEC_VERSION`, and the citation on each block names the
 * section it came from so a reader can check it rather than trust it.
 *
 * Sources (both read at tag `v1.0.1` of https://github.com/a2aproject/A2A):
 *   - `docs/specification.md`     — the prose specification
 *   - `specification/a2a.proto`   — the canonical data model (spec §4)
 *
 * Two conventions from §5.5 govern every shape here and are easy to get wrong:
 * JSON field names are **camelCase** (not the proto's snake_case), and enum
 * values are **SCREAMING_SNAKE_CASE proto names** (`"TASK_STATE_WORKING"`, not
 * `"working"`). A `"working"` on the wire is not a stylistic difference; it is
 * a different protocol, and it is what pre-1.0 A2A used.
 */

/**
 * The `Major.Minor` protocol version this connector speaks (§3.6). Patch
 * numbers are excluded on purpose: §3.6 says they "MUST not be considered when
 * clients and servers negotiate protocol versions".
 */
export const A2A_PROTOCOL_VERSION = '1.0' as const;

/** The specification tag this file was transcribed from, for the README and support. */
export const A2A_SPEC_VERSION = '1.0.1' as const;

/**
 * §8.2 and the IANA registration in §14.3. Changed at A2A 0.3.0 from the older
 * `/.well-known/agent.json`; a client looking for the old path finds nothing
 * here, which is correct — the old path served a differently-shaped card.
 */
export const AGENT_CARD_WELL_KNOWN_PATH = '/.well-known/agent-card.json' as const;

/** §3.2.6 and §14.2. Case-insensitive on the wire, per HTTP. */
export const A2A_VERSION_HEADER = 'A2A-Version' as const;
export const A2A_EXTENSIONS_HEADER = 'A2A-Extensions' as const;

/** §14.1.1. Accepted alongside `application/json`, which §9.1 requires. */
export const A2A_MEDIA_TYPE = 'application/a2a+json' as const;

/** §5.8 / §8.3.1. The binding identifier for JSON-RPC 2.0 over HTTP (§9). */
export const JSONRPC_BINDING = 'JSONRPC' as const;

// ────────────────────────────────── enums (§4.1.3, §4.1.5) ──────────────────────────────────

export const TaskState = z.enum([
  'TASK_STATE_UNSPECIFIED',
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_AUTH_REQUIRED',
]);
export type TaskState = z.infer<typeof TaskState>;

export const Role = z.enum(['ROLE_UNSPECIFIED', 'ROLE_USER', 'ROLE_AGENT']);
export type Role = z.infer<typeof Role>;

/**
 * The four states nothing leaves. Named by the proto comments on each value and
 * restated in §9.4.6, which uses exactly this set to decide when
 * `SubscribeToTask` must fail.
 */
export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

/**
 * The two states that pause a task pending something the *client* must do
 * (§3.2.2). They are not terminal: work resumes when the client acts.
 */
export const INTERRUPTED_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
]);

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.has(state);
}

export function isInterrupted(state: TaskState): boolean {
  return INTERRUPTED_TASK_STATES.has(state);
}

/**
 * The transitions this connector permits.
 *
 * The specification defines which states exist, which are terminal and which
 * are interrupted; it does not publish an edge list. This table is therefore
 * *this implementation's* lifecycle, derived from those three facts:
 *
 *   - a terminal state has no outgoing edges — that is what terminal means;
 *   - an interrupted state resumes into `WORKING` when the client acts (§3.2.2
 *     describes `AUTH_REQUIRED` as "an interrupted state requiring client
 *     action", not an ending);
 *   - a task may be canceled from any non-terminal state (§3.1.5), which is why
 *     `CANCELED` is reachable from every row that is not itself terminal.
 *
 * `TASK_STATE_UNSPECIFIED` is the proto's zero value and is never entered: a
 * task that exists has been submitted. It is present as a row with no outgoing
 * edges so that an accidental write of the zero value fails closed instead of
 * silently behaving like `SUBMITTED`.
 */
export const LEGAL_TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = Object.freeze({
  TASK_STATE_UNSPECIFIED: [],
  TASK_STATE_SUBMITTED: ['TASK_STATE_WORKING', 'TASK_STATE_REJECTED', 'TASK_STATE_CANCELED'],
  TASK_STATE_WORKING: [
    'TASK_STATE_COMPLETED',
    'TASK_STATE_FAILED',
    'TASK_STATE_REJECTED',
    'TASK_STATE_INPUT_REQUIRED',
    'TASK_STATE_AUTH_REQUIRED',
    'TASK_STATE_CANCELED',
  ],
  TASK_STATE_INPUT_REQUIRED: ['TASK_STATE_WORKING', 'TASK_STATE_CANCELED'],
  TASK_STATE_AUTH_REQUIRED: ['TASK_STATE_WORKING', 'TASK_STATE_CANCELED'],
  TASK_STATE_COMPLETED: [],
  TASK_STATE_FAILED: [],
  TASK_STATE_CANCELED: [],
  TASK_STATE_REJECTED: [],
} satisfies Record<TaskState, readonly TaskState[]>);

export function isLegalTransition(from: TaskState, to: TaskState): boolean {
  return LEGAL_TASK_TRANSITIONS[from].includes(to);
}

// ────────────────────────────────── data model (§4.1) ──────────────────────────────────

/** §5.6.1: every timestamp is ISO 8601, UTC, `Z`-suffixed. */
const Timestamp = z.string().datetime();

/** `google.protobuf.Struct` — a JSON object with arbitrary values. */
const Struct = z.record(z.string(), z.unknown());

/**
 * §4.1.6. `content` is a proto `oneof`, so exactly one of `text`, `raw`, `url`
 * or `data` is present. ProtoJSON does not tag a `oneof`; the discriminator is
 * "which key is here", which is why this is a refinement rather than a
 * discriminated union.
 *
 * `data` is `google.protobuf.Value` — any JSON value, including `null`, which
 * is why its presence is decided by key presence and not by `!== undefined`.
 */
export const Part = z
  .object({
    text: z.string().optional(),
    /** Base64 in JSON, per the proto comment on `bytes raw`. */
    raw: z.string().optional(),
    url: z.string().optional(),
    data: z.unknown().optional(),
    metadata: Struct.optional(),
    filename: z.string().optional(),
    mediaType: z.string().optional(),
  })
  .superRefine((part, ctx) => {
    const present = (['text', 'raw', 'url', 'data'] as const).filter((key) =>
      Object.prototype.hasOwnProperty.call(part, key),
    );
    if (present.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a Part carries exactly one of text, raw, url or data; this one carries ${present.length}`,
      });
    }
  });
export type Part = z.infer<typeof Part>;

/** §4.1.4. `messageId`, `role` and a non-empty `parts` are REQUIRED in the proto. */
export const Message = z.object({
  messageId: z.string().min(1),
  contextId: z.string().optional(),
  taskId: z.string().optional(),
  role: Role,
  parts: z.array(Part).min(1),
  metadata: Struct.optional(),
  extensions: z.array(z.string()).optional(),
  referenceTaskIds: z.array(z.string()).optional(),
});
export type Message = z.infer<typeof Message>;

/** §4.1.7. `artifactId` and a non-empty `parts` are REQUIRED. */
export const Artifact = z.object({
  artifactId: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  parts: z.array(Part).min(1),
  metadata: Struct.optional(),
  extensions: z.array(z.string()).optional(),
});
export type Artifact = z.infer<typeof Artifact>;

/** §4.1.2. Only `state` is REQUIRED. */
export const TaskStatus = z.object({
  state: TaskState,
  message: Message.optional(),
  timestamp: Timestamp.optional(),
});
export type TaskStatus = z.infer<typeof TaskStatus>;

/** §4.1.1. Only `id` and `status` are REQUIRED. */
export const Task = z.object({
  id: z.string().min(1),
  contextId: z.string().optional(),
  status: TaskStatus,
  artifacts: z.array(Artifact).optional(),
  history: z.array(Message).optional(),
  metadata: Struct.optional(),
});
export type Task = z.infer<typeof Task>;

// ────────────────────────────────── discovery (§4.4) ──────────────────────────────────

/** §4.4.6. Every field but `tenant` is REQUIRED. */
export const AgentInterface = z.object({
  url: z.string().min(1),
  protocolBinding: z.string().min(1),
  tenant: z.string().optional(),
  protocolVersion: z.string().min(1),
});
export type AgentInterface = z.infer<typeof AgentInterface>;

/** §4.4.4. */
export const AgentExtension = z.object({
  uri: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean().optional(),
  params: Struct.optional(),
});
export type AgentExtension = z.infer<typeof AgentExtension>;

/** §4.4.3. Every field is optional; an absent flag reads as "not supported" (§3.3.4). */
export const AgentCapabilities = z.object({
  streaming: z.boolean().optional(),
  pushNotifications: z.boolean().optional(),
  extensions: z.array(AgentExtension).optional(),
  extendedAgentCard: z.boolean().optional(),
});
export type AgentCapabilities = z.infer<typeof AgentCapabilities>;

/** §4.4.5. `id`, `name`, `description` and a non-empty `tags` are REQUIRED. */
export const AgentSkill = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()).min(1),
  examples: z.array(z.string()).optional(),
  inputModes: z.array(z.string()).optional(),
  outputModes: z.array(z.string()).optional(),
  securityRequirements: z.array(z.unknown()).optional(),
});
export type AgentSkill = z.infer<typeof AgentSkill>;

/** §4.4.2. Both fields REQUIRED. */
export const AgentProvider = z.object({
  url: z.string().min(1),
  organization: z.string().min(1),
});
export type AgentProvider = z.infer<typeof AgentProvider>;

/** §4.5.1/§4.5.3. A proto `oneof`, so one scheme key per entry. */
export const SecurityScheme = z.object({
  httpAuthSecurityScheme: z
    .object({
      description: z.string().optional(),
      scheme: z.string().min(1),
      bearerFormat: z.string().optional(),
    })
    .optional(),
  apiKeySecurityScheme: z
    .object({
      description: z.string().optional(),
      location: z.enum(['query', 'header', 'cookie']),
      name: z.string().min(1),
    })
    .optional(),
});
export type SecurityScheme = z.infer<typeof SecurityScheme>;

/** §4.5. `SecurityRequirement.schemes` maps a scheme name to a `StringList`. */
export const SecurityRequirement = z.object({
  schemes: z.record(z.string(), z.object({ list: z.array(z.string()) })),
});
export type SecurityRequirement = z.infer<typeof SecurityRequirement>;

/**
 * §4.4.1. REQUIRED: `name`, `description`, `supportedInterfaces`, `version`,
 * `capabilities`, `defaultInputModes`, `defaultOutputModes`, `skills`.
 *
 * §5.7 says arrays marked REQUIRED must carry at least one element, which is
 * why the four required arrays below are `.min(1)`.
 */
export const AgentCard = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  supportedInterfaces: z.array(AgentInterface).min(1),
  provider: AgentProvider.optional(),
  version: z.string().min(1),
  documentationUrl: z.string().optional(),
  capabilities: AgentCapabilities,
  securitySchemes: z.record(z.string(), SecurityScheme).optional(),
  securityRequirements: z.array(SecurityRequirement).optional(),
  defaultInputModes: z.array(z.string()).min(1),
  defaultOutputModes: z.array(z.string()).min(1),
  skills: z.array(AgentSkill).min(1),
  signatures: z.array(z.object({ protected: z.string(), signature: z.string() })).optional(),
  iconUrl: z.string().optional(),
});
export type AgentCard = z.infer<typeof AgentCard>;

// ────────────────────────────────── JSON-RPC binding (§9) ──────────────────────────────────

/**
 * §9.1: "PascalCase method names matching gRPC conventions". The full mapping
 * is the table in §5.3.
 *
 * The `category/action` form shown in the §9.3 skeleton (`message/send`,
 * `tasks/get`) is pre-1.0 A2A. §5.3 and §9.4 are the normative names and they
 * are PascalCase; this connector answers to those and to nothing else.
 */
export const A2A_METHODS = {
  sendMessage: 'SendMessage',
  sendStreamingMessage: 'SendStreamingMessage',
  getTask: 'GetTask',
  listTasks: 'ListTasks',
  cancelTask: 'CancelTask',
  subscribeToTask: 'SubscribeToTask',
  createTaskPushNotificationConfig: 'CreateTaskPushNotificationConfig',
  getTaskPushNotificationConfig: 'GetTaskPushNotificationConfig',
  listTaskPushNotificationConfigs: 'ListTaskPushNotificationConfigs',
  deleteTaskPushNotificationConfig: 'DeleteTaskPushNotificationConfig',
  getExtendedAgentCard: 'GetExtendedAgentCard',
} as const;

/** §3.2.2. Blocking unless the caller opts out. */
export const SendMessageConfiguration = z.object({
  acceptedOutputModes: z.array(z.string()).optional(),
  historyLength: z.number().int().min(0).optional(),
  returnImmediately: z.boolean().optional(),
});
export type SendMessageConfiguration = z.infer<typeof SendMessageConfiguration>;

/** §3.2.1. Only `message` is REQUIRED. */
export const SendMessageRequest = z.object({
  tenant: z.string().optional(),
  message: Message,
  configuration: SendMessageConfiguration.optional(),
  metadata: Struct.optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

/** §9.4.3 / proto `GetTaskRequest`. */
export const GetTaskRequest = z.object({
  tenant: z.string().optional(),
  id: z.string().min(1),
  historyLength: z.number().int().min(0).optional(),
});
export type GetTaskRequest = z.infer<typeof GetTaskRequest>;

/** §9.4.4 / proto `ListTasksRequest`. Page size bounds are from the proto comment. */
export const ListTasksRequest = z.object({
  tenant: z.string().optional(),
  contextId: z.string().optional(),
  status: TaskState.optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
  historyLength: z.number().int().min(0).optional(),
  statusTimestampAfter: Timestamp.optional(),
  includeArtifacts: z.boolean().optional(),
});
export type ListTasksRequest = z.infer<typeof ListTasksRequest>;

/** §9.4.5 / proto `CancelTaskRequest`. */
export const CancelTaskRequest = z.object({
  tenant: z.string().optional(),
  id: z.string().min(1),
  metadata: Struct.optional(),
});
export type CancelTaskRequest = z.infer<typeof CancelTaskRequest>;

/** Proto `ListTasksResponse`. All four fields are REQUIRED. */
export interface ListTasksResponse {
  tasks: Task[];
  nextPageToken: string;
  pageSize: number;
  totalSize: number;
}

/** §9.3. A JSON-RPC 2.0 request as this binding accepts it. */
export const JsonRpcRequest = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequest>;

/**
 * §3.2.4. `historyLength` semantics, applied identically wherever it appears:
 * unset means "no limit imposed", `0` means the `history` field is omitted,
 * and a positive value caps the *most recent* messages.
 */
export function applyHistoryLength(history: readonly Message[], limit: number | undefined): Message[] | undefined {
  if (limit === undefined) return [...history];
  if (limit === 0) return undefined;
  return history.slice(-limit);
}
