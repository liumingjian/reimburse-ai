# Testing: inner loop and full gate

Two commands, for two moments. Both run on the Mac through `rexec`, from the repo (or worktree) root.

## Inner loop: `pnpm test:changed <file>...`

Run after every edit. It runs only the tests related to the files you pass
(`tools/test-changed.mjs`):

- vitest `related` in each workspace package that owns a changed file or depends on one. A change to a package's own
  config (`package.json`, `tsconfig*.json`, `vite(st).config.*`) runs that package's whole suite.
- Playwright only when you changed something under `web/e2e` (a spec, `web/e2e/server/fixture.ts`): the specs whose
  imports reach the changed files, after building only what those specs need. Any other change prints the specs it
  reaches and leaves them to the full gate; `--e2e` runs them when a journey is what you are actually fixing.
- A changed repository-root file (`pnpm-lock.yaml`, `pnpm-workspace.yaml`, root `package.json`/`tsconfig*.json`,
  `.oxlintrc.json`, `.npmrc`, …) runs every package's whole suite. Root docs (`*.md`) and files outside every package
  (`docs/`, `qa/`, `tools/`) select nothing: they are listed as "not covered", and a run that selected nothing ends in
  `NOTHING RUN`, not `PASS`.

Pass the files changed since your last green run, usually the uncommitted ones. The branch's whole diff against
`origin/main` is for the merge gate: in the inner loop it re-runs every earlier edit's tests on each iteration. Compute
the list on the agent server, where git works. The Mac workspace has no usable history: `.git` is not synced by
default, and a worktree's `.git` file points at a path that exists only on the server, so `--base <ref>` and
Playwright's own `--only-changed` fail there.

List them first, then paste the printed paths into the rexec command as literal arguments. A `git` call nested in
`$(...)` inside the rexec command is refused by the worktree guard.

```bash
git diff --name-only HEAD; git ls-files -o --exclude-standard
rexec "set -o pipefail; pnpm install --frozen-lockfile --prefer-offline --reporter=silent && pnpm test:changed server/src/a.ts web/src/b.tsx 2>&1 | tail -40"
```

Flags: `--e2e`, `--no-e2e`, `--no-build` (reuse the
existing `server/dist`, `web/dist`, `web/dist-mock`), `--dry-run` (print what would run).

Its reach is the module graph: a spec that drives the built app without importing the changed file is not selected, and
neither is a test that reads a data file (a PDF fixture) without importing it. When you are fixing a journey, name its
spec: `pnpm test:e2e e2e/server/erp.spec.ts` (building takes most of that run).

## Merge gate: before merge

Once, when the change is done, run the gate `docs/agents/merge-conditions.md` picks for it. Submit with `--background`
and collect the result later; the whole e2e suite (full gate only) takes over 20 minutes.

```bash
rexec --background 'set -o pipefail; pnpm install --frozen-lockfile --prefer-offline --reporter=silent && pnpm typecheck && pnpm test 2>&1 | tail -40'
rexec --background --timeout 3600 'set -o pipefail; pnpm install --frozen-lockfile --prefer-offline --reporter=silent && pnpm test:e2e 2>&1 | tail -40'   # full gate only
```

The Mac is shared with the maintainer's desktop apps, and the web, extension and e2e suites have timing-sensitive
tests: on a busy Mac they fail by the dozen while the code is fine. The Mac mini has 12 cores and 64 GB, so a load
average of 5 to 15 is normal: judge "busy" by CPU use (`rexec --no-sync 'top -l 2 -o cpu -n 10'`), never by load
average. Before calling a red file noise, rerun that file alone, on the branch and on an `origin/main` snapshot; the
same failure on both is a flaky test, not load. The web suite already waits up to 5 s per `findBy*`/`waitFor` (`web/src/test/setup.ts`), and the
web suite and Playwright cap their own parallelism (`maxWorkers` in `web/vite.config.ts`, `workers` in
`web/playwright.config.ts`, one at a time for the server specs) so they don't load the Mac by themselves.

`pnpm test` is lint plus every package's unit suite, packages in parallel. Server tests that run the real OCR are the
`server-ocr` vitest project (`server/vitest.config.ts`), one file at a time, so they cannot starve the web suite's
timing tests; a new server test that parses an image for real goes on its `OCR_TESTS` list.

Every rexec job runs in a workspace of its own. rexec syncs `/.npmrc`, so pnpm runs Node 24 through its
`use-node-version`; it gives each job a short `TMPDIR`, so the maintenance socket stays within the 104-byte Unix socket
limit; and it starts the job with the `node_modules` of the last successful job from the same worktree, so the install
only reconciles against the lockfile. Install first, as above.

`deploy/operator`'s `src/source.test.ts` archives the committed repository, so it needs a real git checkout: it fails
in a rexec workspace synced from a worktree. Those two tests are the only red a `pnpm test` on an idle Mac should show.

GitHub CI (`.github/workflows/ci.yml`) runs neither `@baox/operator` nor the `server-ocr` project, so a green CI says
nothing about them: the Mac's `pnpm test` is their only run. When the Mac is red and CI is green, read the red file
first; it may be one CI never ran.
