# Generated schemas

DO NOT EDIT ANYTHING IN THIS DIRECTORY. Every file here is written by
`scripts/generate-schemas.ts` from `packages/protocol/src/*.ts`. Regenerate with
`npm run generate:schemas`; `npm run verify:schemas` regenerates into memory and fails
on any difference, so an edit to a Zod schema that was never projected is caught before
it merges.

Editing a file here does not change the protocol. It changes a copy of the protocol,
which is strictly worse than having no copy at all.

## What is here

- `<Name>.schema.json` — one self-contained JSON Schema (draft 2020-12) for each of the 54
  top-level types `@forgebridge/protocol` exports. Each file inlines the definitions it
  references under `$defs`, so a consumer needs exactly one file and no resolver.
- `openapi.json` — one OpenAPI 3.1 document for the `/v1` surface. Its paths are read off
  `packages/daemon/src/server.ts`, which is the implementation, not off the endpoint table
  in `docs/PROTOCOL.md`. Where the two disagree the code wins and the generator says so.
  Its `servers` entry is built the same way: the `port` variable's default is that file's
  exported `DEFAULT_DAEMON_PORT`, imported rather than transcribed, because a URL nobody
  answers on is a worse lie than a missing one.

## What does NOT survive the projection

A Zod `.superRefine()` is arbitrary TypeScript. Some of it has no JSON Schema equivalent,
and the honest response is to name each one rather than let a consumer assume that a
schema-valid document is a protocol-valid document:

- **`WriteScriptOp.source`** — bounded in UTF-8 *bytes* by the Zod schema and in UTF-16 code
  units by `maxLength`. A non-ASCII source between the two bounds is accepted by the JSON
  Schema and refused by the protocol. Nothing in JSON Schema counts bytes, so the schema is
  the looser of the two above the BMP.
- **`ChangeSet`** — carries a cross-operation refinement: a `deleteInstance` on a path an
  earlier operation in the same set also touches is refused, because the ordering is then
  load-bearing in a way no reviewer notices in a diff. JSON Schema has no way to compare two
  elements of the same array, so a set with that shape validates here and is refused by the
  protocol. The Python SDK re-checks it in `forgebridge.checks.check_changeset_ordering`;
  every other consumer of these schemas has to re-check it itself.

Everything else *is* projected, and is checked rather than asserted: each restated
constraint carries probe values that are run through the real Zod schema and through the
emitted JSON Schema, and generation fails if the two ever disagree.

## Consumers

- TypeScript — do not use these files. Import `@forgebridge/protocol` and get the Zod
  schemas themselves; anything else is a copy that can drift.
- Python — `packages/sdk-python` (M08) generates its pydantic v2 models from `openapi.json`
  by the same run of the same generator, so the two cannot disagree.
- Anything else — read `<Name>.schema.json`, and re-implement the unprojected constraints
  listed above yourself.

The endpoint table in `docs/PROTOCOL.md` and the daemon's router currently agree.
