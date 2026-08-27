/**
 * The shared redactor (M44, ADR-011, THREAT-MODEL T1).
 *
 * ADR-011 puts one obligation on this repository that a vendor SDK cannot
 * discharge for us: *the redaction logic must be implemented once at the port
 * rather than inherited from a vendor's defaults.* This file is that
 * implementation. `redactedTelemetry` in `telemetry.ts` is the only thing the
 * core hands an adapter, and it runs every attribute, every event, every
 * exception and every metric label through the functions below first.
 *
 * ── Why here and not in the adapter ──────────────────────────────────────────
 *
 * A key that has reached a vendor's SDK has already left the machine: the SDK
 * buffers it, writes it to a breadcrumb, and ships it on a schedule nobody in
 * this repository controls. `beforeSend` runs after the value is inside the
 * process that exports it. So the scrub has to happen on this side of the port,
 * on the way in, for every adapter at once.
 *
 * ── Three rules, and the reason each is drawn where it is ────────────────────
 *
 * R1  **A credential-shaped *name* redacts its value outright, whatever the
 *     value is.** `span.setAttributes({ apiKey: x })` never exports `x`. No
 *     length bar, no placeholder allowance, no inspection of the value at all —
 *     the caller told us what it is. This is the fail-closed half: a value we
 *     cannot classify under a name that says "credential" is redacted rather
 *     than passed, because "I do not recognise this" and "this is safe" must
 *     not be the same answer.
 *
 * R2  **A credential-shaped *value* is redacted wherever it appears**, in an
 *     attribute, a span name, an event name, an exception message or a stack
 *     frame. Every pattern in `VALUE_RULES` is a published prefix or delimiter —
 *     the same standard `scripts/verify-no-secrets.ts` holds its S1 rule to.
 *     Nothing here is a guess about what a secret might look like.
 *
 * R3  **A `name: value` pair inside free text** is redacted when the name says
 *     credential *and* the value looks like key material. Free text is where
 *     the fail-noisy risk lives: `"the api key is missing"` must survive intact
 *     or people learn to ignore redacted logs, which is the same outcome as no
 *     redaction. So the value must clear the same bar S2 in
 *     `verify-no-secrets.ts` already draws against this repository's own
 *     contents — twelve characters, no whitespace, letters and digits both.
 *
 * ── What it cannot do, stated so nothing downstream overclaims ───────────────
 *
 *   - It cannot catch a credential with no published shape, sitting in a bare
 *     string under a blandly named attribute, in prose with no `name:` in front
 *     of it. `registerKnownSecret` exists for exactly that case: a host that
 *     *holds* such a value (the daemon and its producer token) registers it and
 *     the redactor then scrubs it by exact match. A host that forgets to
 *     register is not covered, and this sentence is the honest form of that.
 *   - It is not a proof that the core never *constructs* an attribute out of a
 *     key. `scripts/verify-no-key-storage.ts` K3 is the static half of that
 *     claim; this file is the runtime half. Neither one implies the other.
 */

/** What replaces a redacted value in full. */
export const REDACTED = '[redacted]';

/**
 * Attribute values above this are truncated.
 *
 * Fail-closed, in the shape this port's own header warns about: `Attributes` is
 * narrow so that nobody dumps a ChangeSet into a span, but a caller can still
 * stringify one. A truncated span is a smaller harm than a span carrying a
 * whole model response — and a truncation marker says which happened, where
 * silently exporting the lot would not.
 */
export const MAX_ATTRIBUTE_CHARS = 2048;

/** `redactText` gives up past this and redacts the whole string. See `redactText`. */
const MAX_SCANNABLE_CHARS = 64 * 1024;

/**
 * R1 — names whose value is a credential. Kept deliberately in step with the
 * `CREDENTIAL_NAME` vocabulary in `scripts/verify-no-secrets.ts` and the marker
 * list in `scripts/verify-no-key-storage.ts`: the static gates and the runtime
 * redactor disagreeing about what the word "secret" means is how a value passes
 * both.
 */
const CREDENTIAL_NAME =
  /(?:api[_-]?key|secret|password|passwd|passphrase|private[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|bearer[_-]?token|id[_-]?token|client[_-]?secret|session[_-]?key|service[_-]?role[_-]?key|credential|authorization|cookie|set[-_]?cookie)/i;

/**
 * R1's exemption, and the reason this rule is not fail-noisy: a name that
 * *identifies* a credential is not a credential. `sessionKeyId` is stored on
 * `Link` on purpose and is safe to trace; `apiKeyPrefix` is what a UI shows.
 * The same distinction `verify-no-key-storage.ts` draws by hand, drawn here the
 * same way so the two cannot drift apart silently.
 */
const IDENTIFIER_SUFFIX =
  /(?:id|ids|uuid|name|names|ref|refs|hash|digest|fingerprint|prefix|suffix|kind|type|label|scope|source|backend|provider|status|state|count|length|limit|at|ttl|expiry|expires|version|format|pattern|placeholder|url|uri|path|header|field|column|env|var|required|present|missing|configured|enabled|redactor|redaction|error|message|mode|policy|rule|alphabet|chars)$/i;

/** R1's other exemption: a claim *about* a credential. `hasApiKey` is a boolean. */
const PREDICATE_PREFIX =
  /^(?:has|is|was|should|must|requires?|needs?|no|without|redacted|masked|scrubbed|redact|mask|scrub|allow|deny)(?:[_-]|[A-Z])/;

/** `session_key_id` and `sessionKeyId` reduce to the same words. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/**
 * R1 — does this attribute key name a credential *value*?
 *
 * Exported because a rule nobody can test in isolation is a rule whose
 * exemptions nobody checks. The control cases — `sessionKeyId`,
 * `hasApiKey`, `promptTokens` — are asserted in
 * `packages/core/test/redact.test.ts` beside the positive ones.
 */
export function namesCredential(name: string): boolean {
  if (!CREDENTIAL_NAME.test(name)) return false;
  const segments = words(name);
  if (segments.length === 0) return false;
  const last = segments[segments.length - 1] ?? '';
  if (segments.length > 1 && IDENTIFIER_SUFFIX.test(last)) return false;
  if (PREDICATE_PREFIX.test(name)) return false;
  // `promptTokens` counts units of text. Only reachable when the name also
  // matched CREDENTIAL_NAME, which "tokens" alone does not — kept for the
  // compound forms (`maxAccessTokens` would be a strange name, and is not one
  // this rule should redact a number for).
  if (segments.includes('tokens') || segments.includes('token')) {
    const counting = ['prompt', 'completion', 'context', 'input', 'output', 'total', 'max', 'min', 'cost', 'budget', 'used', 'remaining'];
    if (segments.some((word) => counting.includes(word))) return false;
  }
  return true;
}

export interface RedactionRule {
  /** Printed in place of the match, so a reader of a trace knows what was cut. */
  readonly label: string;
  readonly pattern: RegExp;
}

/**
 * The PEM delimiter, built from parts.
 *
 * `scripts/verify-no-secrets.ts` S1 matches this shape anywhere in the working
 * tree, and it does not exempt this file. A redactor that cannot be committed
 * because it trips the secret gate is not a redactor, and adding an exemption
 * would widen the gate's blind spot to cover the one file most likely to
 * contain a real-looking sample. So the literal is assembled at module load and
 * the source line never contains `-----BEGIN` followed by a space.
 */
const PEM_BLOCK = new RegExp(
  ['-----BEGIN', ' (?:[A-Z0-9 ]+ )?PRIVATE KEY', '-----[\\s\\S]*?-----END', ' (?:[A-Z0-9 ]+ )?PRIVATE KEY', '-----'].join(''),
  'g',
);

/**
 * R2 — value shapes that are a credential or nothing.
 *
 * Order matters only for readability; every rule is applied. Each entry is a
 * documented, published prefix. `sk-or-` leads because OpenRouter is this
 * project's default egress (ADR-006) and an OpenRouter key is the single most
 * likely credential to appear anywhere near a ForgeBridge trace.
 */
export const VALUE_RULES: readonly RedactionRule[] = [
  { label: 'openrouter-key', pattern: /\bsk-or-(?:v\d+-)?[A-Za-z0-9_-]{12,}/g },
  { label: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{12,}/g },
  { label: 'openai-key', pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { label: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g },
  { label: 'github-fine-grained-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{50,}/g },
  { label: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { label: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { label: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'stripe-key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { label: 'sendgrid-key', pattern: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g },
  { label: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { label: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g },
  { label: 'private-key-block', pattern: PEM_BLOCK },
  /**
   * The header form, and the reason it is a shape rule rather than a name rule:
   * an error thrown by `fetch` carries the request line, not a structured
   * attribute, so `Authorization: Bearer …` arrives inside a message string
   * where R1 can never see it.
   */
  { label: 'bearer-token', pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{12,}/g },
  {
    label: 'basic-auth',
    pattern: /\b[Bb]asic\s+[A-Za-z0-9+/=]{12,}/g,
  },
  /**
   * Credentials in a URL: `https://user:pass@host` and `?api_key=…`. Both reach
   * telemetry through the same door — a failed request's message names the URL
   * it failed against.
   */
  { label: 'url-userinfo', pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi },
  {
    label: 'url-credential-parameter',
    pattern: /([?&](?:api[_-]?key|access[_-]?token|auth|token|key|secret|signature|sig)=)[^&\s"'<>]+/gi,
  },
];

/**
 * R3 — `name: value` and `name=value` inside free text.
 *
 * The value bar is deliberately the one `verify-no-secrets.ts` S2 already draws
 * against this repository: twelve characters, no whitespace, at least one digit
 * and at least one letter. It was tuned so that `secretsBackend: 'keychain'`
 * and `password: changeme` do not fire, which is exactly the fail-noisy case
 * this rule would otherwise create.
 */
const NAMED_ASSIGNMENT = /(["']?[A-Za-z_][A-Za-z0-9_-]*["']?\s*[:=]\s*)(["'`]?)([^\s"'`,;)\]}]{8,})\2/g;

function looksLikeKeyMaterial(value: string): boolean {
  if (value.length < 12) return false;
  if (/\s/.test(value)) return false;
  return /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

/**
 * Values a host knows to be secrets, scrubbed by exact match.
 *
 * The daemon's producer token is 256 bits of base64url (`auth.ts`) and has no
 * distinguishing prefix; no shape rule can tell it from a content digest, and a
 * rule that tried would fire on every digest in every trace. Exact-match
 * scrubbing is the only honest answer: the process that *minted* the value
 * registers it, and from then on it never leaves in a span.
 *
 * A `Set` rather than an array so re-registering is free, and the values are
 * held only for the life of the process — nothing here is written anywhere.
 */
const knownSecrets = new Set<string>();

/**
 * Register a value this process knows to be a credential.
 *
 * Short values are refused rather than accepted: registering `"1"` would turn
 * every `1` in every trace into `[redacted]`, which is the fail-noisy failure
 * in its purest form. Returns whether the value was taken, so a caller that
 * cares can tell "registered" from "silently ignored".
 */
export function registerKnownSecret(value: string): boolean {
  if (typeof value !== 'string' || value.length < 12) return false;
  knownSecrets.add(value);
  return true;
}

/** Drop every registered value. Exists for tests; a process has no reason to call it. */
export function forgetKnownSecrets(): void {
  knownSecrets.clear();
}

/**
 * Scrub one string.
 *
 * Applied to every string the port can carry: attribute values, span and event
 * names, exception messages and stack frames. Idempotent — running it twice
 * produces the same text, which matters because an adapter may re-scrub on
 * export and `[redacted:jwt]` must not then be mistaken for something else.
 */
export function redactText(text: string): string {
  if (text.length === 0) return text;
  if (text.length > MAX_SCANNABLE_CHARS) {
    // Fail closed. A string this size is a dumped body, and scanning it with
    // fifteen global regexes on a hot path is its own denial of service. We do
    // not know what is in it, so we do not export it.
    return `${REDACTED} (${text.length} characters, too large to scan)`;
  }

  let out = text;

  for (const secret of knownSecrets) {
    if (out.includes(secret)) {
      out = out.split(secret).join(`${REDACTED}:known`);
    }
  }

  for (const rule of VALUE_RULES) {
    // `lastIndex` is reset because these RegExp objects are module-level and
    // global-flagged; a shared global regex that keeps its cursor between calls
    // silently skips matches on every other invocation.
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, (match, ...rest) => {
      const groups = rest.slice(0, Math.max(0, rest.length - 2));
      // A rule with a capture group keeps the group — `https://` and `?api_key=`
      // are context a reader needs, and neither is the credential.
      const kept = typeof groups[0] === 'string' ? groups[0] : '';
      void match;
      return `${kept}${REDACTED}:${rule.label}`;
    });
  }

  out = out.replace(NAMED_ASSIGNMENT, (match, lead: string, quote: string, value: string) => {
    const name = lead.replace(/["'\s:=]/g, '');
    if (!namesCredential(name)) return match;
    if (!looksLikeKeyMaterial(value)) return match;
    return `${lead}${quote}${REDACTED}${quote}`;
  });

  return out;
}

/**
 * Scrub one attribute value, given its key.
 *
 * Non-primitive values are not stringified and shipped; they are replaced. The
 * `Attributes` type already forbids them, so a value arriving here that is not
 * a string, a number or a boolean came from a JavaScript caller that ignored
 * the type — and the safe reading of "the type system was bypassed" is not
 * "serialise whatever this is".
 */
export function redactAttributeValue(name: string, value: unknown): string | number | boolean {
  if (namesCredential(name)) return REDACTED;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value !== 'string') return `${REDACTED} (unsupported ${value === null ? 'null' : typeof value})`;

  const scrubbed = redactText(value);
  if (scrubbed.length <= MAX_ATTRIBUTE_CHARS) return scrubbed;
  return `${scrubbed.slice(0, MAX_ATTRIBUTE_CHARS)}… (truncated from ${scrubbed.length})`;
}

/** Scrub a whole attribute bag. Keys are scrubbed too: a key can carry a value. */
export function redactAttributes<T extends Record<string, unknown>>(
  attributes: T | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!attributes) return out;
  for (const [name, value] of Object.entries(attributes)) {
    out[redactText(name)] = redactAttributeValue(name, value);
  }
  return out;
}

/**
 * What an adapter is allowed to know about a thrown value.
 *
 * Never the value itself. An `Error` subclass can carry anything on it — a
 * response body, a request object, the headers of the call that failed — and an
 * adapter that receives the object will serialise all of it. So the port hands
 * over three redacted strings and nothing else.
 */
export interface RedactedError {
  name: string;
  message: string;
  stack?: string;
  /** Present when the thrown value had a `cause`. Flattened, not nested, and bounded. */
  causes?: string[];
}

const MAX_CAUSE_DEPTH = 4;

export function redactError(error: unknown): RedactedError {
  if (!(error instanceof Error)) {
    return { name: 'NonError', message: redactAttributeValue('thrown', String(error)).toString() };
  }

  const out: RedactedError = {
    name: redactText(error.name),
    message: String(redactAttributeValue('message', error.message)),
  };
  if (typeof error.stack === 'string') {
    out.stack = String(redactAttributeValue('stack', error.stack));
  }

  const causes: string[] = [];
  let cause: unknown = (error as { cause?: unknown }).cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cause !== undefined && cause !== null; depth += 1) {
    const text = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    causes.push(String(redactAttributeValue('cause', text)));
    cause = cause instanceof Error ? (cause as { cause?: unknown }).cause : undefined;
  }
  if (causes.length > 0) out.causes = causes;

  return out;
}
