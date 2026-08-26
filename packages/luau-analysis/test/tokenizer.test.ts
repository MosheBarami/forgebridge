import { describe, expect, it } from 'vitest';
import { tokenize } from '../src/tokenizer.js';

function kinds(source: string): string[] {
  const result = tokenize(source);
  expect(result.error).toBeUndefined();
  return result.tokens.filter((token) => token.kind !== 'eof').map((token) => `${token.kind}:${token.text}`);
}

describe('tokenize', () => {
  it('separates code from the text that merely mentions it', () => {
    const result = tokenize('-- loadstring here\nlocal s = "loadstring"\n');
    expect(result.error).toBeUndefined();
    const names = result.tokens.filter((token) => token.kind === 'name').map((token) => token.text);
    expect(names).toEqual(['s']);
  });

  it('reads long comments and long strings, including levelled brackets', () => {
    const result = tokenize('--[==[ end end end ]==]\nlocal d = [[\nwhile true do end\n]]\n');
    expect(result.error).toBeUndefined();
    const keywords = result.tokens.filter((token) => token.kind === 'keyword').map((token) => token.text);
    expect(keywords).toEqual(['local']);
    const string = result.tokens.find((token) => token.kind === 'string');
    expect(string?.value).toBe('while true do end\n');
  });

  it('lexes the expression inside a string interpolation as code', () => {
    // The point of doing this properly: `{loadstring(x)}` is a call, and an
    // analyser that swallowed the whole literal would never see it.
    expect(kinds('local s = `n is {count + 1}`')).toEqual([
      'keyword:local',
      'name:s',
      'op:=',
      'string:n is ',
      'op:{',
      'name:count',
      'op:+',
      'number:1',
      'op:}',
      'string:',
    ]);
  });

  it('does not let a table constructor inside an interpolation close it early', () => {
    const result = tokenize('local s = `{ { 1, 2 } } done`');
    expect(result.error).toBeUndefined();
    expect(result.tokens.filter((token) => token.kind === 'string').map((token) => token.text)).toEqual(['', ' done']);
  });

  it('reads Luau number forms', () => {
    expect(kinds('local a = 0xFF + 0b1010 + 1_000 + 1.5e-3 + .5')).toContain('number:0xFF');
    expect(kinds('local a = 0xFF + 0b1010 + 1_000 + 1.5e-3 + .5')).toContain('number:1.5e-3');
  });

  it('decodes the escapes the Luau VM would, because a rule compares that value', () => {
    // `Token.value` is what the HTTP egress rule matches against the allowed-host
    // list, so this decoder is a security component: `"\\104ttps://evil.com"` has
    // real value `https://evil.com`, and the version that dropped the backslash
    // and kept the `1` read it as `104ttps://evil.com` — not an absolute URL, so
    // never checked against anything.
    const value = (source: string): string | undefined =>
      tokenize(source).tokens.find((token) => token.kind === 'string')?.value;
    expect(value('local u = "\\104ttps://evil.com"')).toBe('https://evil.com');
    expect(value('local u = "\\x68ttps://evil.com"')).toBe('https://evil.com');
    expect(value('local s = "\\u{48}i"')).toBe('Hi');
    expect(value('local s = "tab\\9end"')).toBe('tab\tend');
    expect(value('local s = "\\a\\b\\f\\v"')).toBe('\u0007\b\f\u000b');
  });

  it('leaves the value unset rather than inventing text for an escape it cannot resolve', () => {
    // The control on the decoder, and the fail-closed half of it. None of these
    // is Luau, and a caller that needs the exact string must be told it cannot
    // have one — a guess here is a host compared against the wrong allowlist.
    const value = (source: string): string | undefined =>
      tokenize(source).tokens.find((token) => token.kind === 'string')?.value;
    expect(value('local s = "\\q"')).toBeUndefined();
    expect(value('local s = "\\xZZ"')).toBeUndefined();
    expect(value('local s = "\\300"')).toBeUndefined();
    expect(value('local s = "\\u{110000}"')).toBeUndefined();
    // And an ordinary literal still carries its value.
    expect(value('local s = "https://api.example.com/v1"')).toBe('https://api.example.com/v1');
  });

  it('lets `\\z` skip the whitespace after it, line breaks included', () => {
    // A wrapped URL. The scanner rejected the newline before it read the `\\z`
    // that legalises it, so a source Luau accepts was reported as a syntax error.
    const result = tokenize('local url = "https://api.example.com/\\z\n            v1/items"\n');
    expect(result.error).toBeUndefined();
    expect(result.tokens.find((token) => token.kind === 'string')?.value).toBe('https://api.example.com/v1/items');
  });

  it('still refuses a bare newline inside a quoted string', () => {
    // The control for `\\z`: without one, a newline inside quotes is the
    // unterminated-string case this lexer must keep catching.
    expect(tokenize('local s = "oops\nmore"\n').error?.message).toContain('unterminated string');
  });

  it('reports an unterminated string with its position rather than guessing', () => {
    const result = tokenize('local a = 1\nlocal b = "oops\n');
    expect(result.error?.message).toContain('unterminated string');
    expect(result.error?.line).toBe(2);
    expect(result.error?.column).toBe(11);
  });

  it('reports an unterminated long comment', () => {
    expect(tokenize('--[[ never closed\nlocal a = 1\n').error?.message).toContain('unterminated long comment');
  });

  it('counts lines across multi-line tokens so a finding points at the right line', () => {
    const result = tokenize('local d = [[\na\nb\n]]\nloadstring("x")\n');
    expect(result.error).toBeUndefined();
    const call = result.tokens.find((token) => token.kind === 'name' && token.text === 'loadstring');
    expect(call?.line).toBe(5);
    expect(call?.column).toBe(1);
  });
});
