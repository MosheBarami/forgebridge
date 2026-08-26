/**
 * Every rule gets two tests: one source that must fire it, and one source of the
 * shape it is most easily confused with that must not. The second is the one
 * that matters. A rule that fires on `settings.loadstring` or on a `for` loop in
 * a Heartbeat handler is a rule people learn to ignore, and an ignored rule
 * defends nothing.
 */
import { describe, expect, it } from 'vitest';
import { analyse, type AnalyseOptions } from '../src/index.js';

function rules(source: string, options?: AnalyseOptions): string[] {
  return analyse(source, options).findings.map((finding) => finding.rule);
}

function only(source: string, rule: string, options?: AnalyseOptions): void {
  expect(rules(source, options)).toEqual([rule]);
}

describe('luau/no-loadstring', () => {
  it('fires on the global, however it is reached', () => {
    only('local run = loadstring(payload)\nrun()\n', 'luau/no-loadstring');
    // Hidden inside a string interpolation, which a regex over the source misses.
    only('local s = `{loadstring("print(1)")}`\n', 'luau/no-loadstring');
  });

  it('does not fire on a field or a mention of the same name', () => {
    const source = [
      '-- loadstring is banned in this project',
      'local Compat = { loadstring = false }',
      'local note = "loadstring"',
      'if Compat.loadstring then print(note) end',
      '',
    ].join('\n');
    expect(analyse(source)).toEqual({ status: 'ok', findings: [] });
  });
});

describe('luau/no-getfenv-setfenv', () => {
  it('fires on either global', () => {
    only('setfenv(1, { print = print })\n', 'luau/no-getfenv-setfenv');
    only('local env = getfenv(2)\nprint(env)\n', 'luau/no-getfenv-setfenv');
  });

  it('does not fire on a method of the same name on somebody else\'s table', () => {
    const source = [
      'local Compat = {}',
      'function Compat.getfenv(level)',
      '  return level',
      'end',
      'print(Compat.getfenv(1))',
      '',
    ].join('\n');
    expect(analyse(source)).toEqual({ status: 'ok', findings: [] });
  });
});

describe('luau/require-unreviewed-asset', () => {
  it('fires on a numeric asset id', () => {
    only('local Lib = require(1234567)\n', 'luau/require-unreviewed-asset');
  });

  it('does not fire on a require by path, which is the shape it looks like', () => {
    const source = [
      'local Shared = require(script.Parent.Shared)',
      'local Shop = require(game:GetService("ReplicatedStorage").Modules.Shop)',
      'local Maybe = require(script:FindFirstChild("Optional"))',
      'print(Shared, Shop, Maybe)',
      '',
    ].join('\n');
    expect(analyse(source)).toEqual({ status: 'ok', findings: [] });
  });
});

describe('luau/http-egress-unallowlisted', () => {
  const ALLOWED: AnalyseOptions = { allowedHttpHosts: ['api.example.com'] };
  const HEAD = 'local Http = game:GetService("HttpService")\n';

  it('fires on a host that is not on the list', () => {
    only(`${HEAD}Http:GetAsync("https://collector.evil.net/x")\n`, 'luau/http-egress-unallowlisted', ALLOWED);
  });

  it('fires on a host that merely starts with an allowed one', () => {
    // The bug this test exists for: a prefix match would let
    // `api.example.com.attacker.net` through an `api.example.com` entry.
    const result = analyse(`${HEAD}Http:GetAsync("https://api.example.com.attacker.net/x")\n`, ALLOWED);
    expect(result.status).toBe('fail');
    expect(result.findings[0]?.message).toContain('api.example.com.attacker.net');
  });

  it('fires when the project allows no hosts at all', () => {
    only(`${HEAD}Http:GetAsync("https://api.example.com/v1")\n`, 'luau/http-egress-unallowlisted');
  });

  it('warns, rather than passing, when the URL is built at run time', () => {
    const result = analyse(`${HEAD}Http:GetAsync(endpoint .. "/v1")\n`, ALLOWED);
    expect(result.status).toBe('warn');
    expect(result.findings[0]?.rule).toBe('luau/http-egress-unallowlisted');
  });

  it('reads the URL out of a RequestAsync table', () => {
    only(
      `${HEAD}Http:RequestAsync({ Url = "https://collector.evil.net/x", Method = "POST" })\n`,
      'luau/http-egress-unallowlisted',
      ALLOWED,
    );
  });

  it('does not fire on an allowed host, a subdomain entry, or a method that never leaves the machine', () => {
    const source = [
      HEAD.trimEnd(),
      'local body = Http:GetAsync("https://api.example.com/v1/items")',
      'local cdn = Http:GetAsync("https://images.cdn.example.org/logo.png")',
      'local id = Http:GenerateGUID(false)',
      'print(Http:JSONDecode(body), cdn, id)',
      '',
    ].join('\n');
    expect(analyse(source, { allowedHttpHosts: ['api.example.com', '.cdn.example.org'] })).toEqual({
      status: 'ok',
      findings: [],
    });
  });
});

describe('luau/unbounded-heartbeat', () => {
  const HEAD = 'local RunService = game:GetService("RunService")\n';

  it('fires on a `while` loop inside a per-frame handler', () => {
    const source = `${HEAD}RunService.Heartbeat:Connect(function()\n  while queue.count > 0 do\n    process(queue)\n  end\nend)\n`;
    const result = analyse(source);
    expect(result.findings.map((finding) => finding.rule)).toEqual(['luau/unbounded-heartbeat']);
    expect(result.status).toBe('fail');
  });

  it('warns when the loop can exit but nothing bounds it', () => {
    const source = `${HEAD}RunService.Stepped:Connect(function()\n  while queue.count > 0 do\n    process(queue)\n    if budgetSpent() then break end\n  end\nend)\n`;
    const result = analyse(source);
    expect(result.status).toBe('warn');
    expect(result.findings.map((finding) => finding.rule)).toEqual(['luau/unbounded-heartbeat']);
  });

  it('does not fire on bounded per-frame work, which is what a handler is for', () => {
    const source = [
      HEAD.trimEnd(),
      'RunService.Heartbeat:Connect(function(deltaTime)',
      '  for _, part in ipairs(spinners) do',
      '    part.CFrame = part.CFrame * CFrame.Angles(0, deltaTime, 0)',
      '  end',
      'end)',
      '',
    ].join('\n');
    expect(analyse(source)).toEqual({ status: 'ok', findings: [] });
  });
});

describe('luau/while-true-no-yield', () => {
  it('fires on a spin loop', () => {
    only('local total = 0\nwhile true do\n  total = total + 1\nend\n', 'luau/while-true-no-yield');
    only('repeat\n  step()\nuntil false\n', 'luau/while-true-no-yield');
  });

  it('does not fire when the loop yields or can leave', () => {
    const yields = 'while true do\n  task.wait(1)\n  tick()\nend\n';
    const breaks = 'while true do\n  if finished then break end\n  step()\nend\n';
    const signal = 'while true do\n  RunService.Heartbeat:Wait()\n  step()\nend\n';
    for (const source of [yields, breaks, signal]) {
      expect(analyse(source)).toEqual({ status: 'ok', findings: [] });
    }
  });

  it('does not count a yield that belongs to a nested closure', () => {
    // `task.wait()` here yields the spawned thread, not the loop, so the loop
    // still never gives the scheduler a turn.
    const source = 'while true do\n  task.spawn(function()\n    task.wait(1)\n  end)\nend\n';
    expect(rules(source)).toEqual(['luau/while-true-no-yield']);
  });
});

describe('luau/remote-no-validation', () => {
  const HEAD = 'local Remotes = game:GetService("ReplicatedStorage").Remotes\n';

  it('fires on a client-supplied argument used without a check', () => {
    const source = `${HEAD}Remotes.GiveCash.OnServerEvent:Connect(function(player, amount)\n  player.leaderstats.Cash.Value += amount\nend)\n`;
    const result = analyse(source);
    expect(result.findings.map((finding) => finding.rule)).toEqual(['luau/remote-no-validation']);
    expect(result.status).toBe('warn');
    expect(result.findings[0]?.message).toContain('amount');
    // Positioned on the use, not on the parameter declaration: the message says
    // "used here", and a reader following it should land on the line that uses it.
    expect(result.findings[0]?.line).toBe(3);
  });

  it('fires on a handler that takes `...` from the client', () => {
    const source = `${HEAD}Remotes.Do.OnServerEvent:Connect(function(player, ...)\n  handle(player, ...)\nend)\n`;
    expect(rules(source)).toEqual(['luau/remote-no-validation']);
  });

  it('fires on OnServerInvoke as well as OnServerEvent', () => {
    const source = `${HEAD}Remotes.Buy.OnServerInvoke = function(player, itemId)\n  return grant(player, itemId)\nend\n`;
    expect(rules(source)).toEqual(['luau/remote-no-validation']);
  });

  it('does not fire on the validated version of the same handler', () => {
    const source = [
      HEAD.trimEnd(),
      'Remotes.GiveCash.OnServerEvent:Connect(function(player, amount)',
      '  if typeof(amount) ~= "number" then return end',
      '  if amount <= 0 or amount > 100 then return end',
      '  player.leaderstats.Cash.Value += math.floor(amount)',
      'end)',
      '',
    ].join('\n');
    expect(analyse(source)).toEqual({ status: 'ok', findings: [] });
  });

  it('does not fire on a handler with nothing but the player argument', () => {
    const source = `${HEAD}Remotes.Ping.OnServerEvent:Connect(function(player)\n  print(player.Name)\nend)\n`;
    expect(analyse(source)).toEqual({ status: 'ok', findings: [] });
  });

  it('accepts an assert as the check', () => {
    const source = `${HEAD}Remotes.Buy.OnServerEvent:Connect(function(player, itemName)\n  assert(typeof(itemName) == "string", "bad item")\n  grant(player, itemName)\nend)\n`;
    expect(analyse(source)).toEqual({ status: 'ok', findings: [] });
  });
});

describe('luau/deprecated-wait-spawn', () => {
  it('fires on the deprecated globals', () => {
    const result = analyse('wait(1)\nspawn(function() end)\ndelay(2, callback)\n');
    expect(result.findings.map((finding) => finding.rule)).toEqual([
      'luau/deprecated-wait-spawn',
      'luau/deprecated-wait-spawn',
      'luau/deprecated-wait-spawn',
    ]);
    expect(result.status).toBe('warn');
  });

  it('does not fire on the `task` library or on a signal\'s `Wait`', () => {
    const source = [
      'task.wait(1)',
      'task.spawn(function() end)',
      'task.delay(2, callback)',
      'part.Touched:Wait()',
      'local delay = 0.5',
      'print(delay)',
      '',
    ].join('\n');
    expect(analyse(source)).toEqual({ status: 'ok', findings: [] });
  });
});

describe('luau/syntax-error', () => {
  it('fires — and reports nothing else — when the source does not tokenize', () => {
    const result = analyse('local a = 1\nlocal b = "oops\nloadstring("x")\n');
    expect(result.status).toBe('fail');
    expect(result.findings.map((finding) => finding.rule)).toEqual(['luau/syntax-error']);
    expect(result.findings[0]?.line).toBe(2);
  });

  it('fires when the blocks do not balance', () => {
    const result = analyse('if ready then\n  print(1)\n');
    expect(result.status).toBe('fail');
    expect(result.findings.map((finding) => finding.rule)).toEqual(['luau/syntax-error']);
  });

  it('does not fire on the modern Luau it is most likely to trip over', () => {
    const source = [
      '--!strict',
      'type Config = { retries: number, host: string? }',
      'local label = if ready then "go" else "wait"',
      'local greeting = `hello {label}, {#queue} waiting`',
      'local doc = [==[ while true do end ]==]',
      'local total: number = 0',
      'total += 1',
      'local cast = (total :: any) :: number',
      'local function pick<T>(a: T, b: T): T',
      '  return if total > 0 then a else b',
      'end',
      'print(greeting, doc, cast, pick(1, 2))',
      '',
    ].join('\n');
    expect(analyse(source)).toEqual({ status: 'ok', findings: [] });
  });

  it('does not read a keyword inside a comment or a long string as code', () => {
    const source = ['-- while true do end', 'local doc = [[', 'while true do', '  print("docs")', 'end', ']]', 'print(doc)', ''].join('\n');
    expect(analyse(source)).toEqual({ status: 'ok', findings: [] });
  });
});

/**
 * Bypasses found by adversarial review, each reproduced against the built
 * analyser before it was fixed. They share one root cause: the rules were
 * fail-OPEN — a token shape they did not recognise produced no finding, so
 * "I don't understand this" and "this is safe" were the same answer.
 *
 * Every case below returned `status: 'ok'` with zero findings.
 */
describe('fail-closed regressions', () => {
  const ALLOW: AnalyseOptions = { allowedHttpHosts: ['api.example.com'] };

  it('reads the host from the authority, not from after an @ in the path', () => {
    // normaliseHost stripped userinfo before it cut the path, so this URL —
    // which really reaches evil.com — was read as host api.example.com and
    // matched the allowlist.
    const result = analyse('HttpService:GetAsync("https://evil.com/@api.example.com")\n', ALLOW);
    expect(result.status).not.toBe('ok');
  });

  it('sees a call chained straight off GetService', () => {
    // The receiver of `:GetAsync` here is `)`, not a name, so the receiver
    // guard skipped it. This is the most ordinary one-liner in Roblox code.
    const result = analyse('game:GetService("HttpService"):GetAsync("https://evil.com/x")\n', ALLOW);
    expect(result.status).not.toBe('ok');
  });

  it('sees Luau call forms that take no parentheses', () => {
    // `f"str"` and `f{tbl}` are calls. Requiring `(` meant deleting two
    // characters turned the rule off.
    const head = 'local H = game:GetService("HttpService")\n';
    expect(analyse(`${head}H:GetAsync"https://evil.com"\n`, ALLOW).status).not.toBe('ok');
    expect(analyse(`${head}H:RequestAsync{Url = "https://evil.com"}\n`, ALLOW).status).not.toBe('ok');
  });

  it('reports a call whose receiver it cannot resolve, when the source uses HttpService', () => {
    const source = 'local H = game:GetService("HttpService")\nlocal t = pick()\nt:GetAsync("https://evil.com")\n';
    expect(analyse(source, ALLOW).status).not.toBe('ok');
  });

  it('does NOT report a DataStore call in a source that never touches HttpService', () => {
    // The control for the rule above. Fail-closed must not mean fail-noisy:
    // `:GetAsync` is DataStore's method too, and flagging it would train
    // people to ignore the rule.
    const source = 'local ds = game:GetService("DataStoreService"):GetDataStore("s")\nlocal v = ds:GetAsync("k")\n';
    expect(analyse(source, ALLOW)).toEqual({ status: 'ok', findings: [] });
  });

  it('reads a require argument through wrapping parentheses', () => {
    // One added pair of parentheses — not even obfuscation — turned the rule off.
    expect(analyse('require((1234567))\n').status).not.toBe('ok');
    expect(analyse('require(1234567 + 0)\n').status).not.toBe('ok');
  });

  it('still treats a path built with a service call as a path', () => {
    // The control for the require fix: a path may carry strings and call
    // parens, it just may not carry a number or arithmetic.
    const source = 'local Shop = require(game:GetService("ReplicatedStorage").Modules.Shop)\nprint(Shop)\n';
    expect(analyse(source)).toEqual({ status: 'ok', findings: [] });
  });
});
