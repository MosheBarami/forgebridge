/**
 * A Luau lexer.
 *
 * This is a real tokenizer, not a regex sweep over the source text. The
 * difference matters for a security check: a rule written as `/loadstring/`
 * fires on a comment that mentions the word and misses `loadstring` reached
 * through a string interpolation, and both of those are the wrong answer. Every
 * rule in this package reads tokens, so it sees code as code and text as text.
 *
 * What it does not do is parse. There is no grammar and no AST here — see
 * `structure.ts` for the block recogniser built on top, and the README for the
 * list of constructs the pair of them understand and the ones they do not.
 */

export type TokenKind = 'name' | 'keyword' | 'number' | 'string' | 'op' | 'eof';

export interface Token {
  kind: TokenKind;
  /** Source text of the token. For a string literal, the raw text with delimiters. */
  text: string;
  /**
   * Decoded contents of a string literal — the text the Luau VM would build,
   * with every escape `decodeShortString` resolves already applied. Present
   * only on `string` tokens, and absent when the literal contains an escape
   * that cannot be resolved exactly, so a rule that needs an exact value (the
   * HTTP egress rule reading a URL) must tolerate `undefined` and treat it as
   * "unreadable" rather than as "empty".
   */
  value?: string;
  /** 1-based, to match `Finding.line`. */
  line: number;
  /** 1-based, to match `Finding.column`. */
  column: number;
}

export interface LexError {
  message: string;
  line: number;
  column: number;
}

export interface TokenizeResult {
  tokens: Token[];
  /** Set when the source could not be tokenized. Callers must treat this as a `fail`. */
  error?: LexError;
}

/** Lua 5.1 reserved words, which Luau inherits unchanged. `continue`, `type` and `export` are contextual and lex as names. */
const KEYWORDS: ReadonlySet<string> = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if',
  'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while',
]);

/**
 * Longest-first, because the scanner takes the first match: `//` must be tried
 * before `/`, `..=` before `..` before `.`, or a compound assignment lexes as
 * two tokens and the structure pass sees a statement that is not there.
 */
const OPERATORS: readonly string[] = [
  '...', '//=', '..=',
  '==', '~=', '<=', '>=', '::', '..', '->', '+=', '-=', '*=', '/=', '%=', '^=', '//',
  '+', '-', '*', '/', '%', '^', '#', '<', '>', '=', '(', ')', '{', '}', '[', ']',
  ';', ':', ',', '.', '?', '|', '&', '@',
];

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isHexDigit(ch: string): boolean {
  return isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

function isNameStart(ch: string): boolean {
  return ch === '_' || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function isNamePart(ch: string): boolean {
  return isNameStart(ch) || isDigit(ch);
}

/** Whitespace `\z` skips, which includes line breaks — see `decodeShortString`. */
function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

/** The UTF-8 bytes of a code point, one character per byte, matching how Lua stores `\u{…}`. */
function utf8Bytes(code: number): string {
  if (code < 0x80) return String.fromCharCode(code);
  if (code < 0x800) {
    return String.fromCharCode(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
  }
  if (code < 0x10000) {
    return String.fromCharCode(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return String.fromCharCode(
    0xf0 | (code >> 18),
    0x80 | ((code >> 12) & 0x3f),
    0x80 | ((code >> 6) & 0x3f),
    0x80 | (code & 0x3f),
  );
}

/** Single-character escapes, mapped to the byte Luau produces for each. */
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  a: '\u0007', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\u000b',
  // Self-escapes. The last three are the ones an interpolated string needs.
  '\\': '\\', '"': '"', "'": "'", '`': '`', '{': '{', '}': '}',
};

/**
 * Resolves a short string's escapes to the text the Luau VM would build.
 *
 * This decoder is a security component, not a convenience. `Token.value` is
 * what the egress rule compares against the allowed-host list, so a decoder
 * that guesses compares the wrong host. `H:GetAsync("\104ttps://evil.com")`
 * really reaches `https://evil.com`; the version of this function that dropped
 * the backslash and kept the escape's first character read it as
 * `104ttps://evil.com`, which is not an absolute URL, so the rule reported that
 * it could not read the destination instead of that the destination was evil.com.
 *
 * Returns undefined for an escape it cannot resolve exactly — a `\x` without two
 * hex digits, a `\ddd` past 255, a `\u{…}` past the Unicode range, an escape
 * letter Luau does not define. Every caller that needs an exact value already
 * treats a missing one as "unreadable", which is the fail-closed answer.
 * Inventing text here would be the fail-open one, and such a source does not
 * compile in Studio anyway.
 */
function decodeShortString(raw: string): string | undefined {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (ch !== '\\') {
      out += ch;
      continue;
    }

    const next = raw[i + 1];
    if (next === undefined) return undefined;

    const simple = SIMPLE_ESCAPES[next];
    if (simple !== undefined) {
      out += simple;
      i += 1;
      continue;
    }

    // A backslash before a real line break is a line continuation, and the
    // value carries the newline. `\r\n` is one break, not two.
    if (next === '\n' || next === '\r') {
      out += '\n';
      i += 1;
      if (next === '\r' && raw[i + 1] === '\n') i += 1;
      continue;
    }

    // `\z` eats the whitespace that follows, line breaks included. It is how a
    // long URL is wrapped across source lines without entering the string.
    if (next === 'z') {
      i += 1;
      while (isSpace(raw[i + 1])) i += 1;
      continue;
    }

    // `\xNN` — exactly two hex digits, no more and no fewer.
    if (next === 'x') {
      const digits = raw.slice(i + 2, i + 4);
      if (digits.length !== 2 || !/^[0-9a-fA-F]{2}$/.test(digits)) return undefined;
      out += String.fromCharCode(parseInt(digits, 16));
      i += 3;
      continue;
    }

    // `\u{XXX}` — hex, braced, anywhere in the Unicode range.
    if (next === 'u') {
      if (raw[i + 2] !== '{') return undefined;
      const close = raw.indexOf('}', i + 3);
      if (close === -1) return undefined;
      const digits = raw.slice(i + 3, close);
      if (digits.length === 0 || !/^[0-9a-fA-F]+$/.test(digits)) return undefined;
      const code = parseInt(digits, 16);
      if (code > 0x10ffff) return undefined;
      out += utf8Bytes(code);
      i = close;
      continue;
    }

    // `\ddd` — one to three decimal digits, naming a byte.
    if (next >= '0' && next <= '9') {
      let digits = '';
      while (digits.length < 3) {
        const digit = raw[i + 1 + digits.length];
        if (digit === undefined || !isDigit(digit)) break;
        digits += digit;
      }
      const code = Number(digits);
      if (code > 255) return undefined;
      out += String.fromCharCode(code);
      i += digits.length;
      continue;
    }

    // Anything else is not an escape Luau defines.
    return undefined;
  }
  return out;
}

export function tokenize(source: string): TokenizeResult {
  const tokens: Token[] = [];
  const length = source.length;

  let index = 0;
  let line = 1;
  let lineStart = 0;

  /**
   * Brace depth inside each open string interpolation, innermost last. An entry
   * exists while the scanner is inside a `{...}` of a backtick string; its value
   * counts the table constructors nested in that expression, so the `}` of
   * `` `{ {1, 2} }` `` closes the table and not the interpolation.
   */
  const interpolations: number[] = [];

  const column = (position: number): number => position - lineStart + 1;

  const fail = (message: string, position: number): TokenizeResult => ({
    tokens,
    error: { message, line, column: column(position) },
  });

  /** Advance to `target`, counting the newlines crossed so line and column stay true. */
  const seek = (target: number): void => {
    for (let p = index; p < target; p++) {
      if (source[p] === '\n') {
        line += 1;
        lineStart = p + 1;
      }
    }
    index = target;
  };

  const push = (kind: TokenKind, text: string, start: number, value?: string): void => {
    const token: Token = { kind, text, line, column: column(start) };
    if (value !== undefined) token.value = value;
    tokens.push(token);
  };

  /**
   * Matches a long-bracket opener `[`, `[=[`, `[==[`, … at `position`.
   * Returns the level (count of `=`) or null when this is not one.
   */
  const longBracketLevel = (position: number): number | null => {
    if (source[position] !== '[') return null;
    let p = position + 1;
    while (source[p] === '=') p += 1;
    return source[p] === '[' ? p - position - 1 : null;
  };

  /** Index just past the matching long-bracket closer, or -1 when unterminated. */
  const longBracketEnd = (contentStart: number, level: number): number => {
    const closer = `]${'='.repeat(level)}]`;
    const at = source.indexOf(closer, contentStart);
    return at === -1 ? -1 : at + closer.length;
  };

  while (index < length) {
    const ch = source[index] as string;

    // ── whitespace ────────────────────────────────────────────────────────
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\v') {
      seek(index + 1);
      continue;
    }

    // ── comments ──────────────────────────────────────────────────────────
    if (ch === '-' && source[index + 1] === '-') {
      const level = longBracketLevel(index + 2);
      if (level !== null) {
        const end = longBracketEnd(index + 2 + level + 2, level);
        if (end === -1) return fail('unterminated long comment', index);
        seek(end);
        continue;
      }
      let end = source.indexOf('\n', index);
      if (end === -1) end = length;
      seek(end);
      continue;
    }

    // ── long strings ──────────────────────────────────────────────────────
    if (ch === '[') {
      const level = longBracketLevel(index);
      if (level !== null) {
        const start = index;
        const contentStart = index + level + 2;
        const end = longBracketEnd(contentStart, level);
        if (end === -1) return fail('unterminated long string', index);
        const contentEnd = end - (level + 2);
        // Lua drops a newline immediately after the opener; a rule reading the
        // value would otherwise see a leading blank line that is not there.
        let content = source.slice(contentStart, contentEnd);
        if (content.startsWith('\n')) content = content.slice(1);
        const startColumn = column(start);
        const startLine = line;
        seek(end);
        tokens.push({
          kind: 'string',
          text: source.slice(start, end),
          value: content,
          line: startLine,
          column: startColumn,
        });
        continue;
      }
    }

    // ── short strings ─────────────────────────────────────────────────────
    if (ch === '"' || ch === "'") {
      const start = index;
      let p = index + 1;
      for (;;) {
        if (p >= length) return fail('unterminated string', start);
        const c = source[p];
        if (c === '\\') {
          // `\z` skips the whitespace after it, and that whitespace may include
          // line breaks: a wrapped URL is written `"https://host/\z\n  path"`.
          // Scanning it as a one-character escape left the scanner on the
          // newline and rejected a string Luau accepts.
          if (source[p + 1] === 'z') {
            p += 2;
            while (p < length && isSpace(source[p])) p += 1;
            continue;
          }
          // A backslash-newline is a line continuation; any other escape is one
          // character wide as far as finding the closing quote is concerned.
          p += 2;
          continue;
        }
        if (c === '\n') return fail('unterminated string (newline inside a quoted string)', start);
        if (c === ch) break;
        p += 1;
      }
      const raw = source.slice(start + 1, p);
      const startColumn = column(start);
      const startLine = line;
      seek(p + 1);
      tokens.push({
        kind: 'string',
        text: source.slice(start, p + 1),
        value: decodeShortString(raw),
        line: startLine,
        column: startColumn,
      });
      continue;
    }

    // ── interpolated strings ──────────────────────────────────────────────
    //
    // A backtick string is not opaque. `{loadstring(payload)}` inside one is a
    // call, and a scanner that swallowed the whole literal as text would let it
    // through — so the literal chunks lex as strings and the expression inside
    // each `{...}` lexes as ordinary tokens.
    if (ch === '`') {
      const outcome = lexInterpolationChunk(index + 1);
      if (typeof outcome === 'string') return fail(outcome, index);
      continue;
    }

    // ── numbers ───────────────────────────────────────────────────────────
    if (isDigit(ch) || (ch === '.' && isDigit(source[index + 1] ?? ''))) {
      const start = index;
      let p = index;
      if (ch === '0' && (source[p + 1] === 'x' || source[p + 1] === 'X')) {
        p += 2;
        const digitsStart = p;
        while (p < length && (isHexDigit(source[p] as string) || source[p] === '_')) p += 1;
        if (p === digitsStart) return fail('hexadecimal literal with no digits', start);
      } else if (ch === '0' && (source[p + 1] === 'b' || source[p + 1] === 'B')) {
        p += 2;
        const digitsStart = p;
        while (p < length && (source[p] === '0' || source[p] === '1' || source[p] === '_')) p += 1;
        if (p === digitsStart) return fail('binary literal with no digits', start);
      } else {
        while (p < length && (isDigit(source[p] as string) || source[p] === '_')) p += 1;
        if (source[p] === '.') {
          p += 1;
          while (p < length && (isDigit(source[p] as string) || source[p] === '_')) p += 1;
        }
        if (source[p] === 'e' || source[p] === 'E') {
          p += 1;
          if (source[p] === '+' || source[p] === '-') p += 1;
          const digitsStart = p;
          while (p < length && isDigit(source[p] as string)) p += 1;
          if (p === digitsStart) return fail('exponent with no digits', start);
        }
      }
      const text = source.slice(start, p);
      const startColumn = column(start);
      seek(p);
      tokens.push({ kind: 'number', text, line, column: startColumn });
      continue;
    }

    // ── names and keywords ────────────────────────────────────────────────
    if (isNameStart(ch)) {
      const start = index;
      let p = index;
      while (p < length && isNamePart(source[p] as string)) p += 1;
      const text = source.slice(start, p);
      const startColumn = column(start);
      seek(p);
      tokens.push({ kind: KEYWORDS.has(text) ? 'keyword' : 'name', text, line, column: startColumn });
      continue;
    }

    // ── operators and punctuation ─────────────────────────────────────────
    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (operator !== undefined) {
      // A `}` closes the innermost interpolation only when no table constructor
      // opened inside it is still open.
      if (operator === '{' && interpolations.length > 0) {
        interpolations[interpolations.length - 1] = (interpolations[interpolations.length - 1] as number) + 1;
      } else if (operator === '}' && interpolations.length > 0) {
        const depth = interpolations[interpolations.length - 1] as number;
        if (depth === 0) {
          interpolations.pop();
          push('op', '}', index);
          seek(index + 1);
          const outcome = lexInterpolationChunk(index);
          if (typeof outcome === 'string') return fail(outcome, index);
          continue;
        }
        interpolations[interpolations.length - 1] = depth - 1;
      }
      push('op', operator, index);
      seek(index + operator.length);
      continue;
    }

    return fail(`unexpected character ${JSON.stringify(ch)}`, index);
  }

  tokens.push({ kind: 'eof', text: '', line, column: column(index) });
  return { tokens };

  /**
   * Lexes the literal part of a backtick string starting at `from`, stopping at
   * the closing backtick or at a `{` that opens an expression. Returns a message
   * on failure so the caller can report it with the string's own position.
   */
  function lexInterpolationChunk(from: number): true | string {
    const chunkStart = from;
    let p = from;
    for (;;) {
      if (p >= length) return 'unterminated interpolated string';
      const c = source[p];
      if (c === '\\') {
        p += 2;
        continue;
      }
      if (c === '`' || c === '{') break;
      p += 1;
    }
    const raw = source.slice(chunkStart, p);
    const startColumn = column(chunkStart);
    const startLine = line;
    seek(p);
    tokens.push({
      kind: 'string',
      text: raw,
      value: decodeShortString(raw),
      line: startLine,
      column: startColumn,
    });
    if (source[p] === '`') {
      seek(p + 1);
      return true;
    }
    // `{` — the expression that follows lexes as ordinary tokens until its `}`.
    interpolations.push(0);
    push('op', '{', p);
    seek(p + 1);
    return true;
  }
}
