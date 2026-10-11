# baox verification map

The maintained source for verifying what an employee sees in the 本地报销应用. Read this index before driving the app,
then use the matching feature file as the recipe. Terms are the ones in `GLOSSARY.md`.

## Baseline preconditions

- Every run boots its own server through `.claude/skills/verify/verify.sh run <scenario>` on the Mac (via rexec).
  It uses `server/dist/e2e-main.mjs`, `BAOX_PORT=0`, a fresh temp `BAOX_DATA_DIR`, `BAOX_ERP_CHROMIUM=off`, and the
  ERP double the scenario names in `export const fake`.
- `verify.sh doctor` is green: pnpm's node 24, Google Chrome, dependencies, build.
- The data directory starts empty: the first page is 创建管理员. `v.signIn()` creates `admin` through the API.
- Never drive `~/.baox-qa` or a `qa/dev.sh` instance: those hold the maintainer's own tasks.

## Driving conventions

- Prefer ARIA roles and accessible names (`getByRole('button', { name: '去报销', exact: true })`), then labels, then
  `data-testid`. No CSS paths, no coordinates.
- Drive the feature under test through the page. Earlier stages may be set up through the API with
  `v.confirmedTask()`; the scenario's header says so.
- Wait on server state with `expect.poll(() => v.api.snapshot(id))`, not on sleeps. Recognition (OCR) runs for real
  and takes seconds to a minute on the Mac.

## Proof and skip reporting

- Each proof is a pair: a `v.shot` after the user action and a `v.record` of the server snapshot. Assert the
  snapshot's `stage`, `step.kind`, `erp`, `reconcile`.
- The transcript's first line names the ERP double. A PASS against a double proves the app's handling of that ERP
  behaviour, never the real ERP (`pnpm test:erp-live` does that).
- Production 去报销 runs in the paired browser extension. This harness drives the CDP executor's seam instead. Say so
  when a change touches the extension transport, and point at `server/src/erp-remote-executor.test.ts`.
- Report an entry point you did not drive as not verified. Don't count it as covered by another path.

## Feature entry contract

Each feature file has an H1 title and one paragraph of user-visible behaviour, then four H2s in order:
`Sub-features`, `How to get to it (user POV)`, `Driving it with verify.sh`, `Gotchas`.

## Features

- [Accounts and sign-in](./accounts.md): 创建管理员, registration, approval, sign-in refusals. No scenario yet.
- [New task, upload and 盘点](./new-task-upload.md): scenario `new-task-upload`.
- [项目归属 and 整单确认](./project-review.md): no scenario yet; `v.confirmedTask()` covers it through the API only.
- [去报销](./go-erp.md): scenario `login-wall`; `--fake catalog_mismatch` and the no-browser path are mapped.
- [对账 and 转人工](./reconcile.md): scenario `reconcile-uncertain`.
