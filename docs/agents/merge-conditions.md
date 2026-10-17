# Merge conditions

A branch merges to `main`, or into a spec's integration branch, only when the gate its change needs is green on the
merge result (the branch rebased on or merged with its target). The one running the merge (implementer, merger
subagent, or maintainer) picks the gate and runs it; a PR description names the gate and states the result.

## Pick the gate

List the changed files on the agent server, then pass the printed paths to the tool as literal arguments (it runs
nothing). Keep the two steps separate: the worktree guard refuses a `git` call nested in `$(...)` inside the rexec
command.

```bash
git diff --name-only --merge-base origin/main
rexec "pnpm test:changed --gate server/src/a.ts web/src/b.tsx"   # the paths printed above
```

It prints `docs` or `standard`, and names any journey foundation the change touches. One moment, not a file, calls
for **full**: the build about to be deployed (`/deploy-intranet`), unless that commit already has a green full run.
Otherwise run e2e only when the maintainer asks for it.

| Gate | What runs on the merge result |
|---|---|
| `docs` | Nothing. Only documentation and agent configuration changed; no test can see it. |
| `standard` | `pnpm typecheck && pnpm test`. |
| `full` | `standard`, plus the whole Playwright suite (`pnpm test:e2e`, both the `mock` and `server` projects). |

A journey foundation is a file every journey rests on: the HTTP contract (`contract/src`), the database schema
(`server/src/db`), the e2e harness (Playwright config, `web/e2e/server/fixture.ts`, `server/src/e2e-main.ts`), or a repository-root
config such as the lockfile. `FULL_GATE` in `tools/test-changed.mjs` is the list. Touching one does not raise a PR's
gate; name it in the PR description so the next full run is read against it.

A change that fixes a red `main` runs `standard` plus the specs that were red (`pnpm test:e2e <spec>...`), not the whole
suite.

GitHub does not enforce CI here (no branch protection on this plan), so the merge command waits for it. Run this as
one background command: `gh pr checks N --watch --fail-fast && gh pr merge N --merge`. After a merge, merge the target
into the next PR's branch and let its CI pass again before merging that PR.

## Why e2e is not on every merge

The full suite takes over 20 minutes on the Mac and is the slowest, most timing-sensitive layer. A behaviour belongs
at the cheapest level that can see it (`docs/agents/coding-standards.md`): taskPolicy rows, the scenario builder,
recognition snapshots and the recorded-ERP executor catch most regressions in seconds. e2e proves that the pieces
still join up, which matters most right before a deploy, when every change since the last one goes out together.

## Keep main green

- When a `full` run finds `main` red, fixing it is the next change to land. Until it lands, only `docs` changes merge.
- When a spec is red because behaviour changed on purpose, update its assertions to the behaviour the governing ADR
  now defines, in the same change. A skipped, `fixme`'d or deleted spec is a red spec.
