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
   * Decoded contents of a string literal. Present only on `string` tokens, and
   * only for the escapes listed in `decodeShortString` — a rule that needs an
   * exact value (the HTTP egress rule reading a URL) must tolerate `undefined`.
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

/**
 * Resolves the escapes whose meaning a rule could plausibly depend on. Anything
 * else is left as written rather than guessed at: a URL rule that silently
 * mis-decodes `\u{...}` would compare the wrong host against the allowlist.
 */
function decodeShortString(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    i += 1;
    switch (next) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '\\': out += '\\'; break;
      case '"': out += '"'; break;
      case "'": out += "'"; break;
      case '\n': out += '\n'; break;
      default: out += next ?? '';
    }
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
