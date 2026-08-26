# Threat model

Assets worth protecting, in priority order:

1. **The user's API keys** — a leak costs them real money.
2. **The user's Roblox place** — a bad apply can destroy months of work.
3. **The user's Roblox account** — a hijacked plugin is a hijacked account.
4. **The relay's integrity** — apple.gg must not become a pipe for someone else's malware.
5. **The sponsored-run budget** — the only thing that costs *us* money.

## Trust boundaries

```
 user's machine ┊ our relay (opt-in)  ┊ model provider ┊ Roblox
────────────────┊─────────────────────┊────────────────┊──────────
 daemon, keys,  ┊ v1: authenticated   ┊ untrusted      ┊ external
 keychain,      ┊ TLS, and the        ┊ text generator ┊ authority
 Studio, plugin ┊ operator can read   ┊                ┊
                ┊ ChangeSets (M19)    ┊                ┊
```

Everything crossing a `┊` is validated on arrival. Nothing is trusted because of where it
came from.

The relay column is the one to read carefully, because it is easy to draw wrong. **Relay
v1 is not a blind pipe.** It authenticates and integrity-protects every payload over TLS,
which stops everyone *except* the operator — who can read every ChangeSet that crosses it:
the scripts, the paths, the property values. A relay that cannot, because payloads are
end-to-end encrypted, is **M19** and unbuilt ([ADR-014](architecture/adr-014-staged-pairing-crypto.md)).
The local daemon has no relay at all, which is why it is the default and the recommendation.

## T1 — Key exfiltration

| Vector | Defence |
|---|---|
| Keys stored server-side | There is no column for them. The schema cannot hold one — checked on every commit by `scripts/verify-no-key-storage.ts` rules K1 (no persisted shape declares a credential-shaped field) and K4 (no shape the daemon persists holds a provider key). |
| Browser sends key to our API | Browser BYOK routes through the **local daemon**, never our origin — the daemon is the only egress that ever holds a user key (ADR-006). Checked today by `scripts/verify-no-key-storage.ts` rule K3, which fails the build if a credential-shaped value is passed to a disk, database, **response**, log or telemetry call anywhere under `packages/`. That is a static read of call sites, not an observed request. The CSP `connect-src` that excludes our own API for key-bearing calls is design, not code: `apps/web` is not in this tree yet (M32–M39). The runtime assertion — a request captured on the wire and shown to carry no key-shaped string — is owed (M43). |
| Key in `localStorage` readable by XSS | **Design, unbuilt (M32–M39).** There is no browser client in this repository — `apps/` does not exist — so no key is stored in a browser today. When it lands: browser keys are to be WebCrypto **non-extractable** where the provider allows it, otherwise an AES-GCM blob in IndexedDB whose wrapping key is non-extractable, so that XSS can *use* a key in-session but cannot *read* one out. |
| Key in a log or trace | Two halves, one of which exists. **Today**: K3 again, statically — every log and telemetry call under `packages/` is inspected and a credential-shaped argument fails the build. **Not today**: `TelemetryPort` requires every adapter to run attributes, events and exceptions through a shared redactor, and that redactor is not written — `TODO(M44)` says so in `packages/core/src/ports/telemetry.ts`, alongside the test that feeds known key formats through every log path. A static check that nothing credential-*shaped* is passed to a logger is not a demonstration that a redactor scrubs one that is (M44). |
| Key in a crash report | **Design, unbuilt (M44).** No telemetry adapter exists — only the `TelemetryPort` interface, which every core call site takes as optional so that "off by default" is structural rather than a flag (ADR-011). When adapters land, the Sentry one runs `beforeSend` scrubbing and self-hosters get OTel behind the same redactor. |

The gate those rows lean on prints its own limits on every run, and they bound what this
table may claim: it does not cover `plugin/` (Luau), `scripts/`, **runtime behaviour**,
adapters not yet written, or any credential carried in a blandly named `string`. So what
T1 has today is a set of *shape* claims, and they are real ones: no persisted shape
declares a credential field, no `StoragePort` method carries one, and no call site under
`packages/` hands one to a disk, database, response, log or telemetry sink. What it does
not have is a single assertion about a running process. Those are owed under **M43** (the
threat model's claims backed by tests) and **M44** (the redactor and the log-path test).
Run `npm run verify:no-key-storage` and read its summary rather than taking this
paragraph's word for it.

## T2 — Destructive or malicious ChangeSet

The model is an untrusted caller. Layered defence:

1. **Schema** — Zod rejects anything not in the protocol.
2. **Static analysis.** `packages/luau-analysis` reads every Luau source a ChangeSet
   carries and returns a three-valued verdict, and `packages/daemon` runs it at submit
   time, inside the trust boundary, overwriting whatever `validation` the producer sent.
   The rules standing today are `loadstring`, `getfenv`/`setfenv`, `while true` with no
   yield, an unbounded `Heartbeat` loop, `require` of an unreviewed asset id, `HttpService`
   calls to non-allowlisted hosts, a `RemoteEvent` handler with no argument validation, and
   the deprecated `wait`/`spawn` globals. A `fail` verdict is a gate, not a note: the
   daemon's approve endpoint refuses it, so a set carrying a `loadstring` cannot be applied
   at all.

   Two limits, because a layer whose reach is unstated is a layer people over-trust.
   **This is a recogniser over a token stream, not a Luau compiler** — it reads what a
   script says, not what it computes, so an obfuscated payload assembled at runtime is
   outside what it can see, and layers 3–5 are what cover that. And a source it could not
   read — a tokenizer error, blocks that do not balance, a rule that threw, a budget that
   ran out, a `Source` property holding something that is not a string — comes back `fail`,
   never `ok`; the analyser never reports a pass for a check that did not run. `packages/core`
   still calls a `SandboxPort` for the out-of-process case and, with no sandbox configured,
   returns `warn` with `core/luau-analysis-unavailable` rather than `ok` (M13). The Studio
   plugin sends every ChangeSet carrying Luau source to a human regardless of what verdict
   arrived with it.
3. **Policy** — path allowlist per project; a ChangeSet may not touch outside it.
   Deletion of more than N instances requires explicit confirmation regardless of policy.
4. **Human approval** — default ON. Auto-apply is opt-in, per project, scoped to a path
   prefix, and never covers `deleteInstance`.
5. **Journal + rollback** — the plugin captures the inverse of every operation *before* it
   runs, and every apply is one `ChangeHistoryService` recording, so <kbd>Ctrl</kbd>+<kbd>Z</kbd>
   takes a whole ChangeSet back; an apply Studio will not let it record is refused outright.
   This is the real safety net, and the others reduce how often it is needed rather than
   replacing it. One limit, stated because a safety net nobody has measured is not one:
   the inverses live in the Studio session that applied the change, because `ApplyResult`
   has nowhere on the wire to carry them (TODO(M11) in `plugin/src/Journal.luau`).
   Cross-session rollback is **M11**.

## T3 — Prompt injection

Assumed present in every retrieved artefact: Roblox docs pulled into context, community
inventory cards, output from another agent over A2A, and the contents of the user's own
place (a script comment can say "ignore your instructions").

- Retrieved content enters the prompt inside a delimited, labelled block marked as data.
  **Unbuilt (M22).** Prompt assembly lives in a provider adapter, behind the `ModelClient`
  seam in `packages/core/src/pipeline.ts`, and no adapter package exists yet. It is also
  the weakest of these three by design: a delimiter is a convention the model may ignore,
  which is why nothing rests on it and the next two bullets do the actual work.
- **The scope of a ChangeSet is fixed before generation**, from the user's request and the
  project policy. No retrieved text can widen it: an injected "also write to
  ServerScriptService.Admin" fails the policy check regardless of how convincing it was.
  This one holds today — `checkPolicy` in `packages/core/src/policy.ts` runs against the
  project's stored path allowlist, inside the trust boundary, and the daemon calls it on
  every ChangeSet it validates.
- Producers cannot self-approve. Proposing and applying are separate calls with an approval
  in between; the daemon enforces the split at its endpoints, and the plugin re-decides
  approval on arrival rather than trusting the verdict that came with the set. `packages/mcp`
  spells it out as two distinct tools, `forge.propose_changeset` and `forge.apply_changeset`,
  neither of which can approve; `packages/a2a` refuses an apply that carries no human grant.

## T4 — Pairing and relay attacks

| Attack | Defence |
|---|---|
| Pairing-code brute force | 8 chars from an unambiguous alphabet, 10-minute TTL, 5 attempts per code, per-IP throttle, single-use |
| Code shoulder-surfed / pasted in a stream | Short TTL + single-use + a "new device paired" notice on the project |
| Relay operator reads ChangeSets | v1: they can (TLS only) — **stated plainly, in the protocol's own words**: the plugin panel shows `PRIVACY_POSTURE` from `packages/protocol/src/link.ts` verbatim, "Relay — the relay operator can read your changes", and there is no padlock icon anywhere. v2: E2E payload encryption makes the relay blind (M19, ADR-014). Local daemon: no relay exists. |
| Replay of a captured ChangeSet | Per-link monotonic nonce + `baseVersion` check; a replayed set is stale by construction |
| Malicious relay pushes its own ChangeSet | Payload MAC under the pairing-derived session key — HMAC-SHA256 over link id, nonce and body (`packages/daemon/src/envelope.ts`). The plugin cannot yet *verify* one: Luau has no crypto standard library and the HMAC is TODO(M18) in `plugin/src/Transport.luau`. So it refuses relay deliveries outright rather than applying something it cannot authenticate — the defence holds today by refusing, and becomes a verification at M18 |
| Someone else's link id guessed | Link ids are 128-bit random; poll requires the session key, not just the id |

## T5 — Abuse of the sponsored run

1 free server-side run per day per verified user is a standing invitation to farm it.

**Everything in this section is design for M45, and none of it is built.** The sponsored
run does not exist, and neither does anything below that would bound it: there is no
counter, no Redis client, no rate-limiting middleware and no OAuth verification anywhere in
this tree. M45 is status NEW in [`MILESTONES.md`](MILESTONES.md) and its definition of done
is that these limits are *provable by test* (ADR-010) — so this list is the specification
that test will be written against, not a description of a defence in place.

- **Verification**: Roblox OAuth with an account-age floor — a fresh account cannot claim.
- **Counters**: date-keyed in Redis, per user *and* per IP *and* per ASN, all three
  required to pass.
- **Budget circuit-breaker**: a daily global ceiling; when hit, the UI says the sponsored
  budget is spent for the day and points to BYOK/local. It never queues silently.
- **No amplification**: sponsored runs are capped in tokens and tool-calls, and cannot
  target the relay's own infrastructure.

## T6 — Supply chain

Being a popular open-source bridge that people run locally makes us a target.

**What runs today.** The lockfile is committed and CI installs with `npm ci`
(`.github/workflows/ci.yml`). `scripts/verify-no-secrets.ts` (`npm run verify:no-secrets`)
runs on every commit, including the first, and fails the build on a credential-shaped
literal, a credential-named assignment with a real-looking value, a machine-local absolute
path, or a committed `.env` file. Dependency additions to `packages/protocol` (zero-dep by
rule) and `plugin/` require BDFL review — a rule, enforced by review rather than by a job.

**What does not run yet, and what it is waiting on.** `.github/workflows/` contains
`ci.yml`, `catalog-drift.yml` and `dco.yml`, and nothing else — there is no release job:

- **SBOM per release** — M42, and it needs the release pipeline in M49 to have somewhere to
  publish to.
- **`gitleaks` over git history** — M42. `verify-no-secrets` reads the *working tree* only
  and says so in its summary; a secret committed and removed in the next commit would slip
  it. Blocked on a pinned action version and its provenance, which a human must choose
  ([ADR-013](architecture/adr-013-fresh-public-repo.md)).
- **Semgrep and CodeQL** — M42. No SAST runs in this repository.
- **Provenance-attested publishes, and the plugin `.rbxm` checksum in the release notes** —
  M49. Nothing is published yet, so there are no release notes to put it in. It matters when
  it lands: a plugin is code running inside Studio with the user's session.

## What we explicitly do not defend against

Stated so nobody is surprised:

- A compromised user machine. If malware owns the OS, it owns the keychain and the daemon.
- A malicious model provider returning subtly wrong Luau. Static analysis catches classes of
  error, not intent: T2 layer 2 recognises `loadstring` and seven other patterns, and has
  nothing to say about a script that does exactly what it appears to do and is wrong.
  Review your diffs. That is still the control, not advice.
- Roblox platform-side moderation decisions about generated content. That is the user's
  responsibility and the ToS is theirs to keep.
