/**
 * Key-custody gate — the CI half of Promise 4 and of ADR-006.
 *
 * The promise in README.md and docs/GOVERNANCE.md is that keys stay with the
 * user: the OS keychain or a non-extractable WebCrypto key, the daemon as the
 * BYOK egress, and exactly one key on the official instance's servers — its
 * own. THREAT-MODEL T1 states the strong form of it: *there is no column for
 * them; the schema cannot hold one.* That sentence is a claim about the shapes
 * in this repository, which makes it something a machine can check.
 *
 * Four rules, each one a way the claim could quietly stop being true:
 *
 *   K1  no persisted shape declares a credential-shaped field  — the "no column
 *       for them" claim, checked over every Zod schema, TypeScript interface
 *       and SQL table under the scanned roots.
 *   K2  no StoragePort method accepts or returns a credential  — a port that can
 *       carry a key will eventually be handed one, whatever the adapter intends.
 *   K3  no credential-shaped value reaches disk, a database, a  — T1 again, from
 *       response body, a log, or telemetry                        the call side.
 *   K4  no shape the daemon persists holds a provider key      — ADR-006's own
 *                                                                 sentence, at
 *                                                                 the daemon's
 *                                                                 store seam.
 *
 * K4 is a special case of K1 and says so; it is reported separately because it
 * is the exact claim ADR-006 makes, and a failure that names the ADR is a
 * failure someone can act on without first reconstructing why the rule exists.
 *
 * ── Persisted versus transient ────────────────────────────────────────────────
 *
 * K1 turns on a distinction, so it has to be drawn mechanically rather than by
 * taste. A declaration is **persisted** when this file can point at evidence
 * that a value of that shape is written somewhere outliving the process:
 *
 *   (a) it is declared in a persistence module — a path whose basename or
 *       directory is `store`, `storage`, `schema`, `migration(s)`, `persist*`,
 *       `repository`, `entity`, or any `.sql` file; or it is a SQL table; or
 *   (b) it is named in the signature of a store seam — an interface called
 *       `StoragePort` or ending in `Store`; or
 *   (c) it is referenced, transitively, by the fields of a shape that is
 *       already persisted. `interface ProjectRecord { auth: AuthBlob }` drags
 *       `AuthBlob` in, wherever `AuthBlob` happens to be declared.
 *
 * Everything else is **transient**: request and response bodies, in-memory
 * return values, options bags. `RedeemedPairing.sessionKey` in the daemon is
 * the canonical transient credential — a real key, in a real field, that this
 * gate must let through, because it goes to an in-process keyring and never to
 * a store. A gate that flagged it would be a gate somebody switches off.
 *
 * ── Credential-shaped versus credential-adjacent ─────────────────────────────
 *
 * `sessionKeyId` is an IDENTIFIER: it names a key without being one, it is
 * stored on `Link` on purpose, and it is safe to log. `sessionKey` is the key.
 * The rule that separates them: a name is credential-shaped when it carries a
 * credential marker AND does not end in an identifier-ish word (`id`, `name`,
 * `hash`, `ref`, `scope`, `count`, …) or begin with a predicate (`has`, `is`,
 * `redacted`, …). A second exemption covers the other collision in an AI
 * codebase: `promptTokens` counts units of text, not bearer tokens, so
 * `token(s)` next to a counting word (`prompt`, `context`, `max`, `cost`, …) is
 * allowed. Both exemptions are printed in the summary, by name, every run —
 * an exemption nobody reads is a hole nobody notices.
 *
 * ── What this gate does not prove ────────────────────────────────────────────
 *
 * It reads declarations and call sites in `packages/` and `apps/`. It does not
 * run the daemon, does not inspect the Luau plugin, cannot see what an adapter
 * that has not been written yet will do, and cannot catch a key smuggled
 * through a blandly named `string`. The summary says so on every run, so the
 * sentence it backs can be written to match.
 *
 * Run:  npm run verify:no-key-storage
 * Exit: 0 clean, 1 with one line per violation.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface KeyStorageViolation {
  rule: 'K1' | 'K2' | 'K3' | 'K4';
  file: string;
  detail: string;
}

/** Trees the gate reads. `scripts/` is excluded for the reason B3 assembles its needle: this file names the words it hunts for. */
const SCAN_ROOTS = ['packages', 'apps'] as const;

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo', '.git', '.venv', '__pycache__']);
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const SQL_EXTENSIONS = new Set(['.sql']);

// ── Naming ───────────────────────────────────────────────────────────────────

/** Words that mark a name as being about a credential at all. */
const CREDENTIAL_WORDS = new Set([
  'secret', 'secrets', 'password', 'passwords', 'passwd', 'pwd',
  'credential', 'credentials', 'creds', 'bearer', 'token', 'tokens', 'apikey',
]);

/** `key` is too common to ban outright; it is a credential when one of these stands next to it. */
const KEY_QUALIFIERS = new Set([
  'api', 'access', 'private', 'secret', 'session', 'signing', 'encryption',
  'master', 'provider', 'auth', 'client', 'service', 'refresh', 'wrapping', 'root', 'account',
]);

/** …or when one of these follows it: `keyMaterial` is the material of a key. */
const KEY_OBJECTS = new Set(['material', 'bytes', 'value', 'blob', 'hex', 'b64', 'base64']);

/** Compact forms that survive any casing convention. */
const COMPACT_MARKERS = [
  'apikey', 'accesskey', 'privatekey', 'secretkey', 'sessionkey',
  'clientsecret', 'authtoken', 'bearertoken', 'refreshtoken', 'accesstoken',
];

/**
 * Trailing words that turn a credential name into a name *for* a credential.
 * A hash, a fingerprint and an id all identify a key without being usable as
 * one; a scope, a kind and a count describe one.
 */
const IDENTIFIER_SUFFIXES = new Set([
  'id', 'ids', 'uuid', 'name', 'names', 'ref', 'refs', 'hash', 'hashes', 'digest',
  'fingerprint', 'prefix', 'suffix', 'kind', 'type', 'types', 'label', 'scope', 'scopes',
  'source', 'backend', 'provider', 'status', 'state', 'count', 'counts', 'length',
  'limit', 'at', 'ttl', 'expiry', 'expires', 'version', 'format', 'pattern',
  'placeholder', 'url', 'uri', 'path', 'header', 'field', 'column', 'env', 'var',
  'required', 'present', 'missing', 'configured', 'enabled', 'redactor', 'redaction',
  'error', 'errors', 'message', 'mode', 'policy', 'rule', 'rules', 'alphabet', 'chars',
]);

/** Leading words that make the field a claim about a credential rather than the thing. */
const PREDICATE_PREFIXES = new Set([
  'has', 'is', 'was', 'should', 'must', 'requires', 'require', 'needs', 'no',
  'without', 'redacted', 'masked', 'scrubbed', 'redact', 'mask', 'scrub', 'allow', 'deny',
]);

/** Words that, standing beside `token(s)`, mean a unit of text rather than a bearer credential. */
const TOKEN_COUNT_QUALIFIERS = new Set([
  'prompt', 'completion', 'context', 'input', 'output', 'total', 'max', 'min',
  'cached', 'reasoning', 'per', 'budget', 'cost', 'price', 'window', 'count',
  'used', 'remaining', 'limit', 'estimated', 'chunk', 'unit', 'units',
]);

/** `sessionKeyId` -> ['session','key','id']; `API_KEY` -> ['api','key']. */
export function segmentIdentifier(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/** Why this name looks like it is about a credential, or null if it does not. */
export function credentialMarker(identifier: string): string | null {
  const compact = identifier.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const marker of COMPACT_MARKERS) {
    if (compact.includes(marker)) return marker;
  }
  const words = segmentIdentifier(identifier);
  for (const word of words) {
    if (CREDENTIAL_WORDS.has(word)) return word;
  }
  for (let i = 0; i < words.length; i += 1) {
    if (words[i] !== 'key' && words[i] !== 'keys') continue;
    const before = words[i - 1];
    const after = words[i + 1];
    if (before !== undefined && KEY_QUALIFIERS.has(before)) return `${before} key`;
    if (after !== undefined && KEY_OBJECTS.has(after)) return `key ${after}`;
  }
  return null;
}

/**
 * Why a credential-marked name is nonetheless not a credential *value*, or null
 * when it is one. Returned rather than a boolean so the summary can print the
 * reason: a reader judging the promise needs to see what was waved through.
 */
export function credentialAllowance(identifier: string): string | null {
  const words = segmentIdentifier(identifier);
  if (words.length === 0) return null;

  const last = words[words.length - 1]!;
  if (words.length > 1 && IDENTIFIER_SUFFIXES.has(last)) {
    return `names a credential without being one (trailing "${last}")`;
  }

  const first = words[0]!;
  if (words.length > 1 && PREDICATE_PREFIXES.has(first)) {
    return `a claim about a credential, not the value (leading "${first}")`;
  }

  if (words.includes('token') || words.includes('tokens')) {
    const counting = words.find((word) => TOKEN_COUNT_QUALIFIERS.has(word));
    if (counting !== undefined) {
      return `a count of text tokens, not a bearer token (beside "${counting}")`;
    }
  }

  return null;
}

/** A name that would hold a usable credential. */
export function isCredentialShaped(identifier: string): boolean {
  return credentialMarker(identifier) !== null && credentialAllowance(identifier) === null;
}

// ── Lexing ───────────────────────────────────────────────────────────────────

/**
 * Blank out comments and string bodies, preserving every offset and newline, so
 * that a brace inside a regex or a `//` inside a URL cannot desync the scanner
 * and a word inside a log message cannot be mistaken for an identifier.
 *
 * Template literals keep their `${...}` expressions live: interpolating a key
 * into a log line is precisely the case K3 exists to catch.
 */
export function blankNonCode(source: string): string {
  const out = source.split('');
  const n = source.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  // Each entry is a template literal we are inside; the number is the brace
  // depth of the interpolation we are currently in, or -1 for the literal part.
  const templates: number[] = [];
  let braceDepth = 0;
  let previous = '';
  let i = 0;

  while (i < n) {
    const c = source[i]!;
    const d = i + 1 < n ? source[i + 1] : '';
    const inTemplateText = templates.length > 0 && templates[templates.length - 1] === -1;

    if (inTemplateText) {
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      if (c === '`') { templates.pop(); i += 1; previous = '`'; continue; }
      if (c === '$' && d === '{') { templates[templates.length - 1] = braceDepth; braceDepth += 1; i += 2; previous = '{'; continue; }
      blank(i, i + 1);
      i += 1;
      continue;
    }

    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && source[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && source[j] !== c) {
        if (source[j] === '\\') j += 1;
        if (source[j] === '\n') break;
        j += 1;
      }
      blank(i + 1, j);
      i = Math.min(j + 1, n);
      previous = c;
      continue;
    }
    if (c === '`') {
      templates.push(-1);
      i += 1;
      previous = '`';
      continue;
    }
    if (c === '/' && startsRegex(previous)) {
      const end = scanRegex(source, i);
      if (end !== null) {
        blank(i + 1, end - 1);
        i = end;
        previous = '/';
        continue;
      }
    }
    if (c === '{') braceDepth += 1;
    if (c === '}') {
      braceDepth -= 1;
      if (templates.length > 0 && templates[templates.length - 1] === braceDepth) {
        templates[templates.length - 1] = -1;
        i += 1;
        continue;
      }
    }
    if (!/\s/.test(c)) previous = c;
    i += 1;
  }
  return out.join('');
}

/** After one of these, a `/` opens a regex literal rather than dividing. */
function startsRegex(previous: string): boolean {
  return previous === '' || '(,=:[!&|?+-*%~^<>;{}'.includes(previous);
}

/** Index just past a regex literal starting at `start`, or null if it is division after all. */
function scanRegex(source: string, start: number): number | null {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const c = source[i]!;
    if (c === '\n') return null;
    if (c === '\\') { i += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      i += 1;
      while (i < source.length && /[a-z]/.test(source[i]!)) i += 1;
      return i;
    }
    i += 1;
  }
  return null;
}

/** Blank SQL comments and string bodies. Offsets and newlines survive. */
export function blankNonCodeSql(source: string): string {
  const out = source.split('');
  const n = source.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  let i = 0;
  while (i < n) {
    const c = source[i]!;
    const d = i + 1 < n ? source[i + 1] : '';
    if (c === '-' && d === '-') {
      let j = i;
      while (j < n && source[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (source[j] === "'" && source[j + 1] === "'") { j += 2; continue; }
        if (source[j] === "'") break;
        j += 1;
      }
      blank(i + 1, j);
      i = Math.min(j + 1, n);
      continue;
    }
    i += 1;
  }
  return out.join('');
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

/** Index just past the bracket matching the one at `openIndex`, or the end of input. */
function matchBracket(text: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === open) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

// ── Declarations ─────────────────────────────────────────────────────────────

export type DeclarationKind = 'interface' | 'type' | 'zod' | 'table';

export interface DeclaredField {
  name: string;
  line: number;
  /** The annotation, as written. Used to follow references onward. */
  typeText: string;
}

export interface Declaration {
  kind: DeclarationKind;
  name: string;
  file: string;
  line: number;
  fields: DeclaredField[];
  /** Capitalised identifiers named anywhere in the body — the closure walks these. */
  references: string[];
  /** Body text with comments and strings blanked; K2 reads this. */
  body: string;
  bodyOffset: number;
}

const INTERFACE_RE = /^[ \t]*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)[^\n{]*\{/gm;
const TYPE_LITERAL_RE = /^[ \t]*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)[^\n=]*=[^\n{]*\{/gm;
const ZOD_RE = /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)[^\n=]*=\s*[\w$.]*z\s*\.\s*(?:object|strictObject|looseObject|record)\s*\(\s*\{/gm;
/**
 * A schema built out of object literals rather than being one: a discriminated
 * union's members are where a credential field would actually be added, and
 * they have no names of their own to match on.
 */
const ZOD_COMPOSITE_RE = /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)[^\n=]*=\s*[\w$.]*z\s*\.\s*(?:discriminatedUnion|union|intersection|tuple|array|lazy)\s*\(/gm;
const TABLE_RE = /create\s+table\s+(?:if\s+not\s+exists\s+)?[`"[]?([\w.$]+)[`"\]]?\s*\(/gi;

/**
 * A property signature or object key. Anchored to a line start, an opening
 * brace or a comma — a one-line `z.object({ apiKey: z.string() })` is as real a
 * declaration as a formatted one, and matching only at line starts would miss it.
 */
const FIELD_RE = /(?:^|[{,])[ \t]*(?:readonly\s+)?(?:\[\s*)?(?:(['"])([^'"\n]+)\1|([A-Za-z_$][\w$]*))\s*\]?\s*\??\s*:/gm;

/** SQL words that open a table constraint rather than a column. */
const SQL_CONSTRAINT_KEYWORDS = new Set([
  'constraint', 'primary', 'foreign', 'unique', 'check', 'key', 'index', 'exclude', 'like', 'partition',
]);

/**
 * Every interface, object type literal, Zod object and SQL table in one file.
 *
 * Braces are counted on the blanked text; field names are read from the
 * original, because a quoted key like `'api_key':` has its body blanked. A name
 * counts only when the original characters survive blanking (real code) or its
 * quotes do (a real string key) — which is what keeps a commented-out
 * `// apiKey: string` from being read as a field.
 */
export function findDeclarations(source: string, file: string): Declaration[] {
  const isSql = SQL_EXTENSIONS.has(path.extname(file));
  const blanked = isSql ? blankNonCodeSql(source) : blankNonCode(source);
  const declarations: Declaration[] = [];

  const pushBlock = (
    kind: DeclarationKind,
    name: string,
    nameIndex: number,
    openIndex: number,
    delimiter: 'brace' | 'paren' = kind === 'table' ? 'paren' : 'brace',
  ): void => {
    const open = delimiter === 'paren' ? '(' : '{';
    const close = delimiter === 'paren' ? ')' : '}';
    const end = matchBracket(blanked, openIndex, open, close);
    const bodyStart = openIndex + 1;
    const bodyEnd = Math.max(bodyStart, end - 1);
    declarations.push({
      kind,
      name,
      file,
      line: lineOf(source, nameIndex),
      fields:
        kind === 'table'
          ? sqlColumns(source, blanked, bodyStart, bodyEnd)
          : tsFields(source, blanked, bodyStart, bodyEnd),
      references: capitalisedIdentifiers(blanked.slice(bodyStart, bodyEnd)),
      body: blanked.slice(bodyStart, bodyEnd),
      bodyOffset: bodyStart,
    });
  };

  if (!isSql) {
    for (const [pattern, kind] of [
      [INTERFACE_RE, 'interface'],
      [TYPE_LITERAL_RE, 'type'],
      [ZOD_RE, 'zod'],
      [ZOD_COMPOSITE_RE, 'zod'],
    ] as const) {
      pattern.lastIndex = 0;
      for (const match of blanked.matchAll(pattern)) {
        const name = match[1];
        if (name === undefined || match.index === undefined) continue;
        const composite = pattern === ZOD_COMPOSITE_RE;
        pushBlock(kind, name, match.index, match.index + match[0].length - 1, composite ? 'paren' : 'brace');
      }
    }
  }

  // Tables are matched on the raw text so that a migration written as a
  // template literal inside TypeScript is caught alongside a real .sql file.
  TABLE_RE.lastIndex = 0;
  for (const match of source.matchAll(TABLE_RE)) {
    const name = match[1];
    if (name === undefined || match.index === undefined) continue;
    pushBlock('table', name, match.index, match.index + match[0].length - 1);
  }

  return declarations;
}

function tsFields(source: string, blanked: string, start: number, end: number): DeclaredField[] {
  const slice = source.slice(start, end);
  const fields: DeclaredField[] = [];
  FIELD_RE.lastIndex = 0;
  for (const match of slice.matchAll(FIELD_RE)) {
    if (match.index === undefined) continue;
    const quote = match[1];
    const name = match[2] ?? match[3];
    if (name === undefined) continue;
    const absolute = start + match.index;
    if (quote !== undefined) {
      // A string key: the delimiters survive blanking, a comment's do not.
      const quoteAt = absolute + match[0].indexOf(quote);
      if (blanked[quoteAt] !== quote) continue;
    } else {
      const nameAt = absolute + match[0].lastIndexOf(name);
      if (blanked[nameAt] !== name[0]) continue;
    }
    const annotationStart = absolute + match[0].length;
    const lineEnd = blanked.indexOf('\n', annotationStart);
    fields.push({
      name,
      line: lineOf(source, absolute),
      typeText: blanked.slice(annotationStart, lineEnd === -1 ? end : Math.min(lineEnd, end)),
    });
  }
  return fields;
}

function sqlColumns(source: string, blanked: string, start: number, end: number): DeclaredField[] {
  const fields: DeclaredField[] = [];
  let depth = 0;
  let partStart = start;
  const parts: Array<{ from: number; to: number }> = [];
  for (let i = start; i < end; i += 1) {
    const c = blanked[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push({ from: partStart, to: i });
      partStart = i + 1;
    }
  }
  parts.push({ from: partStart, to: end });

  for (const part of parts) {
    const text = source.slice(part.from, part.to);
    const match = /^\s*[`"[]?([A-Za-z_][\w$]*)[`"\]]?\s+(\S[^\n]*)?/.exec(text);
    if (!match || match[1] === undefined) continue;
    if (SQL_CONSTRAINT_KEYWORDS.has(match[1].toLowerCase())) continue;
    fields.push({
      name: match[1],
      line: lineOf(source, part.from + text.indexOf(match[1])),
      typeText: match[2] ?? '',
    });
  }
  return fields;
}

function capitalisedIdentifiers(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9_$]*)\b/g)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return [...found];
}

// ── Persistence closure ──────────────────────────────────────────────────────

/** Files whose whole job is describing what gets written down. */
const PERSISTENCE_PATH_RE = /(^|\/)(stores?|storage|schemas?|migrations?|persistence|persist|repository|repositories|entities|entity|db|database)(\.[cm]?tsx?|\/|$)/i;

export function isPersistenceModule(file: string): boolean {
  return SQL_EXTENSIONS.has(path.extname(file)) || PERSISTENCE_PATH_RE.test(file);
}

/** Interfaces that are a store seam: a `StoragePort`, or anything `…Store`. */
export function isStoreSeam(name: string): boolean {
  return name === 'StoragePort' || (name.endsWith('Store') && name.length > 'Store'.length);
}

export interface PersistedShape {
  declaration: Declaration;
  /** Human-readable evidence: why this shape is believed to reach storage. */
  reason: string;
}

/**
 * The set of declarations that reach storage, and why. Seeded from persistence
 * modules, SQL tables and store-seam signatures, then closed over field
 * references so that a credential hidden one type deep is still in scope.
 */
export interface PersistenceScope {
  /** Interfaces treated as store seams. Defaults to every `StoragePort`/`…Store`. */
  seams?: (name: string) => boolean;
  /** Files whose declarations are persisted by location. Defaults to every persistence module. */
  modules?: (file: string) => boolean;
}

/**
 * The set of declarations that reach storage, and why. Seeded from persistence
 * modules, SQL tables and store-seam signatures, then closed over field
 * references so that a credential hidden one type deep is still in scope.
 */
export function persistedShapes(
  declarations: readonly Declaration[],
  scope: PersistenceScope = {},
): Map<string, PersistedShape> {
  const isSeam = scope.seams ?? isStoreSeam;
  const isModule = scope.modules ?? isPersistenceModule;

  const byName = new Map<string, Declaration[]>();
  for (const declaration of declarations) {
    const list = byName.get(declaration.name) ?? [];
    list.push(declaration);
    byName.set(declaration.name, list);
  }

  const persisted = new Map<string, PersistedShape>();
  const key = (declaration: Declaration): string => `${declaration.file}#${declaration.name}`;
  const queue: Declaration[] = [];

  const add = (declaration: Declaration, reason: string): void => {
    const id = key(declaration);
    if (persisted.has(id)) return;
    persisted.set(id, { declaration, reason });
    queue.push(declaration);
  };

  for (const declaration of declarations) {
    const seam = declaration.kind === 'interface' && isSeam(declaration.name);
    if (isModule(declaration.file)) {
      add(declaration, declaration.kind === 'table' ? 'a SQL table' : `declared in ${declaration.file}, a persistence module`);
    } else if (seam) {
      add(declaration, `the ${declaration.name} seam itself`);
    }
    // Seam members are methods, and a method signature is not a field — so the
    // types a seam *names* are seeded here rather than found by the field walk.
    // Most seams also live in a persistence module, which is why this is not an
    // `else`: skipping it there would lose every type the ports file mentions.
    if (!seam) continue;
    for (const reference of declaration.references) {
      for (const target of byName.get(reference) ?? []) {
        add(target, `named in the ${declaration.name} seam`);
      }
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const field of current.fields) {
      for (const reference of capitalisedIdentifiers(field.typeText)) {
        for (const target of byName.get(reference) ?? []) {
          add(target, `reached through ${current.name}.${field.name}`);
        }
      }
    }
  }

  return persisted;
}

// ── Sinks ────────────────────────────────────────────────────────────────────

const LOG_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace', 'fatal', 'verbose']);
const TELEMETRY_METHODS = new Set([
  'setAttributes', 'addEvent', 'recordException', 'startSpan', 'counter', 'histogram',
  'captureException', 'captureMessage', 'setContext', 'setExtra', 'setTag', 'addBreadcrumb',
]);
const DISK_METHODS = new Set([
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'outputFile',
]);
/**
 * Response bodies. Not on the assignment's list, but T1's second row is "browser
 * sends key to our API … a test asserting no request body ever contains a
 * key-shaped string" — the daemon's HTTP egress is where that would happen, and
 * it costs one line to watch it.
 */
const RESPONSE_METHODS = new Set(['writeJson', 'json', 'send']);
const RESPONSE_RECEIVER_RE = /^(res|response|reply)$/i;
/** Unambiguous database verbs — `exec` and `run` are excluded, they collide with regexes and test runners. */
const DATABASE_METHODS = new Set(['query', 'execute', 'insert', 'upsert', 'prepare']);
const STORE_RECEIVER_RE = /(store|db|database|sql|sqlite|prisma|knex|repo|repository|table)s?$/i;
const STORE_WRITE_VERB_RE = /^(put|set|save|insert|upsert|append|write|add|create|update|patch|enqueue|record|push|store)/;

export type SinkKind = 'disk' | 'database' | 'response' | 'log' | 'telemetry';

export interface SinkCall {
  kind: SinkKind;
  callee: string;
  line: number;
  /** Argument list with comments and string bodies blanked; interpolations survive. */
  argumentText: string;
}

/**
 * Calls that move a value out of the process. Matched on the blanked source, so
 * an interface's method *declaration* — which looks exactly like a call — and a
 * log message that merely says the word "secret" are both out of scope. The
 * former is K1 and K2's business; the latter is prose.
 */
export function findSinkCalls(source: string, declarations: readonly Declaration[] = []): SinkCall[] {
  const blanked = blankNonCode(source);
  const declared = declarations.map((declaration) => ({
    from: declaration.bodyOffset,
    to: declaration.bodyOffset + declaration.body.length,
  }));
  const insideDeclaration = (index: number): boolean =>
    declared.some((range) => index >= range.from && index < range.to);

  const calls: SinkCall[] = [];
  const pattern = /(?:([\w$#.\]]+)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of blanked.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const receiver = match[1] ?? '';
    const method = match[2];
    if (method === undefined) continue;
    const openIndex = match.index + match[0].length - 1;
    if (insideDeclaration(openIndex)) continue;

    const kind = sinkKind(receiver, method);
    if (kind === null) continue;

    const end = matchBracket(blanked, openIndex, '(', ')');
    calls.push({
      kind,
      callee: receiver === '' ? method : `${receiver}.${method}`,
      line: lineOf(source, match.index),
      argumentText: blanked.slice(openIndex + 1, Math.max(openIndex + 1, end - 1)),
    });
  }
  return calls;
}

function sinkKind(receiver: string, method: string): SinkKind | null {
  const receiverTail = receiver.split('.').pop() ?? '';
  if (receiverTail === 'console') return 'log';
  if (TELEMETRY_METHODS.has(method)) return 'telemetry';
  if (LOG_METHODS.has(method)) return 'log';
  if (DISK_METHODS.has(method)) return 'disk';
  if (RESPONSE_METHODS.has(method)) return 'response';
  if (RESPONSE_RECEIVER_RE.test(receiverTail) && ['write', 'end', 'json', 'send'].includes(method)) return 'response';
  if (DATABASE_METHODS.has(method)) return 'database';
  if (STORE_RECEIVER_RE.test(receiverTail.replace(/^#/, '')) && STORE_WRITE_VERB_RE.test(method)) return 'database';
  return null;
}

/** Credential-shaped identifiers appearing in a call's arguments. */
export function credentialArguments(argumentText: string): string[] {
  const found = new Set<string>();
  for (const match of argumentText.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const token = match[0];
    if (isCredentialShaped(token)) found.add(token);
  }
  return [...found];
}

// ── The gate ─────────────────────────────────────────────────────────────────

export interface AllowedName {
  name: string;
  reason: string;
  where: string;
}

export interface KeyCustodyReport {
  violations: KeyStorageViolation[];
  roots: Array<{ root: string; present: boolean; tsFiles: number; sqlFiles: number }>;
  declarationCount: Record<DeclarationKind, number>;
  persisted: PersistedShape[];
  allowed: AllowedName[];
  sinkCount: Record<SinkKind, number>;
  exemptions: string[];
}

/**
 * Ports that are *supposed* to carry a credential. The secrets port is the
 * keychain seam — the one interface in the repository whose entire job is
 * handing a key to the adapter that owns the OS keychain. Exempting it is the
 * point of ADR-006, not a hole in it: the rule is that credentials travel
 * through this port and no other, which is a rule only if the port exists.
 */
const CREDENTIAL_PORTS = new Set(['SecretsPort', 'SecretRef', 'SecretsBackendInfo']);

function walk(dir: string, repoRoot: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (dirent.isDirectory()) {
      if (SKIP_DIRS.has(dirent.name)) continue;
      walk(path.join(dir, dirent.name), repoRoot, out);
    } else if (dirent.isFile()) {
      out.push(path.relative(repoRoot, path.join(dir, dirent.name)).split(path.sep).join('/'));
    }
  }
  return out;
}

function readIfText(abs: string): string | null {
  let buffer: Buffer;
  try {
    buffer = readFileSync(abs);
  } catch {
    return null;
  }
  if (buffer.subarray(0, 8000).includes(0)) return null;
  return buffer.toString('utf8');
}

export function scanKeyCustody(repoRoot: string): KeyCustodyReport {
  const violations: KeyStorageViolation[] = [];
  const allowed: AllowedName[] = [];
  const declarations: Declaration[] = [];
  const declarationCount: Record<DeclarationKind, number> = { interface: 0, type: 0, zod: 0, table: 0 };
  const sinkCount: Record<SinkKind, number> = { disk: 0, database: 0, response: 0, log: 0, telemetry: 0 };
  const roots: KeyCustodyReport['roots'] = [];
  const sources = new Map<string, string>();

  for (const root of SCAN_ROOTS) {
    const absolute = path.join(repoRoot, root);
    const present = existsSync(absolute);
    let tsFiles = 0;
    let sqlFiles = 0;
    for (const rel of walk(absolute, repoRoot)) {
      const extension = path.extname(rel);
      const isTs = TS_EXTENSIONS.has(extension);
      const isSql = SQL_EXTENSIONS.has(extension);
      if (!isTs && !isSql) continue;
      const source = readIfText(path.join(repoRoot, rel));
      if (source === null) continue;
      sources.set(rel, source);
      if (isTs) tsFiles += 1;
      else sqlFiles += 1;
      for (const declaration of findDeclarations(source, rel)) {
        declarations.push(declaration);
        declarationCount[declaration.kind] += 1;
      }
    }
    roots.push({ root, present, tsFiles, sqlFiles });
  }

  const persisted = persistedShapes(declarations);
  // K4 narrows the same machinery to the daemon: its own store seam, plus
  // anything its persistence modules declare. Overlaps K1 on purpose — this is
  // the sentence ADR-006 actually writes down, so it gets its own failure.
  const daemonSeam = persistedShapes(declarations, {
    seams: (name) => name === 'DaemonStore',
    modules: (file) => file.startsWith('packages/daemon/') && isPersistenceModule(file),
  });

  const noteAllowed = (name: string, where: string): void => {
    const reason = credentialAllowance(name);
    if (reason === null) return;
    if (allowed.some((entry) => entry.name === name)) return;
    allowed.push({ name, reason, where });
  };

  // ── K1 ─────────────────────────────────────────────────────────────────────
  for (const { declaration, reason } of persisted.values()) {
    if (CREDENTIAL_PORTS.has(declaration.name)) continue;
    for (const field of declaration.fields) {
      if (credentialMarker(field.name) === null) continue;
      if (!isCredentialShaped(field.name)) {
        noteAllowed(field.name, `${declaration.name} (${declaration.file})`);
        continue;
      }
      violations.push({
        rule: 'K1',
        file: `${declaration.file}:${field.line}`,
        detail:
          `${declaration.name}.${field.name} is a credential-shaped field on a shape that reaches storage ` +
          `(${reason}). THREAT-MODEL T1 claims there is no column for a user key; this would be one. ` +
          `Store an identifier the SecretsPort can resolve — "${field.name}Id" — or move the value behind ` +
          `that port (ADR-006).`,
      });
    }
  }

  // ── K2 ─────────────────────────────────────────────────────────────────────
  for (const declaration of declarations) {
    if (declaration.kind !== 'interface' || !isStoreSeam(declaration.name)) continue;
    if (CREDENTIAL_PORTS.has(declaration.name)) continue;
    const named = new Set<string>();
    for (const match of declaration.body.matchAll(/([A-Za-z_$][\w$]*)\s*\??\s*:/g)) {
      if (match[1] !== undefined) named.add(match[1]);
    }
    for (const reference of capitalisedIdentifiers(declaration.body)) named.add(reference);
    for (const name of named) {
      if (credentialMarker(name) === null) continue;
      if (!isCredentialShaped(name)) {
        noteAllowed(name, `${declaration.name} (${declaration.file})`);
        continue;
      }
      violations.push({
        rule: 'K2',
        file: `${declaration.file}:${declaration.line}`,
        detail:
          `${declaration.name} names "${name}" in its signatures. A storage seam that can carry a credential ` +
          `will be handed one, whatever an adapter intends — credentials cross the SecretsPort and nothing else (ADR-006).`,
      });
    }
  }

  // ── K3 ─────────────────────────────────────────────────────────────────────
  for (const [rel, source] of sources) {
    if (!TS_EXTENSIONS.has(path.extname(rel))) continue;
    if (!rel.startsWith('packages/')) continue;
    const fileDeclarations = declarations.filter((declaration) => declaration.file === rel);
    for (const call of findSinkCalls(source, fileDeclarations)) {
      sinkCount[call.kind] += 1;
      for (const name of credentialArguments(call.argumentText)) {
        violations.push({
          rule: 'K3',
          file: `${rel}:${call.line}`,
          detail:
            `${call.callee}(…) is a ${call.kind} sink and "${name}" is credential-shaped. ` +
            `A key that has reached a ${call.kind} sink has left the user's custody (THREAT-MODEL T1). ` +
            `Pass an identifier, or run it through the redactor first.`,
        });
      }
    }
  }

  // ── K4 ─────────────────────────────────────────────────────────────────────
  for (const { declaration, reason } of daemonSeam.values()) {
    if (CREDENTIAL_PORTS.has(declaration.name)) continue;
    for (const field of declaration.fields) {
      if (!isCredentialShaped(field.name)) continue;
      violations.push({
        rule: 'K4',
        file: `${declaration.file}:${field.line}`,
        detail:
          `${declaration.name}.${field.name} is reachable from the daemon's store seam (${reason}). ` +
          `ADR-006 puts the session key in the in-process keyring and the provider key in the OS keychain; ` +
          `neither survives a restart, and a store shape that holds one would make them both persistent.`,
      });
    }
  }

  return {
    violations: dedupe(violations),
    roots,
    declarationCount,
    persisted: [...persisted.values()].sort((a, b) => a.declaration.name.localeCompare(b.declaration.name)),
    allowed: allowed.sort((a, b) => a.name.localeCompare(b.name)),
    sinkCount,
    exemptions: [...CREDENTIAL_PORTS],
  };
}

function dedupe(violations: readonly KeyStorageViolation[]): KeyStorageViolation[] {
  const seen = new Set<string>();
  const out: KeyStorageViolation[] = [];
  for (const violation of violations) {
    const id = `${violation.rule}|${violation.file}|${violation.detail}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(violation);
  }
  return out;
}

export function verifyNoKeyStorage(repoRoot: string): KeyStorageViolation[] {
  return scanKeyCustody(repoRoot).violations;
}

const RULE_TEXT: Record<KeyStorageViolation['rule'], string> = {
  K1: 'no persisted shape declares a credential-shaped field',
  K2: 'no StoragePort method accepts or returns a credential',
  K3: 'no credential reaches disk, a database, a response, a log or telemetry',
  K4: 'no shape the daemon persists holds a provider key',
};

function formatSummary(report: KeyCustodyReport): string {
  const lines: string[] = [];
  const scanned = report.roots
    .map((root) =>
      root.present
        ? `${root.root}/ (${root.tsFiles} TypeScript, ${root.sqlFiles} SQL)`
        : `${root.root}/ (absent)`,
    )
    .join('; ');
  lines.push(`  scanned      ${scanned}`);
  lines.push(
    `  shapes       ${report.persisted.length} of ${
      Object.values(report.declarationCount).reduce((a, b) => a + b, 0)
    } declarations reach storage ` +
      `(${report.declarationCount.interface} interface, ${report.declarationCount.type} type, ` +
      `${report.declarationCount.zod} zod, ${report.declarationCount.table} table)`,
  );
  lines.push(`               ${wrap(report.persisted.map((shape) => shape.declaration.name).sort(), 15)}`);
  lines.push(
    `  sinks        ${report.sinkCount.disk} disk, ${report.sinkCount.database} database, ` +
      `${report.sinkCount.response} response, ${report.sinkCount.log} log, ` +
      // Named from SCAN_ROOTS rather than written out, because the line said
      // "under packages/" while the gate had been reading apps/ as well — and a
      // summary that under-reports its own scope is how a reader concludes a
      // tree is unchecked when it is, or the reverse after the next edit.
      `${report.sinkCount.telemetry} telemetry call(s) inspected under ${SCAN_ROOTS.map((r) => `${r}/`).join(' and ')}`,
  );
  if (report.allowed.length === 0) {
    lines.push('  allowed      no credential-adjacent field names were waved through');
  } else {
    lines.push('  allowed      credential-adjacent names deliberately let through:');
    for (const entry of report.allowed) {
      lines.push(`                 ${entry.name} — ${entry.reason}  [${entry.where}]`);
    }
  }
  lines.push(`  exempt       ${report.exemptions.join(', ')} — the keychain seam credentials are supposed to cross (ADR-006)`);
  lines.push('  not covered  plugin/ (Luau), scripts/, runtime behaviour, adapters not yet written,');
  lines.push('               and any credential carried in a blandly named string.');
  return lines.join('\n');
}

function wrap(names: readonly string[], perLine: number): string {
  if (names.length === 0) return '(none)';
  const chunks: string[] = [];
  for (let i = 0; i < names.length; i += perLine) {
    chunks.push(names.slice(i, i + perLine).join(' '));
  }
  return chunks.join('\n               ');
}

function main(): void {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const report = scanKeyCustody(repoRoot);

  if (report.violations.length === 0) {
    console.log('verify-no-key-storage: ok — K1 K2 K3 K4 all clean.');
    console.log(formatSummary(report));
    return;
  }

  console.error(
    `verify-no-key-storage: ${report.violations.length} violation(s) — see docs/architecture/adr-006-key-custody-daemon-as-egress.md\n`,
  );
  for (const violation of report.violations) {
    console.error(`  [${violation.rule}: ${RULE_TEXT[violation.rule]}] ${violation.file}`);
    console.error(`      ${violation.detail}`);
  }
  console.error('');
  console.error(formatSummary(report));
  console.error('');
  process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
