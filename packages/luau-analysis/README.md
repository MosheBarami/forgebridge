# @forgebridge/luau-analysis

A linter for model-authored Luau.

This is layer 2 of the five in [`docs/THREAT-MODEL.md`](../../docs/THREAT-MODEL.md) T2 — the
defence against a destructive or malicious ChangeSet. Layer 1 is the Zod schema, which rejects
anything not in the protocol. Layer 3 is the project path policy. This sits between them and reads
the one thing neither of those can: the source text a model wrote.

## What it is, and what it is not

It is a **token-based linter for known mistakes**. It carries nine rules for the specific errors
models make in Roblox code, each one chosen because it is both common and expensive, and each one
written so that a reader can check the finding against the line it points at. A tenth id,
`luau/analysis-incomplete`, is not a rule at all — it is how the analyser says it did not finish.

**Token-based** is the whole shape of it. There is a lexer and a block recogniser and nothing else:
no grammar, no AST, no type system, no dataflow, no call graph. Every rule is a question asked of a
token stream, and the reach of every rule is bounded by that. It is not a parser and it is not a
proof of safety, and nothing downstream should treat an `ok` from it as either:

- It does not type-check. Luau's type system is not implemented here and never will be by this
  package.
- It does not model dataflow. It cannot tell you that a tainted value reaches a sink, only that a
  value was used without ever being tested.
- It does not understand intent. A script that does something harmful using nothing but ordinary
  API calls passes every rule, because every rule passes.
- It has no list of "bad" API calls beyond the ones below. There is no signature database here and
  no heuristic scoring.

`ok` from this analyser means *none of these nine rules fired*. That is a useful thing to know and
it is a smaller thing than "this script is safe". The Studio plugin sends every ChangeSet carrying
Luau source to a human regardless of the verdict, and that ordering is deliberate
([ADR-012](../../docs/architecture/adr-012-approval-gated-apply.md)): this layer reduces how often
a human has to catch something, it does not replace the human.

### The one hop it follows

Two rules need a name that was bound in an earlier statement, and both resolve it the same way and
only that way: a name bound **once, in this file, directly to an expression written out in full**.

```lua
local Http = game:GetService("HttpService")   -- `Http` is the service from here on
local heartbeat = RunService.Heartbeat        -- `heartbeat` is a per-frame signal
```

That binding is read through a type annotation (`local Http: HttpService = …`) and through
multi-value assignment (`local retries, Http = 3, …`), because both are ordinary spellings of the
same line and a check that missed them reported the wrong severity on every call that followed.

It does not chain: `local alias = Http` binds nothing this analyser knows, because the value there
is a name rather than the service lookup itself. And it is not scoped — a name is a service name
for the whole file as soon as one binding to the service appears anywhere in it, including below
the call that uses it, and a later reassignment does not take it back. That is deliberate: this
analyser cannot prove where a binding stops holding, so it keeps the reading that produces a
finding rather than the one that hides it.

### What it cannot see
### It does not resolve scope

There is no symbol table. A name is judged by the tokens around it, so a *use*
of a local that shadows a banned global — `local ok, loadstring = pcall(f)` and
then `loadstring` on a later line — is reported as a use of the global. The
declaration itself is correctly ignored; the later use is not distinguishable
without scope resolution, which a token recogniser does not have.

This is a false positive, not a hole, and it is the trade this design accepts:
a rule that stays quiet when it cannot resolve a name would be fail-open, and
fail-open is what round two and round three of review kept finding. When the
two must be traded, this analyser errs toward telling you.


Everything past that one hop. These are the classes of it, and the last column is what the analyser
actually reports today — measured against the code in `src/`, not what it ought to do:

| Out of reach | Example | Reported today |
|---|---|---|
| **Dataflow through a variable** — a value that reaches the call through a name | `local url = "https://evil.com"`<br>`Http:GetAsync(url)` | `warning`: "built at run time" |
| **Values assembled at run time** — concatenation, `string.format`, interpolation | `Http:GetAsync(base .. "/x")` | `warning`: "built at run time" |
| **A receiver it cannot resolve**, in a file that does use `HttpService` | `local m = Http`<br>`m:GetAsync(url)` | `warning`: "cannot resolve" |
| **Indirection through a table** — the function stored, then called from the field | `local t = { fetch = Http.GetAsync }`<br>`t.fetch(Http, url)` | **nothing** |
| **Indirection through an index** — the method named by a string | `local name = "GetAsync"`<br>`Http[name](Http, url)` | **nothing** |
| **A method called with `.` instead of `:`** | `Http.GetAsync(Http, url)` | **nothing** |
| **A service that arrives as a parameter** | `function fetch(service, url)`<br>`  return service:GetAsync(url)` | **nothing** |
| **A handler that is not written inline** | `remote.OnServerEvent:Connect(onGive)` | **nothing** |
| **An argument held in a variable** | `local id = 1234567`<br>`require(id)` | **nothing** |
| **A loop condition held in a variable** | `local always = true`<br>`while always do … end` | **nothing** |
| **Anything in another file** | a module that returns `loadstring`, and its caller | **nothing** |

The `warning` rows are the ones where a rule recognised the call, found it could not read what it
needed, and said so. The **nothing** rows are silent: the rule never recognised the shape as the
thing it checks at all, and an `ok` covering one of them means only that this analyser had no
question to ask about it. Closing them needs dataflow, dataflow needs a parse, and the parser
question is the one below. TODO(M10 follow-up).

Two consequences worth stating plainly rather than leaving a reader to infer.

**This is not a defence against somebody who is trying.** Every silent row above is a one-line
rewrite of code a rule does catch, and none of them is exotic — `Http.GetAsync(Http, url)` is just
Luau, written the other way. What this layer defends against is a model that made a common
mistake, which is what THREAT-MODEL T2 sizes it for. The control against a determined author is the
human approval gate; this layer changes how often that human has to be the one who notices.

**It has no name resolution.** A local that shadows a global is not tracked, so `local wait =
task.wait` followed by `wait(1)` is reported as a use of the deprecated global — a false positive,
and a deliberate one, because the alternative is to trust a binding this analyser cannot verify was
never reassigned. The *declaration* is not reported; the use is.

## The one invariant

**A source this analyser could not read is never reported as a pass.**

A lexer error, a block that does not close, a token budget that ran out, an exception thrown by a
rule — every one of those returns `fail`, with a finding naming what happened. The alternative is
the failure this package exists to avoid: a rule that silently did not fire, and an `ok` that means
"we did not look". The layers after this one are calibrated on its answer, so an unearned `ok` is
worse than no analyser at all.

That invariant is exercised in [`packages/luau-analysis/test/analyse.test.ts`](test/analyse.test.ts),
including the case where a rule throws.

## Using it

```ts
import { analyse } from '@forgebridge/luau-analysis';

const result = analyse(source, {
  // Hosts HttpService may reach. Empty — and the default is empty — allows none.
  allowedHttpHosts: ['api.example.com'],
  // Attribute findings back to one operation of a ChangeSet.
  operationIndex: 2,
});

result.status;   // 'ok' | 'warn' | 'fail'
result.findings; // Finding[] — the protocol's own type, from @forgebridge/protocol
```

`status` is `fail` when any finding is an `error`, `warn` when the worst is a `warning`, `ok` when
there are none. Findings are sorted by line, then column, then rule id, so two runs over the same
source diff cleanly.

Findings carry `line` and `column` pointing at the offending token, 1-based, as
`Finding` in [`packages/protocol/src/changeset.ts`](../protocol/src/changeset.ts) requires. Every
finding is checked against that schema before it leaves a rule, so a malformed one fails loudly
here, where the rule that produced it is still named, rather than silently downstream.

### Options

| Option | Default | Meaning |
|---|---|---|
| `allowedHttpHosts` | `[]` | Hosts `HttpService` may reach. Empty allows none — the fail-closed reading, matching how the core reads an empty path allowlist. |
| `disabledRules` | `[]` | Rule ids to skip. A skipped rule does not run and does not contribute to the status; nothing treats it as passed. |
| `operationIndex` | — | Stamped onto every finding, including a syntax failure. |
| `maxTokens` | `MAX_SCRIPT_BYTES / 2` | Token ceiling. Reaching it ends the analysis with `fail`, never a partial pass. |

## The rules

Each rule has a stable id — never renamed, because suppressions and documentation point at it — and
each has two tests: one source that must fire it, and one source of the shape it is most easily
confused with that must not. The second is the one that matters. A rule that fires on
`settings.loadstring` is a rule people learn to click past, and a rule people click past defends
nothing. Both halves live in
[`packages/luau-analysis/test/rules.test.ts`](test/rules.test.ts).

| Rule | Severity | Fires on | Deliberately does not fire on |
|---|---|---|---|
| `luau/syntax-error` | error | Source that does not tokenize, or whose blocks or brackets do not balance. Reported alone — no other rule runs. | Modern Luau: if-expressions, string interpolation, type annotations and generics, `::` casts, compound assignment, levelled long strings. |
| `luau/no-loadstring` | error | A free reference to the `loadstring` global, including one hidden inside a string interpolation. | `settings.loadstring`, a table key named `loadstring`, the word in a comment or a string. |
| `luau/no-getfenv-setfenv` | error | A free reference to `getfenv` or `setfenv`. | A method of that name on somebody else's table (`Compat.getfenv`). |
| `luau/require-unreviewed-asset` | error | `require(1234567)` — a numeric catalog asset id. | `require(script.Parent.Shared)` and every other require by path. |
| `luau/http-egress-unallowlisted` | error / warning | `HttpService:GetAsync`/`PostAsync`/`RequestAsync` to a host not on `allowedHttpHosts`, including one written with string escapes. Warning when the URL is built at run time, or when the receiver cannot be resolved in a file that does use `HttpService`. | An allowed host, a subdomain of a `.example.com` entry, service methods that never leave the machine (`JSONDecode`, `GenerateGUID`), and `:GetAsync` on a DataStore in a file that never touches `HttpService`. |
| `luau/unbounded-heartbeat` | error / warning | A `while` or `repeat` loop inside a `RunService.Heartbeat`/`Stepped`/`RenderStepped` handler, whether the signal is named at the `Connect` or reached through a local bound to it. Error when the loop has no yield, `break` or `return`; warning when it can exit but nothing bounds it. | Bounded per-frame work — a numeric or generic `for` over a collection, which is what a handler is for — and a local holding a signal that does not fire per frame. |
| `luau/while-true-no-yield` | error | A loop whose condition is a literal Luau never reads as false — `while true`, `while 1`, `while "x"`, `while ((true))`, `repeat … until false`, `until nil` — with no yield, `break` or `return` that can run on the loop's own thread. | A loop with a real condition, one that calls `task.wait()`, waits on a signal, or can `break`. Three things do **not** count as an escape: a `task.wait()` inside a nested closure (it yields that closure), a `break` inside a nested closure (it belongs to no loop), and a `break` or `return` in the dead branch of a literal `if false`. A bare mention of `task.wait` is not a call and is not a yield. |
| `luau/remote-no-validation` | warning | An `OnServerEvent` or `OnServerInvoke` handler that uses an argument past `player` without ever testing it, or that takes `...`. | The same handler with an `if typeof(x) ~= …` guard, an `assert`, or with no argument but `player`. |
| `luau/deprecated-wait-spawn` | warning | A call to the global `wait`, `spawn` or `delay`. | `task.wait`, `task.spawn`, `task.delay`, a signal's `:Wait()`, and a local variable named `delay` that is merely read. |
| `luau/analysis-incomplete` | error | The analysis stopped early: token budget exceeded, or a rule threw. Not a verdict on the script. | — |

Three of these deserve their reasoning spelled out.

**`luau/remote-no-validation` is a use-without-test check, not a proof of correct validation.** It
asks whether the script looked at the value at all before using it — a mention inside an
`if`/`elseif`/`while`/`until` condition, or as an argument to `assert`, `typeof`, `type` or
`tonumber`. That catches the version with no check anywhere, which is the common one. It will not
catch a check that is present and wrong, and it does not track rebinding or shadowing. It is a
`warning` rather than an `error` for exactly that reason: a heuristic that can block a ChangeSet on
its own is a heuristic somebody deletes. TODO(M10 follow-up): the stronger form needs real dataflow
— a value reaching a sink after a test that constrains its type and range.

**`luau/unbounded-heartbeat` reads the loop, not the cost.** "Work with no budget" is not decidable
from tokens; a handler that calls one expensive function per frame looks identical to one that calls
a cheap one. What is decidable is that a per-frame callback contains an open-ended loop, and that is
the shape that actually freezes Studio. A handler doing genuinely heavy bounded work is not reported.
TODO(M10 follow-up): a cost model that could see the second case needs call-graph knowledge this
package does not have.

**`luau/while-true-no-yield` decides one thing about reachability and refuses the rest.** Whether a
loop can end is not decidable in general, so the rule asks two questions it can answer from tokens:
is the condition a literal Luau never reads as false, and is there a `break` or `return` that could
actually run. The second one has to discount a `break` inside a nested closure, which belongs to no
loop, and a `break` in the `then` of an `if false`, which is valid Luau that never executes —
either one, counted, reports a loop that hangs Studio for ever as one that can leave. Anything less
obvious than a literal condition is treated as reachable, which keeps the rule quiet rather than
guessing. A loop whose condition is held in a variable — `local always = true; while always do` —
is not reported at all; that is the dataflow gap, not a reachability decision.

## How it reads Luau

Two passes, and neither is a parser.

**A tokenizer** (`src/tokenizer.ts`) that handles comments including levelled long comments, short
strings, long strings, string interpolation, the Luau number forms (hex, binary, underscore
separators, exponents), names, keywords, and the operator set including `//`, `::`, `->` and the
compound assignments. This is why the rules see code as code and text as text: a comment that
mentions `loadstring` is not a call, and a `loadstring` inside a `{…}` of a backtick string is.

Its string decoder is a security component rather than a convenience, because `Token.value` is what
the egress rule compares against the allowed-host list. It resolves the escapes the Luau VM
resolves — `\a \b \f \n \r \t \v \\ \" \' \z`, decimal `\ddd`, hex `\xNN`, and `\u{…}` as UTF-8 bytes —
so `"\104ttps://evil.com"` is read as the `https://evil.com` it really is. For an escape it cannot
resolve exactly it leaves `value` unset rather than guessing, and every rule that needs an exact
value treats a missing one as unreadable, which is a `warning` rather than an `ok`.

**A block and bracket recogniser** (`src/structure.ts`) that pairs `function`/`if`/`do`/`repeat`
with `end`/`until`, pairs `(`, `[` and `{`, records for every token which block, which function and
which loop encloses it, and marks the `then`/`else`/`elseif` tokens that belong to an if-*expression*
rather than to an `if` block. That last part is what lets a rule say "this `break` belongs to the
inner loop, not the outer one" and "this `task.wait()` yields the spawned closure, not the loop
around it" — distinctions a flat text scan cannot make and that would otherwise turn a real freeze
into a clean bill of health.

### What the recogniser understands, and what it does not

Understood, and tested:

- `if` **expressions**, including chained ones. `local x = if ready then 1 else 2` has no `end`.
  The recogniser tells an if-expression from an if-statement by the token before it — an expression
  can only appear where a value is expected — and the set of those tokens is written out in
  `src/structure.ts`. `then` and `else` are not in that set, because they introduce a statement far
  more often than a value; instead the recogniser tracks the if-expressions it has open, so the
  second `if` in `if ready then if fast then "go" else "jog" else "wait"` is read as a value while
  the second `if` in `if ready then if fast then go() end end` is read as a statement. Counting an
  expression as a block opener would report perfectly good Luau as unterminated, which is a `fail`
  on correct code and the most likely way this package would be wrong in practice.
- String interpolation, including a table constructor nested inside the expression.
- Type annotations, generics, `::` casts, `--!strict` and attribute-looking `@name` prefixes: these
  lex without error and are otherwise ignored.

Not understood, and stated so nobody assumes otherwise:

- **There is no grammar.** `luau/syntax-error` catches lexical errors and unbalanced blocks and
  brackets. It does not catch a statement that is malformed but balanced — `local = 1`,
  `f(1,,2)`, `x = = y`. A source with an error of that kind is reported by its other rules and by
  `ok` on this one, and it will fail when Studio compiles it. This is the largest gap in the
  package and the honest name for it is: this analyser tells you it *could not read* a file, not
  that the file is *valid Luau*.
- **No reachability, beyond one literal.** A `break` in the `then` of an `if false` is known to be
  dead, and so is an arm after an `if true`; nothing subtler than a literal condition is decided,
  and everything undecided is treated as reachable.
- **No name resolution.** `local wait = task.wait; wait(1)` is not recognised as safe; a local
  shadowing a parameter inside a remote handler is not tracked. The one hop described above is a
  binding table built by two rules, not a scope chain.
- **No cross-file view.** Each source is analysed alone. A module that returns `loadstring` and a
  caller that uses it are two clean files.
- **HttpService is recognised by name.** The literal `HttpService`, and any variable bound to
  `…:GetService("HttpService")` in the same file. A service passed in as a parameter, or reached
  through a table or an index, is missed — see the table above for what that costs.
- **`goto`, and Lua 5.1 constructs Luau dropped**, are not special-cased in any way.

## Why there is no third-party parser here

The npm registry was searched before this was written (2026-08-26). What is published:

- **`@roblox-ts/luau-ast`** (2.0.1, 2025-11-12) — an AST *builder and renderer* for the roblox-ts
  compiler. It constructs Luau and prints it. It does not read Luau, so it cannot be a parser for
  this package.
- **`tree-sitter-luau`** (1.2.0, 2024-12-22) — a genuine Luau grammar, and the closest thing to a
  fit. Its Node bindings compile a native addon at install time (`node-gyp-build`); the WASM route
  means committing a binary blob. Either would put a compiled artefact in the dependency path of
  the one package in this repository whose entire job is running over hostile input, and it would
  land in a tree whose supply-chain posture is already an open milestone
  (T6: SBOM and SAST are M42). That is a decision for a human with the release pipeline in front of
  them, not one to take by adding a dependency.
- **`luau-web`** (1.4.0, 2026-03-11) — bindings to the Luau *VM*. Executing model-authored source
  to find out whether it is safe is the opposite of what this layer is for.
- **`luau-lsp`** (1.0.0, 2026-08-09) — a wrapper that fetches and runs the `luau-lsp` binary. An
  external toolchain download, not a library.

So: a focused tokenizer and recogniser, written here, understood here, with its limits written down
above. If `tree-sitter-luau` is later adopted, the rules are written against `Token` and `Structure`
and would be re-pointed rather than rewritten.

## Status

M10, after three rounds of adversarial review. Round two closed the fail-open bypasses — a receiver
or a call form a rule did not recognise used to produce no finding, so "I do not understand this"
and "this is safe" were the same answer. Round three closed the layer under that: a rule that fired
with the wrong severity because it could not resolve a binding, a rule silenced by a `break` the
script never reaches, a guard range that ran past the end of its own construct, and a string
decoder that read `"\104ttps://evil.com"` as something other than the URL it is. Both rounds are
pinned by their own `describe` block in [`test/rules.test.ts`](test/rules.test.ts), and every fix
in them is paired with the legitimate shape it is most easily confused with — a fix that turns a
false negative into a false positive has moved the problem rather than solved it.

The rules and the analyser are built and tested, and **`packages/daemon` calls `analyse`
at submit time**, inside the trust boundary, over every source a ChangeSet carries — a
`writeScript`, a `setProperty` writing `Source`, or a `createInstance` with `Source` in its
property bag. The verdict it computes overwrites whatever `validation` the producer sent, and
`POST /v1/changesets/:id/approve` refuses a `fail`, so a set reaching for `loadstring` cannot be
applied at all. `packages/daemon/test/server.test.ts` pins that end to end.

Three things are still open, and they are what keeps M10 marked `PART`:

- **Its reach ends one hop from the call.** The **nothing** rows in [What it cannot
  see](#what-it-cannot-see) are shapes no rule recognises at all, and each is a one-line rewrite of
  code a rule does catch. Closing them means dataflow, which means a parse, which is the
  third-party-parser decision below — a decision for a human with the release pipeline in front of
  them. Until then this layer's honest claim is bounded by that table, and the human approval gate
  is what the threat model actually rests on. TODO(M10 follow-up).

- **`packages/core` has no adapter for this.** Its `SandboxPort` is the out-of-process seam — a
  parser run over hostile input in its own budget — and with none configured the core still
  returns `warn` with `core/luau-analysis-unavailable`, which is the honest verdict there (M13).
  The shape of `analyse` lines up deliberately with `SandboxPort.analyse` in
  [`packages/core/src/ports/sandbox.ts`](../core/src/ports/sandbox.ts) — a source list, an
  allowed-host list, a three-valued verdict and a truncation flag — so that adapter is a
  translation holding no policy of its own
  ([ADR-009](../../docs/architecture/adr-009-mcp-primary-connector.md)).
- **The `HttpService` allowlist is per daemon, not per project.** `ProjectPolicy` has no field
  for it beside `allowedPathPrefixes`, so it arrives as a `createDaemon` option and as
  `forgebridge daemon --allow-http-host` (TODO(M38) in `packages/daemon/src/server.ts`).

## Working on it

```bash
npm test --workspace @forgebridge/luau-analysis
npm run typecheck --workspace @forgebridge/luau-analysis
```

A new rule needs: an id matching `^[a-z0-9-]+/[a-z0-9-]+$`, an entry in `RULES`, a row in the table
above — the registry test reads this README and fails if an id is missing from it — and both tests,
the one that fires and the one that must not.
