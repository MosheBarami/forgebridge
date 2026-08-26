/**
 * The contract around the rules: what `analyse` promises a caller, and the one
 * promise it must never break — that a source it could not read is never
 * reported as a pass.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Finding } from '@forgebridge/protocol';
import { describe, expect, it } from 'vitest';
import { analyse, INCOMPLETE_RULE, RULES, SYNTAX_ERROR_RULE } from '../src/index.js';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

const EVERY_RULE_ID = [...RULES.map((rule) => rule.id), SYNTAX_ERROR_RULE, INCOMPLETE_RULE];

describe('the rule registry', () => {
  it('gives every rule an id the protocol accepts', () => {
    for (const id of EVERY_RULE_ID) {
      const parsed = Finding.safeParse({ severity: 'error', rule: id, message: 'x' });
      expect(parsed.success, `${id} is not a valid Finding.rule`).toBe(true);
    }
  });

  it('has no duplicate ids', () => {
    expect(new Set(EVERY_RULE_ID).size).toBe(EVERY_RULE_ID.length);
  });

  it('declares at least one severity per rule, and only severities the protocol has', () => {
    for (const rule of RULES) {
      expect(rule.severities.length, rule.id).toBeGreaterThan(0);
      for (const severity of rule.severities) {
        expect(['error', 'warning', 'info']).toContain(severity);
      }
    }
  });

  it('is documented — every rule id appears in the README', () => {
    // The same standard docs/THREAT-MODEL.md is held to: a rule nobody can look
    // up is a rule whose finding a reader cannot act on.
    const readme = readFileSync(path.join(PACKAGE_ROOT, 'README.md'), 'utf8');
    for (const id of EVERY_RULE_ID) {
      expect(readme, `${id} is missing from the README`).toContain(id);
    }
  });
});

describe('analyse', () => {
  it('returns ok with no findings for a clean script', () => {
    expect(analyse('local function add(a: number, b: number)\n  return a + b\nend\nprint(add(1, 2))\n')).toEqual({
      status: 'ok',
      findings: [],
    });
  });

  it('produces findings the protocol schema accepts', () => {
    const source = 'loadstring("x")\nwait(1)\nrequire(42)\n';
    for (const finding of analyse(source).findings) {
      const parsed = Finding.safeParse(finding);
      expect(parsed.success, JSON.stringify(finding)).toBe(true);
    }
  });

  it('reports fail when any finding is an error, warn when the worst is a warning', () => {
    expect(analyse('loadstring("x")\n').status).toBe('fail');
    expect(analyse('wait(1)\n').status).toBe('warn');
    expect(analyse('print(1)\n').status).toBe('ok');
  });

  it('orders findings by position so two runs diff cleanly', () => {
    const result = analyse('wait(1)\nloadstring("a")\nspawn(f)\n');
    expect(result.findings.map((finding) => finding.line)).toEqual([1, 2, 3]);
  });

  it('gives every finding a 1-based line and column that points at the offending token', () => {
    const result = analyse('local x = 1\n    loadstring("a")\n');
    expect(result.findings[0]?.line).toBe(2);
    expect(result.findings[0]?.column).toBe(5);
  });

  it('stamps operationIndex when the caller is analysing one operation of a ChangeSet', () => {
    const result = analyse('loadstring("x")\n', { operationIndex: 3 });
    expect(result.findings[0]?.operationIndex).toBe(3);
  });

  it('stamps operationIndex on a syntax failure too', () => {
    const result = analyse('local a = "oops\n', { operationIndex: 7 });
    expect(result.findings[0]?.operationIndex).toBe(7);
    expect(result.findings[0]?.rule).toBe(SYNTAX_ERROR_RULE);
  });

  it('skips a disabled rule without treating it as passed', () => {
    expect(analyse('wait(1)\n', { disabledRules: ['luau/deprecated-wait-spawn'] })).toEqual({
      status: 'ok',
      findings: [],
    });
    // The rule is skipped, not weakened: it still fires when it is enabled.
    expect(analyse('wait(1)\n').status).toBe('warn');
  });

  it('treats an empty allowed-host list as allowing nothing', () => {
    const source = 'local Http = game:GetService("HttpService")\nHttp:GetAsync("https://api.example.com/v1")\n';
    expect(analyse(source).status).toBe('fail');
    expect(analyse(source, { allowedHttpHosts: [] }).status).toBe('fail');
    expect(analyse(source, { allowedHttpHosts: ['api.example.com'] }).status).toBe('ok');
  });
});

describe('the fail-closed invariant', () => {
  it('fails, never passes, on a source it cannot tokenize', () => {
    // The dangerous version of this bug: source that trips the lexer and whose
    // remainder holds something a rule would have caught.
    const result = analyse('local a = $\nloadstring("payload")\n');
    expect(result.status).toBe('fail');
    expect(result.findings[0]?.rule).toBe(SYNTAX_ERROR_RULE);
  });

  it('fails on a source whose blocks do not balance', () => {
    expect(analyse('local function f()\n  print(1)\n').status).toBe('fail');
  });

  it('fails, rather than truncating to a pass, when the token budget runs out', () => {
    const long = 'local a = 1\n'.repeat(200);
    const result = analyse(long, { maxTokens: 10 });
    expect(result.status).toBe('fail');
    expect(result.findings[0]?.rule).toBe(INCOMPLETE_RULE);
  });

  it('fails when a rule throws instead of returning what the other rules found', () => {
    const broken = { id: 'luau/deliberately-broken', severities: ['error'] as const, summary: 'test double', run(): never { throw new Error('boom'); } };
    const original = [...RULES];
    (RULES as unknown as { push(rule: unknown): void; length: number }).push(broken);
    try {
      const result = analyse('print(1)\n');
      expect(result.status).toBe('fail');
      expect(result.findings[0]?.rule).toBe(INCOMPLETE_RULE);
      expect(result.findings[0]?.message).toContain('boom');
    } finally {
      (RULES as unknown as { length: number }).length = original.length;
    }
  });

  it('never returns ok alongside a finding', () => {
    const sources = [
      'loadstring("x")\n',
      'wait(1)\n',
      'local a = "oops\n',
      'if a then\n',
      'print(1)\n',
      'require(1)\n',
    ];
    for (const source of sources) {
      const result = analyse(source);
      if (result.status === 'ok') expect(result.findings).toEqual([]);
      else expect(result.findings.length).toBeGreaterThan(0);
    }
  });
});
