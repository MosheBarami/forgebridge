/**
 * `HttpService` requests to a host the project has not allowlisted.
 *
 * Egress is the point where a place stops being a closed system: a request
 * carries whatever the script puts in it out to somebody else's server, and the
 * response comes back as input the script trusts. The project's allowed-host
 * list is the statement of which servers those may be, and an empty list means
 * none — the same fail-closed reading the policy check gives an empty path
 * allowlist.
 */
import type { Finding } from '@forgebridge/protocol';
import type { Token } from '../tokenizer.js';
import {
  findingAt,
  isName,
  isOp,
  memberChain,
  splitArguments,
  type RuleContext,
} from '../query.js';
import type { Rule } from './index.js';

/** Methods that leave the machine. `JSONEncode` and `GenerateGUID` are on the same service and do not. */
const EGRESS_METHODS: ReadonlySet<string> = new Set(['GetAsync', 'PostAsync', 'RequestAsync']);

/**
 * Host match. Exact by default; an entry written `.example.com` or `*.example.com`
 * also matches subdomains.
 *
 * Segment-aware on purpose. A `startsWith`/`endsWith` written without the dot
 * would let `example.com.attacker.net` through an `example.com` entry, which is
 * the same class of bug `isWithin` in the protocol's `path.ts` exists to avoid.
 */
export function hostMatches(host: string, entry: string): boolean {
  const target = normaliseHost(host);
  let pattern = entry.trim().toLowerCase();
  if (pattern.startsWith('*.')) pattern = pattern.slice(1);
  if (pattern.startsWith('.')) {
    const bare = pattern.slice(1);
    return target === bare || target.endsWith(pattern);
  }
  return target === normaliseHost(pattern);
}

/**
 * Lowercased, without a scheme, credentials, port, path or trailing dot.
 *
 * ORDER IS LOAD-BEARING. Userinfo lives in the authority component, which ends
 * at the first `/`, `?` or `#`. Stripping at `@` before cutting the path reads
 * `https://evil.com/@api.example.com` as host `api.example.com` — so a URL that
 * really reaches evil.com passes an allowlist containing api.example.com. That
 * exact string was confirmed to return zero findings before this was fixed.
 */
export function normaliseHost(value: string): string {
  let host = value.trim().toLowerCase();
  const scheme = host.indexOf('://');
  if (scheme !== -1) host = host.slice(scheme + 3);
  // Authority ends here. Everything after is path/query/fragment.
  host = host.split('/')[0] ?? host;
  host = host.split('?')[0] ?? host;
  host = host.split('#')[0] ?? host;
  const at = host.lastIndexOf('@');
  if (at !== -1) host = host.slice(at + 1);
  const colon = host.lastIndexOf(':');
  if (colon > 0 && !host.includes(']')) host = host.slice(0, colon);
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

/** The host of an absolute URL, or null when the string is not one. */
export function hostOf(url: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim())) return null;
  const host = normaliseHost(url);
  return host.length === 0 ? null : host;
}

export const httpEgressUnallowlisted: Rule = {
  id: 'luau/http-egress-unallowlisted',
  severities: ['error', 'warning'],
  summary: 'An `HttpService` request to a host that is not on the project\'s allowed-host list.',
  run(context: RuleContext): Finding[] {
    const { tokens, allowedHttpHosts } = context;
    const findings: Finding[] = [];
    const serviceNames = httpServiceBindings(context);
    // Whether this source touches HttpService at all. Gates the fail-closed
    // branch above so a DataStore's `:GetAsync` is not mistaken for egress.
    const sourceTouchesHttpService = tokens.some(
      (t) =>
        (t.kind === 'name' && serviceNames.has(t.text)) ||
        (t.kind === 'string' && (t.value ?? t.text) === 'HttpService'),
    );
    const allowed = allowedHttpHosts.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    const allowedText =
      allowed.length === 0
        ? 'this project allows no hosts at all, so every outbound request is a finding'
        : `allowed: ${allowed.join(', ')}`;

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === undefined || token.kind !== 'name' || !EGRESS_METHODS.has(token.text)) continue;
      if (!isOp(tokens, i - 1, ':')) continue;

      // Receiver resolution, fail-closed.
      //
      // The previous version skipped anything it did not recognise, which meant
      // the two most ordinary spellings in Roblox code walked straight past it:
      //   game:GetService("HttpService"):GetAsync(url)   -- receiver is `)`
      //   local H: HttpService = ...  H:GetAsync(url)    -- binding walk-back missed
      // A rule that answers "I don't recognise this, so it's fine" is not a
      // security rule. Now: a known binding is a hit; a receiver we cannot
      // resolve is ALSO a hit, but only when this source touches HttpService at
      // all — `dataStore:GetAsync(key)` is not egress and must not be flagged.
      const receiver = tokens[i - 2];
      const namedReceiver =
        receiver !== undefined && receiver.kind === 'name' && serviceNames.has(receiver.text);
      const chainedReceiver = receiver !== undefined && receiver.kind === 'op' && receiver.text === ')';
      const unresolvedReceiver = !namedReceiver && !chainedReceiver;

      if (unresolvedReceiver && !sourceTouchesHttpService) continue;
      if (unresolvedReceiver) {
        findings.push(
          findingAt(
            token,
            'warning',
            'luau/http-egress-unallowlisted',
            `This source uses \`HttpService\`, and \`:${token.text}\` is called on something this check ` +
              'cannot resolve, so it cannot tell whether the call goes out to the network ' +
              `(${allowedText}). Call the service through a plain local variable so the destination is ` +
              'readable in the diff.',
          ),
        );
        continue;
      }

      // Call-form resolution, fail-closed.
      //
      // Luau lets a single argument be passed with no parentheses: `f"str"` and
      // `f{tbl}` are calls. Requiring `(` meant deleting two characters removed
      // the rule, and a table-constructor call is the natural spelling of
      // RequestAsync{Url = ...}.
      const next = tokens[i + 1];
      const callOpen =
        isOp(tokens, i + 1, '(') ? 'paren'
        : next !== undefined && next.kind === 'string' ? 'string'
        : isOp(tokens, i + 1, '{') ? 'table'
        : null;

      if (callOpen === null) continue; // not a call at all: `local f = H.GetAsync`

      if (callOpen === 'table') {
        findings.push(
          findingAt(
            token,
            'warning',
            'luau/http-egress-unallowlisted',
            `\`HttpService:${token.text}\` is called with a table, so the destination is inside a field ` +
              `this check does not read (${allowedText}). Pass the URL as a literal string argument, or ` +
              'assign it to a local from a literal so the host is visible.',
          ),
        );
        continue;
      }

      if (callOpen === 'string') {
        const literal = next as typeof token;
        const directHost = hostOf(literal.value ?? literal.text);
        if (directHost !== null && allowed.some((entry) => hostMatches(directHost, entry))) continue;
        findings.push(
          findingAt(
            literal,
            directHost === null ? 'warning' : 'error',
            'luau/http-egress-unallowlisted',
            directHost === null
              ? `\`HttpService:${token.text}\` is given a string this check cannot read as an absolute URL ` +
                `(${allowedText}). Pass a full \`https://host/path\` URL.`
              : `\`HttpService:${token.text}\` reaches \`${directHost}\`, which is not on this project's ` +
                `allowed-host list (${allowedText}). A place that talks to an unreviewed host can send ` +
                'player data out of the game and can take instructions back in.',
          ),
        );
        continue;
      }

      const url = urlArgument(context, i + 1, token.text);

      if (url === null) {
        findings.push(
          findingAt(
            token,
            'warning',
            'luau/http-egress-unallowlisted',
            `The URL passed to \`HttpService:${token.text}\` is built at run time, so this check cannot tell ` +
              `which host it reaches (${allowedText}). Pass a literal URL, or build it from a literal base ` +
              'that is on the allowed-host list, so the destination is visible in the diff.',
          ),
        );
        continue;
      }

      const host = hostOf(url.value);
      if (host === null) {
        findings.push(
          findingAt(
            url.token,
            'warning',
            'luau/http-egress-unallowlisted',
            `\`HttpService:${token.text}\` is given ${JSON.stringify(url.value.slice(0, 120))}, which is not an ` +
              'absolute URL, so no host can be read out of it and it cannot be checked against the ' +
              `allowed-host list (${allowedText}). Pass a full \`https://host/path\` URL.`,
          ),
        );
        continue;
      }

      if (allowed.some((entry) => hostMatches(host, entry))) continue;

      findings.push(
        findingAt(
          url.token,
          'error',
          'luau/http-egress-unallowlisted',
          `\`HttpService:${token.text}\` reaches \`${host}\`, which is not on this project's allowed-host ` +
            `list (${allowedText}). A place that talks to an unreviewed host can send player data out of ` +
            'the game and can take instructions back in. Add the host to the project\'s allowed hosts if it ' +
            'is one you control, or drop the request.',
        ),
      );
    }

    return findings;
  },
};

/**
 * Names bound to `HttpService` in this source: the literal `HttpService`, plus
 * any variable assigned from `…:GetService("HttpService")`.
 *
 * Without the second half the rule would miss the shape almost every real
 * script uses, and a rule that misses the common case is a rule that reports
 * `ok` on the thing it was written to catch.
 */
function httpServiceBindings(context: RuleContext): Set<string> {
  const { tokens, structure } = context;
  const names = new Set<string>(['HttpService']);

  for (let i = 0; i < tokens.length; i += 1) {
    if (!isName(tokens, i, 'GetService')) continue;
    if (!isOp(tokens, i - 1, ':')) continue;
    if (!isOp(tokens, i + 1, '(')) continue;
    const parts = splitArguments(tokens, structure, i + 1);
    const first = parts[0];
    if (first === undefined) continue;
    const argument = tokens[first.start];
    if (argument === undefined || argument.kind !== 'string' || argument.value !== 'HttpService') continue;

    // Walk back over `local X =` / `X =` to the name being bound.
    const chainStart = i - 2 - (memberChain(tokens, i - 2).length - 1) * 2;
    const equals = chainStart - 1;
    if (!isOp(tokens, equals, '=')) continue;
    const bound = tokens[equals - 1];
    if (bound === undefined || bound.kind !== 'name') continue;
    names.add(bound.text);
  }

  return names;
}

/** The literal URL passed to an egress call, or null when it is not a literal. */
function urlArgument(
  context: RuleContext,
  openParen: number,
  method: string,
): { value: string; token: Token } | null {
  const { tokens, structure } = context;
  const parts = splitArguments(tokens, structure, openParen);
  const first = parts[0];
  if (first === undefined) return null;

  if (method === 'RequestAsync') {
    // `HttpService:RequestAsync({ Url = "https://…", Method = "POST" })`
    for (let i = first.start; i < first.end; i += 1) {
      const key = tokens[i];
      if (key === undefined || key.kind !== 'name') continue;
      if (key.text !== 'Url' && key.text !== 'url') continue;
      if (!isOp(tokens, i + 1, '=')) continue;
      const value = tokens[i + 2];
      if (value === undefined || value.kind !== 'string' || value.value === undefined) return null;
      return { value: value.value, token: value };
    }
    return null;
  }

  const argument = tokens[first.start];
  if (argument === undefined || argument.kind !== 'string' || argument.value === undefined) return null;
  // A concatenation like `BASE .. path` is not a literal URL, even though it
  // starts with one; reporting the literal half would be a lie about coverage.
  if (first.end - first.start !== 1) return null;
  return { value: argument.value, token: argument };
}
