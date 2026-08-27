/**
 * The test THREAT-MODEL T1 claimed existed (M44).
 *
 * T1's row said: "`TelemetryPort` requires every adapter to run attributes,
 * events and exceptions through a shared redactor … alongside the test that
 * feeds known key formats through every log path." The redactor did not exist
 * and neither did the test. This file is the second half; `src/ports/redact.ts`
 * is the first.
 *
 * Two halves here as well, and both are required:
 *
 *   1. **Nothing survives.** Fifteen credential formats — every one a published
 *      prefix or delimiter, plus the daemon's own producer token — are pushed
 *      through every entry point the port has: span names, attribute keys,
 *      attribute values, event names, event attributes, exception messages,
 *      exception stacks, exception causes, status messages, counter and
 *      histogram names and labels. Then through both adapters, and the
 *      assertion is made against the bytes that would go on the wire, not
 *      against an intermediate object.
 *
 *   2. **Ordinary values survive.** A rule that fires on a uuid, a content
 *      digest, a model id or an npm integrity hash is a rule people learn to
 *      ignore, and a redactor nobody reads is worth the same as no redactor.
 *      Every control below is a value this repository actually puts in spans.
 *
 * ── Why the fixtures are assembled rather than written out ───────────────────
 *
 * `scripts/verify-no-secrets.ts` S1 matches these shapes anywhere in the
 * working tree and exempts two files, neither of them this one. Adding a third
 * exemption would put the blind spot on the file most likely to contain a
 * realistic sample. So each fixture is built from parts at run time: no line
 * below contains a complete credential shape, and the values the assertions run
 * against are still exactly the shapes the redactor claims to catch.
 *
 * None of these are real credentials. They are synthetic strings with real
 * prefixes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  REDACTED,
  forgetKnownSecrets,
  namesCredential,
  redactAttributeValue,
  redactAttributes,
  redactError,
  redactText,
  redactedTelemetry,
  registerKnownSecret,
  type Attributes,
  type Span,
  type SpanContext,
  type TelemetryPort,
} from '../src/ports/telemetry.js';
import { otlpTelemetry } from '../src/telemetry/otlp.js';
import { errorReporterTelemetry, type ErrorReporterClient } from '../src/telemetry/reporter.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** 31 characters, letters and digits, no prefix of its own. */
const BODY = 'x7Kq2Vb9Nz4Rm1Ts6Yw3Ha8Jd5Ge0Lp';
const LONG = `${BODY}${BODY}`;

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

interface Planted {
  readonly label: string;
  /** The whole synthetic credential, as it would appear in a message. */
  readonly value: string;
  /**
   * A fragment whose survival proves the whole did too, chosen to contain no
   * character JSON escapes. The PEM fixture needs this: asserting on a string
   * with newlines against serialised JSON would pass whatever happened.
   */
  readonly probe: string;
}

function plantedCredentials(): Planted[] {
  const pem = [
    ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7',
    ['-----END', 'PRIVATE KEY-----'].join(' '),
  ].join('\n');

  const jwt = [
    b64url('{"alg":"HS256","typ":"JWT"}'),
    b64url('{"sub":"forgebridge","iat":1700000000}'),
    BODY,
  ].join('.');

  const entries: Array<[string, string, string?]> = [
    ['openrouter', ['sk-', 'or-v1-', LONG].join('')],
    ['anthropic', ['sk-', 'ant-api03-', LONG].join('')],
    ['openai-project', ['sk-', 'proj-', LONG].join('')],
    ['github', ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('')],
    ['gitlab', ['glpat', '-', BODY].join('')],
    ['slack', ['xoxb', '-', '1234567890-', BODY].join('')],
    ['aws-access-key-id', ['AKIA', 'Q7R2T5Y8U1I4O7P0'].join('')],
    // Exactly 35 characters after the prefix, which is what the published
    // shape is. A 36-character fixture would sail past the rule and the test
    // would then be asserting that the redactor catches something nobody
    // issues.
    ['google', ['AIza', 'Sy', 'B3n7Kq2Vb9Nz4Rm1Ts6Yw3Ha8Jd5Ge0Lp'].join('')],
    ['stripe', ['sk', '_live_', LONG].join('')],
    ['sendgrid', ['SG', '.', BODY.slice(0, 22), '.', LONG].join('')],
    ['npm', ['npm', '_', 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8'].join('')],
    ['jwt', jwt],
    ['pem', pem, 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7'],
    ['bearer-header', ['Bearer', ' ', LONG].join('')],
    /**
     * The daemon's producer token: 256 bits of base64url with no prefix
     * (`packages/daemon/src/auth.ts`). No shape rule can tell it from a content
     * digest, which is exactly why `registerKnownSecret` exists — the process
     * that minted it says so, and from then on it is scrubbed by exact match.
     */
    ['producer-token', 'Qm9vdHN0cmFwVG9rZW5FeGFtcGxlNDNjaGFyc0FC'],
    ['url-userinfo', ['https://forge:', LONG, '@collector.internal/v1/traces'].join('')],
    ['url-parameter', ['https://collector.internal/v1/traces?api_key=', LONG].join('')],
  ];

  return entries.map(([label, value, probe]) => ({ label, value, probe: probe ?? value }));
}

const PLANTED = plantedCredentials();

/**
 * Values this repository genuinely puts in spans. Every one must come back
 * byte-for-byte: a redactor that mangles a run id has broken the trace it was
 * added to protect.
 */
const ORDINARY: ReadonlyArray<{ label: string; text: string }> = [
  { label: 'run id', text: '3f1b1a3e-0c7e-4a1e-9f2e-6d5c4b3a2918' },
  { label: 'content digest', text: 'a3f5c9e18b6d47029f1c8e5a2b7d4306f8e1c9a5b2d7e403f6c8a1b9d2e5f704' },
  { label: 'model id', text: 'anthropic/claude-sonnet-4.5' },
  { label: 'instance path', text: 'ServerScriptService.Shop.PurchaseHandler' },
  { label: 'provider endpoint', text: 'https://openrouter.ai/api/v1/chat/completions' },
  { label: 'lockfile integrity', text: 'sha512-Jr4zPWXyfrUlOaOFCW4rUNMK4cCr1WHOxLLTLzZQtRUn05Kp8p0h5Cnw' },
  { label: 'timestamp', text: '2026-02-14T09:31:07.412Z' },
  { label: 'a sentence about a key', text: 'the api key is missing; set OPENROUTER_API_KEY and restart' },
  { label: 'a key identifier', text: 'sessionKeyId: 3f1b1a3e-0c7e-4a1e-9f2e-6d5c4b3a2918' },
  { label: 'a configuration enum', text: 'secretsBackend: keychain' },
  { label: 'a token count', text: 'promptTokens: 8214' },
  { label: 'luau source', text: 'local part = Instance.new("Part") part.Anchored = true' },
];

// ── A telemetry double that keeps everything it is handed ────────────────────

interface Received {
  spanNames: string[];
  eventNames: string[];
  metricNames: string[];
  attributes: Array<Record<string, unknown>>;
  exceptions: unknown[];
  statusMessages: Array<string | undefined>;
}

function recordingTelemetry(): { port: TelemetryPort; seen: Received } {
  const seen: Received = {
    spanNames: [],
    eventNames: [],
    metricNames: [],
    attributes: [],
    exceptions: [],
    statusMessages: [],
  };
  const context: SpanContext = {
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: '00f067aa0ba902b7',
    traceFlags: 1,
  };

  const port: TelemetryPort = {
    startSpan(name: string, attributes?: Attributes): Span {
      seen.spanNames.push(name);
      if (attributes) seen.attributes.push({ ...attributes });
      return {
        setAttributes(next) {
          seen.attributes.push({ ...next });
        },
        addEvent(eventName, eventAttributes) {
          seen.eventNames.push(eventName);
          if (eventAttributes) seen.attributes.push({ ...eventAttributes });
        },
        recordException(error) {
          seen.exceptions.push(error);
        },
        setStatus(_status, message) {
          seen.statusMessages.push(message);
        },
        end() {},
        context() {
          return context;
        },
      };
    },
    counter(name, _value, attributes) {
      seen.metricNames.push(name);
      if (attributes) seen.attributes.push({ ...attributes });
    },
    histogram(name, _value, attributes) {
      seen.metricNames.push(name);
      if (attributes) seen.attributes.push({ ...attributes });
    },
  };

  return { port, seen };
}

/**
 * Drive one value through every entry point the port has.
 *
 * "Every path" is the claim T1 makes, so the list is exhaustive against
 * `TelemetryPort` and `Span` rather than representative: if a method is added
 * to either interface without a line here, that is a path this test does not
 * cover and the omission should be visible in one diff.
 */
function pushThroughEveryPath(port: TelemetryPort, value: string): void {
  const span = port.startSpan(`fetch ${value}`, { 'http.url': value, [`attr.${value}`]: 'present' });
  span.setAttributes({ 'forgebridge.note': value });
  span.addEvent(`retry ${value}`, { detail: value });

  const failure = new Error(`request failed: ${value}`, { cause: new Error(`upstream said ${value}`) });
  failure.stack = `Error: request failed: ${value}\n    at fetch (/app/client.ts:1:1)`;
  span.recordException(failure);

  span.setStatus('error', `giving up after ${value}`);
  span.end();

  port.counter(`counter.${value}`, 1, { label: value });
  port.histogram(`histogram.${value}`, 12, { label: value });
}

/** Does `haystack` still contain `needle`, in raw or JSON-escaped form? */
function stillContains(haystack: string, needle: string): boolean {
  const escaped = JSON.stringify(needle).slice(1, -1);
  return haystack.includes(needle) || haystack.includes(escaped);
}

beforeEach(() => {
  forgetKnownSecrets();
});

// ── T1, the claim itself ─────────────────────────────────────────────────────

describe('no known credential format survives any telemetry path', () => {
  for (const planted of PLANTED) {
    it(`scrubs a ${planted.label} from every span, event, exception and metric`, () => {
      if (planted.label === 'producer-token') registerKnownSecret(planted.value);

      const { port, seen } = recordingTelemetry();
      pushThroughEveryPath(redactedTelemetry(port), planted.value);

      const everythingReceived = JSON.stringify(seen);
      expect(
        stillContains(everythingReceived, planted.probe),
        `a ${planted.label} reached the adapter intact`,
      ).toBe(false);
      // The adapter was still told something happened. A redactor that ate the
      // span entirely would pass the assertion above and destroy the trace.
      expect(seen.spanNames).toHaveLength(1);
      expect(seen.exceptions).toHaveLength(1);
      expect(seen.metricNames).toHaveLength(2);
    });
  }

  it('scrubs every planted format from a free-text line, which is what a log path is', () => {
    registerKnownSecret(PLANTED.find((entry) => entry.label === 'producer-token')!.value);
    for (const planted of PLANTED) {
      const line = `2026-02-14T09:31:07.412Z warn upstream rejected the call: ${planted.value} (attempt 2)`;
      expect(stillContains(redactText(line), planted.probe), planted.label).toBe(false);
      // The surrounding line is intact — the timestamp and the attempt number
      // are the reason anybody reads the log at all.
      expect(redactText(line)).toContain('2026-02-14T09:31:07.412Z');
      expect(redactText(line)).toContain('(attempt 2)');
    }
  });
});

describe('the OTLP adapter exports nothing a credential appears in', () => {
  it('scrubs every planted format from the bytes that would go on the wire', async () => {
    registerKnownSecret(PLANTED.find((entry) => entry.label === 'producer-token')!.value);

    const bodies: string[] = [];
    const telemetry = otlpTelemetry({
      endpoint: 'http://collector.invalid:4318',
      fetchImpl: (async (_url: string, init?: { body?: string }) => {
        bodies.push(String(init?.body ?? ''));
        return { ok: true, status: 200 } as Response;
      }) as unknown as typeof fetch,
    });

    for (const planted of PLANTED) pushThroughEveryPath(telemetry, planted.value);
    await telemetry.flush();

    const wire = bodies.join('\n');
    expect(wire.length).toBeGreaterThan(0);
    for (const planted of PLANTED) {
      expect(stillContains(wire, planted.probe), `a ${planted.label} reached the collector`).toBe(false);
    }
    // …and the export is still a usable trace.
    expect(wire).toContain('resourceSpans');
    expect(wire).toContain(REDACTED);
  });
});

describe('the error-reporter adapter reports nothing a credential appears in', () => {
  it('scrubs every planted format from captures and breadcrumbs', () => {
    registerKnownSecret(PLANTED.find((entry) => entry.label === 'producer-token')!.value);

    const captured: unknown[] = [];
    const crumbs: unknown[] = [];
    const client: ErrorReporterClient = {
      captureException(error, hint) {
        captured.push({
          name: (error as Error).name,
          message: (error as Error).message,
          stack: (error as Error).stack,
          hint,
        });
      },
      addBreadcrumb(breadcrumb) {
        crumbs.push(breadcrumb);
      },
    };

    const telemetry = errorReporterTelemetry({ client });
    for (const planted of PLANTED) pushThroughEveryPath(telemetry, planted.value);

    const everything = JSON.stringify({ captured, crumbs });
    for (const planted of PLANTED) {
      expect(stillContains(everything, planted.probe), `a ${planted.label} reached the reporter`).toBe(false);
    }
    expect(captured).toHaveLength(PLANTED.length);
    // Grouping survives: the reporter is handed a real Error, not a plain
    // object, which is the whole reason ADR-011 kept a reporter at all.
    expect(everything).toContain('Error');
  });
});

// ── The control: a rule that fires on ordinary code is not a rule ────────────

describe('ordinary values pass through untouched', () => {
  for (const control of ORDINARY) {
    it(`leaves a ${control.label} exactly as it was`, () => {
      expect(redactText(control.text)).toBe(control.text);
    });
  }

  it('leaves a whole attribute bag of ordinary values unchanged', () => {
    const attributes = {
      'forgebridge.run.id': '3f1b1a3e-0c7e-4a1e-9f2e-6d5c4b3a2918',
      'forgebridge.changeset.id': 'b2c9d1e4-5a6f-4703-8c1d-9e2f3a4b5c6d',
      'forgebridge.model.id': 'anthropic/claude-sonnet-4.5',
      'forgebridge.changeset.operations': 7,
      'forgebridge.autoapply.eligible': false,
      sessionKeyId: 'k_3f1b1a3e',
      promptTokens: 8214,
    };
    expect(redactAttributes(attributes)).toEqual(attributes);
  });
});

describe('attribute names decide on their own, whatever the value is', () => {
  it('redacts a credential-named attribute even when the value looks harmless', () => {
    // The fail-closed half. `sk_test_placeholder` is not a shape any rule
    // matches; the *name* is the whole evidence, and it is enough.
    expect(redactAttributes({ apiKey: 'keychain' })).toEqual({ apiKey: REDACTED });
    expect(redactAttributes({ authorization: 'anything at all' })).toEqual({ authorization: REDACTED });
  });

  it.each([
    ['apiKey', true],
    ['api_key', true],
    ['clientSecret', true],
    ['SESSION_KEY', true],
    ['authorization', true],
    ['refreshToken', true],
    ['sessionKeyId', false],
    ['apiKeyPrefix', false],
    ['hasApiKey', false],
    ['redactedSecret', false],
    ['promptTokens', false],
    ['forgebridge.run.id', false],
    ['secretsBackend', false],
  ])('namesCredential(%s) is %s', (name, expected) => {
    expect(namesCredential(String(name))).toBe(expected);
  });
});

describe('values the redactor cannot inspect are dropped, not exported', () => {
  it('replaces a non-primitive rather than serialising it', () => {
    // The `Attributes` type forbids this. A value arriving here anyway came
    // from a caller that ignored the type, and "the type system was bypassed"
    // does not argue for "serialise whatever this is".
    const bag = { payload: { nested: 'anything' } } as unknown as Record<string, unknown>;
    expect(String(redactAttributes(bag)['payload'])).toContain(REDACTED);
  });

  it('truncates an oversized value instead of shipping it whole', () => {
    const huge = 'a'.repeat(500_000);
    const out = String(redactAttributeValue('forgebridge.note', huge));
    expect(out.length).toBeLessThan(4096);
    expect(out).toContain(REDACTED);
  });

  it('refuses to register a value too short to be a credential', () => {
    // Registering "1" would turn every 1 in every trace into [redacted], which
    // is the fail-noisy failure in its purest form.
    expect(registerKnownSecret('short')).toBe(false);
    expect(redactText('a run of length 5 saw short output')).toBe('a run of length 5 saw short output');
  });
});

describe('exceptions reach an adapter as three redacted strings and nothing else', () => {
  it('drops everything the thrown object was carrying', () => {
    class ProviderError extends Error {
      // A real adapter error carries the request that failed. This is the field
      // that would put an Authorization header into a crash report.
      readonly requestHeaders = { authorization: ['Bearer', ' ', LONG].join('') };
      readonly responseBody = `{"error":"bad key ${['sk-', 'or-v1-', LONG].join('')}"}`;
    }
    const thrown = new ProviderError('the provider refused the call');

    const redacted = redactError(thrown);
    expect(Object.keys(redacted).sort()).toEqual(['message', 'name', 'stack']);
    expect(JSON.stringify(redacted)).not.toContain(LONG);
    expect(redacted.message).toBe('the provider refused the call');
  });

  it('flattens a cause chain, redacted, and stops before it becomes a graph walk', () => {
    const deep = new Error('a', {
      cause: new Error(`b ${['sk-', 'or-v1-', LONG].join('')}`, {
        cause: new Error('c', { cause: new Error('d', { cause: new Error('e') }) }),
      }),
    });
    const redacted = redactError(deep);
    expect(redacted.causes).toHaveLength(4);
    expect(JSON.stringify(redacted.causes)).not.toContain(LONG);
  });

  it('describes a non-Error throw rather than dropping it', () => {
    expect(redactError('a bare string').name).toBe('NonError');
    expect(redactError('a bare string').message).toContain('a bare string');
  });
});

describe('redaction is idempotent', () => {
  it('running the redactor twice produces the same text', () => {
    registerKnownSecret(PLANTED.find((entry) => entry.label === 'producer-token')!.value);
    for (const planted of PLANTED) {
      const once = redactText(`upstream: ${planted.value}`);
      expect(redactText(once)).toBe(once);
    }
  });
});
