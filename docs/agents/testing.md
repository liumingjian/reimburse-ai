# Testing: inner loop and full gate

Two commands, for two moments. Both run on the Mac through `rexec`, from the repo (or worktree) root.

## Inner loop: `pnpm test:changed <file>...`

Run after every edit. It runs only the tests related to the files you pass
(`tools/test-changed.mjs`):

- vitest `related` in each workspace package that owns a changed file or depends on one. A change to a package's own
  config (`package.json`, `tsconfig*.json`, `vite(st).config.*`) runs that package's whole suite.
- Playwright on the `web/e2e` specs whose imports reach a changed file (a changed spec, `e2e/server/fixture.ts`,
  `@baox/contract`, …), after building only what those specs need.
- A changed repository-root file (`pnpm-lock.yaml`, `pnpm-workspace.yaml`, root `package.json`/`tsconfig*.json`,
  `.oxlintrc.json`, `.npmrc`, …) runs every package's whole suite and every e2e spec. Root docs (`*.md`) and files
  outside every package (`docs/`, `qa/`, `tools/`) select nothing: they are listed as "not covered", and a run that
  selected nothing ends in `NOTHING RUN`, not `PASS`.

Compute the file list on the agent server, where git works, and pass it in. The Mac workspace has no usable history:
`.git` is not synced by default, and a worktree's `.git` file points at a path that exists only on the server, so
`--base <ref>` and Playwright's own `--only-changed` fail there.

```bash
rexec "set -o pipefail; pnpm test:changed $(git diff --name-only $(git merge-base HEAD origin/main); git ls-files -o --exclude-standard) 2>&1 | tail -40"
```

The `$(...)` expands on the server before rexec sends the command. Flags: `--no-e2e`, `--no-build` (reuse the existing
`server/dist`, `web/dist`, `web/dist-mock`), `--dry-run` (print what would run).

Its reach is the module graph: a spec that drives the built app without importing the changed file is not selected, and
neither is a test that reads a data file (a PDF fixture) without importing it. When the change is covered by a journey,
name the spec: `pnpm test:e2e e2e/server/erp.spec.ts` (building takes most of that run).

## Merge gate: before merge

Once, when the change is done, run the gate `docs/agents/merge-conditions.md` picks for it. Submit with `--background`
and collect the result later; the whole e2e suite takes over 20 minutes.

```bash
rexec --background 'set -o pipefail; pnpm typecheck && pnpm test 2>&1 | tail -40'
rexec --background --timeout 3600 'set -o pipefail; pnpm test:e2e 2>&1 | tail -40'   # full gate only
```

The Mac is shared with the maintainer's desktop apps, and the web, extension and e2e suites have timing-sensitive
tests: on a loaded Mac they fail by the dozen while the code is fine. Before a merge gate, read the load with
`rexec --no-sync uptime`; when the 1-minute average is above 4, wait for it to drop rather than reading a red run as
a red `main`. The web suite already waits up to 5 s per `findBy*`/`waitFor` (`web/src/test/setup.ts`).

`pnpm test` is lint plus every package's unit suite, packages in parallel. Server tests that run the real OCR are the
`server-ocr` vitest project (`server/vitest.config.ts`), one file at a time, so they cannot starve the web suite's
timing tests; a new server test that parses an image for real goes on its `OCR_TESTS` list.

rexec's sync refuses configuration files, so a rexec workspace has no `.npmrc`. Without its `use-node-version`, pnpm
runs the Mac's bare Node 22 instead of Node 24, and under load the ERP and OCR server tests then fail spuriously. Put
the file back at the start of every rexec command that runs pnpm (keep it in step with `/.npmrc`):

```bash
rexec --background "printf 'save-exact=true\nuse-node-version=24.21.0\nnode-mirror:release=https://npmmirror.com/mirrors/node/\n' > .npmrc; pnpm install --frozen-lockfile --prefer-offline --reporter=silent && pnpm typecheck && pnpm test 2>&1 | tail -40"
```

Every rexec job also starts from a fresh workspace with no `node_modules`, so install first as above.

`deploy/operator`'s `src/source.test.ts` archives the committed repository, so it needs a real git checkout: it fails
in a rexec workspace synced from a worktree.
