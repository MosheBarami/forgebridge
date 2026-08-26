# Building the plugin

The plugin is plain Luau in a Rojo-compatible layout. `src/init.server.luau` is the
plugin script; every sibling module becomes one of its children, which is why the
requires in `init.server.luau` read `require(script.Transport)`.

```
rojo build --output ForgeBridge.rbxm
```

Rojo's version is pinned in `aftman.toml` at the repository root; `aftman install`
puts that version on the path. A `.rbxm` that differs by builder is a plugin nobody
can reproduce, and this is code that runs inside Studio with the user's session.

`default.project.json` maps `src/` onto a single `Script` named `ForgeBridge`, so the
built `.rbxm` is one plugin object with its modules inside it. Nothing else is needed
at build time — the plugin has no dependencies, no bundler and no codegen step.

## Checks that should pass before a release

```
luau tests/run.luau                                      # unit tests, no Studio required
for f in src/*.luau; do luau-compile --null "$f"; done   # everything parses
luau-lsp analyze src/*.luau tests/*.luau                 # unknown-global noise only, without Roblox defs
```

There is no formatter config here on purpose. Several tables are grouped by hand because
the grouping carries meaning — the CFrame rotation in `Value.luau` is laid out as the 3×3
matrix it is, and a formatter that puts one component per line makes a transposition
impossible to spot in review.

## What release engineering still owns

- **`Config.PLUGIN_VERSION`** is stamped by hand today. The release job should rewrite
  that line so a shipped `.rbxm` reports the build it actually is — TODO(M49).
- **The toolbar icon asset id** in `init.server.luau` is an empty string, because an
  asset id cannot exist before the icon is uploaded — TODO(M49).
- **The checksum.** `THREAT-MODEL.md` T6 requires the `.rbxm` to be checksummed and the
  checksum published in the release notes. A plugin runs inside Studio with the user's
  session, so this is not optional.
