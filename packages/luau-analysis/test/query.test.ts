import { describe, expect, it } from 'vitest';
import { analyse } from '../src/analyse.js';

/**
 * `isYieldCall` decides whether a loop gives the scheduler a turn, and
 * `luau/while-true-no-yield` is an `error` — a loop it clears is a loop this
 * package has said will not hang Studio. So the one member of the yield set a
 * script can define for itself is worth its own tests.
 *
 * Reproduced against the built analyser before the fix: the first source below
 * returned `{"status":"ok","findings":[]}` while spinning for ever.
 */
describe('fail-closed regressions: crediting `:Wait()` as a yield', () => {
  it('does not let a script define its own do-nothing `Wait` and clear the loop rule', () => {
    // `:Wait()` yields on an `RBXScriptSignal`. Nothing in a token stream says
    // the receiver is one, so two lines of setup turned the rule off.
    const own = 'local o = {}\nfunction o:Wait() end\nwhile true do o:Wait() step() end\n';
    expect(analyse(own).findings.map((finding) => finding.rule)).toEqual(['luau/while-true-no-yield']);

    // The same thing spelled as a field, which is the other way a table gets a
    // method and would otherwise be the one-line way back around the fix.
    const field = 'local o = { Wait = function() end }\nwhile true do o:Wait() step() end\n';
    expect(analyse(field).findings.map((finding) => finding.rule)).toEqual(['luau/while-true-no-yield']);
  });

  it('still credits a custom signal whose own `Wait` yields', () => {
    // The control, and the shape this is most easily confused with: writing a
    // signal class is ordinary Roblox code, its `Wait` does yield, and a rule
    // that reported those loops as freezes is a rule people learn to click past.
    const yields = [
      'local Signal = {}\nSignal.__index = Signal\nfunction Signal:Wait()\n  coroutine.yield()\nend\nwhile true do sig:Wait() end\n',
      'local Signal = {}\nfunction Signal:Wait()\n  while not self.fired do task.wait() end\nend\nwhile true do sig:Wait() end\n',
    ];
    for (const source of yields) expect(analyse(source), source).toEqual({ status: 'ok', findings: [] });
  });

  it('still credits `:Wait()` in a file that defines no `Wait` of its own', () => {
    // The commonest spelling of all: a real signal, waited on in a loop.
    const source = 'local RunService = game:GetService("RunService")\nwhile true do RunService.Heartbeat:Wait() end\n';
    expect(analyse(source)).toEqual({ status: 'ok', findings: [] });
  });

  it('still credits the yields that are not `:Wait()`, in the same file', () => {
    // Withdrawing the credit is scoped to `Wait`: a file with a do-nothing
    // `Wait` in it still has a working `task.wait()`.
    const source = 'local o = {}\nfunction o:Wait() end\nwhile true do task.wait() end\n';
    expect(analyse(source)).toEqual({ status: 'ok', findings: [] });
  });
});
