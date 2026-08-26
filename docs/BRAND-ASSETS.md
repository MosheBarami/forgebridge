# Brand assets — official only, provenance always

## The rule

> Never generate a logo, icon, wordmark, or product screenshot for a company, model, or
> platform that publishes an official one. Use the official asset, from the official
> source, under its stated terms, with its provenance recorded.

This applies to every provider (OpenAI, Anthropic, Google, Meta, Mistral, xAI, DeepSeek,
Qwen, Moonshot, Z.ai, Tencent, Groq, Together, Cerebras, Ollama, Hugging Face,
OpenRouter …), every agent/IDE (Cursor, Windsurf, Cline, Roo, Kilo, Continue, OpenCode,
GitHub Copilot, ChatGPT, Claude, Codex), and every platform (Roblox, Vercel, Supabase,
Upstash, Sentry, Docker, GitHub).

An AI-drawn approximation of someone's logo is worse than no logo: it is wrong, it is
unlicensed, and it looks like an endorsement.

## Provenance manifest

Every file under `assets/brands/` has an entry. No entry → CI fails → merge blocked.

```jsonc
// assets/brands/manifest.json
{
  "openrouter": {
    "files": ["openrouter/logo.svg", "openrouter/mark.svg"],
    "sourceUrl": "<official brand/press page URL>",
    "retrievedAt": "2026-08-26",
    "sha256": { "openrouter/logo.svg": "…" },
    "licence": "Trademark of OpenRouter, Inc. — used nominatively for identification.",
    "constraints": "No modification of colour or proportion. Not an endorsement.",
    "usage": ["model-selector", "docs"]
  }
}
```

`sourceUrl` is filled by a human from the vendor's own brand/press/media-kit page. The
fetch script **never guesses a URL** — an empty `sourceUrl` is a hard CI failure, not a
prompt to invent one.

## CI gate — `scripts/verify-assets.ts`

Fails the build when any of these is true:

1. A file exists under `assets/brands/` with no manifest entry.
2. A manifest entry has an empty `sourceUrl`, `licence`, or `retrievedAt`.
3. A file's SHA-256 no longer matches the manifest (silent asset swap).
4. A brand asset is referenced from code by a path not listed in that entry's `usage`.
5. Any file under `assets/brands/` was produced by an image-generation tool (checked by an
   explicit `generated: true` flag that a contributor must not set, plus review).

## Licensing boundary

The MIT licence covers **our code**. It does not and cannot cover third-party trademarks.
`LICENSE` is MIT; `NOTICE` enumerates every third-party asset with its terms; the README
states plainly:

> Third-party names and logos are the property of their respective owners and are used
> nominatively to identify the services ForgeBridge connects to. Their inclusion is not an
> endorsement, and they are **not** covered by the MIT licence.

## Icons that are ours

Product iconography that is *not* a third-party mark (UI glyphs, the apple.gg mark,
illustration) is authored by us and MIT-licensed like the rest — with one carve-out: the
**apple.gg name and mark** are reserved (ADR-002), so a fork is a fork, not a look-alike.
