/**
 * A recording `fetch` and the small amount of scaffolding the suites share.
 *
 * Deliberately not a mocking library: every test in this package asserts on the
 * exact URL, method and headers that would go to Roblox, and a helper that made
 * those easy to leave unasserted would defeat the point of the suite. The
 * endpoint shapes are the one thing here that cannot be checked against a
 * running service in CI, so they are checked against the documentation by being
 * written down twice — once in `src/`, once as an expectation.
 */
export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
}

export interface FakeResponse {
  status: number;
  body?: string | Uint8Array;
  headers?: Record<string, string>;
}

export interface FakeFetch {
  (input: unknown, init?: unknown): Promise<Response>;
  calls: RecordedCall[];
}

/**
 * A `fetch` that answers from a queue and records what it was asked.
 *
 * When the queue runs dry it throws rather than repeating the last answer: a
 * test that makes one more request than it planned should fail loudly, not
 * quietly pass because the stub was accommodating.
 */
export function fakeFetch(...responses: readonly FakeResponse[]): FakeFetch {
  const queue = [...responses];
  const fn = (async (input: unknown, init?: unknown) => {
    const request = (init ?? {}) as { method?: string; headers?: Headers; body?: string | Uint8Array };
    const headers: Record<string, string> = {};
    if (request.headers instanceof Headers) {
      request.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
    }
    fn.calls.push({
      url: String(input),
      method: request.method ?? 'GET',
      headers,
      body: request.body,
    });
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`fakeFetch: unexpected request ${request.method ?? 'GET'} ${String(input)} — the queue is empty`);
    }
    const bodyInit = next.body === undefined ? null : (next.body as BodyInit);
    return new Response(bodyInit, { status: next.status, headers: next.headers ?? {} });
  }) as FakeFetch;
  fn.calls = [];
  return fn;
}

/** A `fetch` that always rejects, for the transport-failure paths. */
export function failingFetch(message = 'ECONNRESET'): FakeFetch {
  const fn = (async () => {
    throw new Error(message);
  }) as FakeFetch;
  fn.calls = [];
  return fn;
}

/**
 * A key that is recognisable in any output. Not a real credential and not
 * shaped like one — `verify-no-secrets.ts` scans this tree, and a fixture that
 * looks like a live key is a fixture that trips the publication gate.
 */
export const TEST_KEY = 'test-open-cloud-key-do-not-use';

/** Never sleeps, and records what it was asked to wait for. */
export function fakeSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}
