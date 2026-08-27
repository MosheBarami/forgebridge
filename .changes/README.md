# `.changes/` — one file per user-visible change

Add a file here in the pull request that makes the change. The release job folds
them into `CHANGELOG.md` and they are deleted when the version ships.

```
bump: minor

`packages/opencloud` now publishes place versions from the CLI.
```

`bump:` must be `major`, `minor` or `patch`, and there must be prose under it.
An entry with no readable bump is a release blocker rather than a default,
because the default anybody would pick is `patch` and that is exactly how a
breaking change ships as one.

Name the file for what it changes — `opencloud-place-publishing.md` — rather
than for a random word. Two people editing the same area in the same week want
a merge conflict here, not two entries saying the same thing.

## Why this is not called `.changeset/`

Because `ChangeSet` is already the central noun of `packages/protocol`, and
ADR-003 is titled *changeset as unit of work*. It means a set of Roblox instance
operations awaiting approval. A directory of files called changesets that are
release notes, sitting next to a protocol type called `ChangeSet` that is not,
is a collision every future reader would pay for. The flow is the same; the word
is different on purpose.
