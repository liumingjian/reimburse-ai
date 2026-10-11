# Merge conditions

A branch merges to `main`, or into a spec's integration branch, only when the gate its change needs is green on the
merge result (the branch rebased on or merged with its target). The one running the merge (implementer, merger
subagent, or maintainer) picks the gate and runs it; a PR description names the gate and states the result.

## Pick the gate

Compute the changed files on the agent server and let the tool classify them (it runs nothing):

```bash
rexec "pnpm test:changed --gate $(git diff --name-only $(git merge-base HEAD origin/main))"
```

It prints `docs`, `standard` or `full`. Three moments raise any change to **full**, whatever its files:

- a spec's integration branch merging into `main` (a feature or major change landing as a whole);
- the build about to be deployed (`/deploy-intranet`);
- a change that fixes a red `main`.

| Gate | What runs on the merge result |
|---|---|
| `docs` | Nothing. Only documentation and agent configuration changed; no test can see it. |
| `standard` | `pnpm typecheck && pnpm test`, plus `pnpm test:changed` on the changed files with every e2e spec it selects. When non-test code under `server/src` changed, also name the server journey specs for that area (`pnpm test:e2e e2e/server/hotel.spec.ts`): they drive the built server, so no import edge selects them. |
| `full` | `standard`, plus the whole Playwright suite (`pnpm test:e2e`, both the `mock` and `server` projects). |

`full` from the files means the change touched what every journey rests on: the HTTP contract (`contract/src`), the
database schema (`server/src/db`), the e2e harness (Playwright config, `e2e/server/fixture.ts`, `e2e-main.ts`), or a
repository-root config such as the lockfile. `FULL_GATE` in `tools/test-changed.mjs` is the list.

## Why e2e is not on every merge

The full suite takes over 20 minutes on the Mac and is the slowest, most timing-sensitive layer. A behaviour belongs
at the cheapest level that can see it (`docs/agents/coding-standards.md`): taskPolicy rows, the scenario builder,
recognition snapshots and the recorded-ERP executor catch most regressions in seconds. e2e proves that the pieces
still join up, which only changes where pieces join or many changes converge: the `full` triggers above.

## Keep main green

- When a `full` run finds `main` red, fixing it is the next change to land. Until it lands, only `docs` changes merge.
- When a spec is red because behaviour changed on purpose, update its assertions to the behaviour the governing ADR
  now defines, in the same change. A skipped, `fixme`'d or deleted spec is a red spec.
