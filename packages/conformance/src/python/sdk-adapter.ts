import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  ErrorCode,
  ForgeBridgeError,
  HTTP_STATUS,
  ProtocolError,
} from '@forgebridge/protocol';
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
 * `packages/sdk-python` wearing the conformance interface.
 *
 * The suite is TypeScript and needs a built workspace and a live daemon; the
 * Python SDK's CI gate has neither, and hosting a TypeScript adapter inside
 * `packages/sdk-python` would make a PyPI package an npm workspace. So the
 * adapter lives here, on the side that can run the suite, and the calls it is
 * testing happen one process over in `packages/sdk-python/tests/
 * conformance_driver.py` — the same subprocess shape the cross-language schema
 * drift proof already uses.
 *
 * Everything this file does is transport. Every value it returns was produced by
 * `ForgeBridgeClient`, and every error code it reports was produced by
 * `forgebridge.describe_error`. A bridge that classified a failure itself would
 * prove that TypeScript can map error codes and nothing about whether the SDK
 * can — which is the whole question.
 *
 * ── The call that is not here ────────────────────────────────────────────────
 *
 * There is no `approve`, on this side or on that one. `ForgeBridgeClient` does
 * have `approve_changeset`, and the driver is wired to a transport that refuses
 * any request whose URL contains `/approve` before it is sent, for the reason
 * ADR-012 gives: an approval the connector could arrange for itself would prove
 * that apply works and nothing at all about the gate.
 */

/**
 * Where the driver lives, relative to this file's own location.
 *
 * Outside this package on purpose: the driver is Python and belongs with the
 * Python SDK, and it resolves the same way from `src` under vitest and from
 * `dist` after a build. `files: ["dist"]` does not carry it, so a consumer who
 * installed this package from a registry has to pass `driver` — there is no
 * copy of `packages/sdk-python` for it to find.
 */
const DRIVER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../sdk-python/tests/conformance_driver.py',
);

export interface PythonSdkAdapterOptions {
  /** Base URL of a running daemon, e.g. `http://127.0.0.1:7317`. */
  baseUrl: string;
  /** The producer token the daemon printed when it started. */
  producerToken: string;
  /**
   * The interpreter to run the driver with.
   *
   * `packages/sdk-python` supports 3.10 and up, and the models do not import on
   * 3.9 — so a machine whose `python3` is older needs this, or the
   * `FORGEBRIDGE_PYTHON` environment variable, to name one that works.
   */
  python?: string;
  /** Path to the driver. Defaults to the one in this repository. */
  driver?: string;
  /** How long any one call may take before the bridge gives up on the driver. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * A failure the driver reported, carrying the view Python classified it with.
 *
 * The view rides on the error rather than being recomputed from it, because
 * recomputing it here is exactly the thing this bridge must not do.
 */
export class PythonSdkFailure extends Error {
  constructor(readonly view: ConnectorErrorView, readonly raised: string) {
    super(`${view.code}: ${view.message ?? raised}`);
    this.name = 'PythonSdkFailure';
  }
}

/** The driver answering something that is not a classified failure at all. */
export class PythonDriverFault extends Error {
  constructor(message: string) {
    super(`the Python conformance driver: ${message}`);
    this.name = 'PythonDriverFault';
  }
}

interface DriverResponse {
  id?: number;
  ok: boolean;
  value?: unknown;
  error?: { code: string; recognised: boolean; status?: number; message?: string; remedy?: string };
  raised?: string;
  fault?: string;
}

/** One classification the Python side computed, keyed by the input it was given. */
type ClassificationTable = ReadonlyMap<string, { code: ErrorCode; recognised: boolean; status?: number }>;

/**
 * The inputs the suite feeds `describeError`, in the driver's own vocabulary.
 *
 * Asked for in one batch at startup, because `describeError` is synchronous and
 * the classifier is in another process. What crosses the pipe is the inputs; the
 * answers are `forgebridge.describe_error`'s, so a Python mapping that flattened
 * every failure to `internal` would arrive here flattened and the case would go
 * red exactly as it should.
 */
function classificationInputs(): Array<Record<string, unknown>> {
  const inputs: Array<Record<string, unknown>> = [];
  for (const code of ErrorCode.options) {
    // A refusal that arrived as an answer, and the same refusal as a body
    // nobody has parsed yet. The suite feeds both, because a connector that
    // understands only its own error class has a mapping that works in its own
    // tests and nowhere else.
    inputs.push({
      kind: 'protocol_error',
      key: `protocol_error:${code}`,
      status: HTTP_STATUS[code],
      payload: { code, message: `synthetic ${code}`, remedy: 'synthetic remedy' },
    });
    inputs.push({
      kind: 'wire_payload',
      key: `wire_payload:${code}`,
      payload: { code, message: `synthetic ${code}`, remedy: 'synthetic remedy' },
    });
  }
  inputs.push({ kind: 'transport_error', key: 'transport_error', message: 'the daemon did not answer' });
  inputs.push({ kind: 'opaque', key: 'opaque', message: 'an unrecognised failure' });
  inputs.push({ kind: 'nothing', key: 'nothing' });
  return inputs;
}

/**
 * Which of those inputs a failure the suite handed us *is*.
 *
 * Deliberately structural and deliberately total: an input this function cannot
 * place returns null, and `describeError` then throws rather than guessing. "I
 * do not recognise this" and "this is safe" must not be the same answer, and a
 * bridge that defaulted an unplaceable input to `internal` would silently pass
 * the one case that checks what a connector does with a failure it does not
 * understand.
 */
function keyFor(error: unknown): string | null {
  if (error instanceof ForgeBridgeError) return `protocol_error:${error.code}`;
  if (error === undefined || error === null) return 'nothing';
  const payload = ProtocolError.safeParse(error);
  if (payload.success) return `wire_payload:${payload.data.code}`;
  if (error instanceof Error) return 'opaque';
  return null;
}

export interface PythonSdkAdapter extends ConnectorAdapter {
  /** Stop the driver. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * Start the driver and hand back an adapter pointed at it.
 *
 * The classification handshake happens here rather than lazily, so a driver that
 * cannot start — no interpreter, no pydantic, a syntax error — fails at the
 * point a reader can act on it and not inside a case, where it would read as the
 * connector's bug.
 */
export async function startPythonSdkAdapter(options: PythonSdkAdapterOptions): Promise<PythonSdkAdapter> {
  const interpreter = options.python ?? process.env.FORGEBRIDGE_PYTHON ?? 'python3';
  const driverPath = options.driver ?? DRIVER;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Default stdio, which is three pipes. Named rather than passed so the type
  // stays `ChildProcessWithoutNullStreams` and the three streams below need no
  // non-null assertion to read.
  const child: ChildProcessWithoutNullStreams = spawn(interpreter, [
    driverPath,
    '--daemon',
    options.baseUrl,
    '--token',
    options.producerToken,
  ]);

  // Kept whole rather than sampled: when the driver dies, its traceback is the
  // only thing that says why, and a bridge that swallowed it would leave the
  // reader with "the process exited".
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const pending = new Map<number, { resolve: (value: DriverResponse) => void; reject: (error: Error) => void }>();
  let exited: Error | null = null;

  const lines: Interface = createInterface({ input: child.stdout });
  lines.on('line', (line: string) => {
    let response: DriverResponse;
    try {
      response = JSON.parse(line) as DriverResponse;
    } catch {
      // Not a protocol failure — the driver is supposed to answer in JSON and
      // did not. Reported as what it is rather than classified as something.
      for (const waiter of pending.values()) waiter.reject(new PythonDriverFault(`answered with a line that is not JSON: ${line}`));
      pending.clear();
      return;
    }
    const waiter = response.id === undefined ? undefined : pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id as number);
    waiter.resolve(response);
  });

  const die = (reason: string): void => {
    exited ??= new PythonDriverFault(`${reason}${stderr ? `\n${stderr.trimEnd()}` : ''}`);
    for (const waiter of pending.values()) waiter.reject(exited);
    pending.clear();
  };
  child.on('error', (error) => die(`could not be started with "${interpreter}": ${error.message}`));
  child.on('exit', (code, signal) => die(`exited (code ${code ?? 'none'}, signal ${signal ?? 'none'})`));

  let nextId = 0;
  const send = (request: Record<string, unknown>): Promise<DriverResponse> => {
    if (exited) return Promise.reject(exited);
    const id = (nextId += 1);
    return new Promise<DriverResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new PythonDriverFault(`did not answer "${String(request.call)}" within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
    });
  };

  /** One call, with a failure raised as the view Python put on it. */
  const call = async <T>(name: string, request: Record<string, unknown> = {}): Promise<T> => {
    const response = await send({ call: name, ...request });
    if (response.ok) return response.value as T;
    if (response.fault !== undefined) throw new PythonDriverFault(response.fault);
    const view = response.error;
    if (!view || !ErrorCode.safeParse(view.code).success) {
      throw new PythonDriverFault(`reported a failure of ${name} with no protocol code: ${JSON.stringify(view)}`);
    }
    throw new PythonSdkFailure(
      {
        code: view.code as ErrorCode,
        recognised: view.recognised,
        ...(view.status === undefined ? {} : { transportCode: view.status }),
        ...(view.message === undefined ? {} : { message: view.message }),
        ...(view.remedy === undefined ? {} : { remedy: view.remedy }),
      },
      response.raised ?? 'an exception',
    );
  };

  /** Stop the driver, whether it started well or badly. Safe to call twice. */
  const closeDriver = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5_000).unref?.();
      });
    }
    lines.close();
  };

  const inputs = classificationInputs();
  let answers: Array<{ code: string; recognised: boolean; status?: number }>;
  try {
    answers = await call<Array<{ code: string; recognised: boolean; status?: number }>>('classify', { inputs });
  } catch (cause) {
    // The first call the driver ever receives, so this is where "there is no
    // usable interpreter" surfaces. Said in full here rather than left as a
    // traceback, because the reader is usually somebody who has never installed
    // this package and the fix is two commands.
    await closeDriver();
    throw new PythonDriverFault(
      `could not be reached through "${interpreter}". It needs Python 3.10+ with pydantic v2 ` +
        '(`python -m pip install -e "packages/sdk-python"`); name another interpreter with the ' +
        `FORGEBRIDGE_PYTHON environment variable.\n\n${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (answers.length !== inputs.length) {
    await closeDriver();
    throw new PythonDriverFault(`classified ${answers.length} of the ${inputs.length} failures it was handed`);
  }
  const table: ClassificationTable = new Map(
    answers.map((answer, index) => [
      String(inputs[index]?.key),
      {
        // Not validated here, on purpose. A code Python invented has to reach
        // the report *as* an invented code: `runConformanceSuite` refuses a
        // `describeError` result whose code is not an `ErrorCode`, and the
        // failure it records names the connector. Rejecting it in this line
        // would turn a conformance failure into a bridge crash, and the reader
        // would be told the bridge is broken.
        code: answer.code as ErrorCode,
        recognised: answer.recognised,
        ...(answer.status === undefined ? {} : { status: answer.status }),
      },
    ]),
  );

  return {
    name: 'forgebridge (Python SDK)',
    close: closeDriver,

    linkStatus: () => call<ConnectorLinkStatus>('link_status'),
    listProjects: () => call<ConnectorProject[]>('list_projects'),
    readTree: (projectId) => call<ConnectorTree>('read_tree', { projectId }),
    diff: (changeSetId) => call<ConnectorDiff>('diff', { changeSetId }),
    apply: (changeSetId) => call<ConnectorApplyReport>('apply', { changeSetId }),

    propose: (input: ProposeInput) =>
      call<ConnectorProposal>('propose', {
        projectId: input.projectId,
        baseVersion: input.baseVersion,
        summary: input.summary,
        operations: input.operations,
        // Forwarded rather than dropped. `ChangeSet` has a validation field, so
        // a producer can put its own verdict on the wire through this client —
        // and forwarding it is what lets the suite prove from the outside that
        // the daemon discards it and recomputes (PROTOCOL invariant 4).
        ...(input.claimedValidation ? { claimedValidation: input.claimedValidation } : {}),
      }),

    startRun: (input: RunInput) =>
      call<ConnectorRun>('start_run', { projectId: input.projectId, prompt: input.prompt }),

    /**
     * The SDK's classification, looked up rather than computed.
     *
     * Two paths, and neither of them decides anything. A failure that came from
     * a driver call already carries the view `forgebridge.describe_error` put on
     * it. A failure the suite synthesised is matched against the table built at
     * startup — `code`, `recognised` and the HTTP status are Python's answers;
     * `message` and `remedy` are read off the object in hand, because those are
     * the error's own words and not a classification.
     *
     * An input that matches nothing throws. That is the whole reason this is a
     * lookup and not a fallback: the alternative is a bridge that answers
     * `internal` for anything it does not recognise, which would pass
     * `error-codes-total`'s unrecognised-failure check without asking Python
     * anything at all.
     */
    describeError(error: unknown): ConnectorErrorView {
      if (error instanceof PythonSdkFailure) return error.view;

      const key = keyFor(error);
      const answer = key === null ? undefined : table.get(key);
      if (!answer) {
        throw new PythonDriverFault(
          `was asked to classify a failure it never showed the SDK (${key ?? 'an input of no recognised shape'}). ` +
            'Add it to classificationInputs() so the answer comes from forgebridge.describe_error rather than from this bridge.',
        );
      }

      const described = error as { message?: unknown; remedy?: unknown };
      return {
        code: answer.code,
        recognised: answer.recognised,
        ...(answer.status === undefined ? {} : { transportCode: answer.status }),
        ...(typeof described?.message === 'string' ? { message: described.message } : {}),
        ...(typeof described?.remedy === 'string' ? { remedy: described.remedy } : {}),
      };
    },
  };
}
