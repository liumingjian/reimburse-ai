---
name: verify
description: Drive the baox reimbursement app (本地报销应用) the way an employee does — web UI on the real built server, ERP 去报销 against scripted ERP doubles — and capture evidence. Use to prove a change to a user-facing flow (新建任务, 上传, 盘点, 项目归属, 整单确认, 去报销, 对账) works end to end, or when asked to verify, QA or reproduce app behaviour.
---

# verify

Proves app behaviour by driving the real built server in headless Chrome, one throwaway instance per run. Everything
runs on the Mac through the `rexec` skill (this server is too small to build or browse), from the repo or worktree root.

## What it drives, and what it cannot

- **Surface:** the web UI (`web/`) served same-origin by the server (`server/src/run.ts`), plus its HTTP API.
- **Server:** `server/dist/e2e-main.mjs`, the production server plus scripted ERP doubles picked by `BAOX_ERP_FAKE`:
  `login_wall`, `uncertain_save`, `catalog_mismatch` (`server/src/e2e-main.ts`). Without a fake, ERP jobs go to the
  CDP executor with `BAOX_ERP_CHROMIUM=off`, so 去报销 finds no browser and stops before any attempt.
- **Not here:**
  - The real ERP (金蝶 K3Cloud): `pnpm test:erp-live`, which needs the maintainer's ERP session.
  - The browser extension transport (production 去报销): `server/src/erp-remote-executor.test.ts`.
  - The maintainer's long-lived QA instance: `qa/dev.sh` and `qa/run.mjs`, which use `~/.baox-qa`. Never point this
    skill at them.

## Launch

```bash
rexec --background --timeout 1500 '.claude/skills/verify/verify.sh run login-wall'   # installs, builds, boots, drives, tears down
rexec --background --timeout 1800 '.claude/skills/verify/verify.sh run login-wall && .claude/skills/verify/verify.sh run reconcile-uncertain --no-build'
rexec --background --timeout 1500 '.claude/skills/verify/verify.sh run login-wall --fake catalog_mismatch'   # override the fake
```

- `run` installs and builds first: `pnpm install --frozen-lockfile`, then
  `BAOX_BUILD_E2E=1 pnpm --filter @baox/server --filter @baox/web build`. Together they take about 5 minutes on an idle
  Mac. The build log goes to `~/.baox-verify/last-build.log`.
- Every rexec job gets a fresh workspace with no `node_modules` and no build. So `--no-build` only helps for a second
  scenario chained in the same rexec command, as above.
- `drive.mjs` spawns the server on `BAOX_PORT=0` with a fresh `mkdtemp` data directory and `BAOX_HOME` pointed at
  nothing. It is ready when the server prints `listening on http://...`; the URL comes from that line.
- **Isolation:** port 0 and a temp data directory mean runs never share state.
  - Two runs may go side by side, but never two *builds* in one workspace: start the second with `--no-build` after the
    first has built.
  - Scenarios are the files in `scenarios/`, named without `.mjs`.

Submit with `--background` for anything that builds, then `rexec wait JOB` (see the user's long-rexec-jobs memory: say
how long it takes and don't block on it).

## Doctor

```bash
rexec --timeout 120 '.claude/skills/verify/verify.sh doctor'
```

Read-only. It checks four things: node 24 and pnpm, Google Chrome installed (`channel: 'chrome'`, as in
`web/playwright.config.ts`), `node_modules`, and the built `server/dist/e2e-main.mjs` plus `web/dist`. It also warns
about verify servers still alive from a killed run. Run it first whenever a run fails before its first `step`.

## Drive

`drive.mjs` runs one scenario: `export const fake = 'login_wall' | 'uncertain_save' | 'catalog_mismatch' | null`, and
`export default async (v) => {...}`. The kit `v`:

| member | what it does |
|---|---|
| `v.page`, `v.expect` | the Playwright page (`baseURL` = the server) and `expect` from `@playwright/test` |
| `v.step(label, fn)` | runs `fn`, writes `step label` to the transcript; name what the user does |
| `v.shot(label)` | full-page screenshot into the evidence directory |
| `v.record(label, taskId)` | saves `GET /api/tasks/:id` as `snapshot-<label>.json`: the server's state, not the screen's |
| `v.signIn()` | creates the first administrator through `/api/auth/setup`; the page's context is signed in |
| `v.confirmedTask()` | API setup to `stage: actions / choose_action`: m01+m02 hotel PDFs, 盘点 done, 住宿 trio answered 确认没有, all lines on P-2307 |
| `v.api.get/post/snapshot/act` | the HTTP API with the page's cookies; `act(snapshot, 'confirm-review', body)` adds the step token |
| `v.fixture(file)` | a path in `fixtures/generated/` (committed synthetic materials m01–m16) |
| `v.note(text)` | a free line in the transcript |

**Stable handles** used by the shipped scenarios (taken from `web/e2e/server/*.spec.ts`):

- **Buttons:** `getByRole('button', { name: '去报销', exact: true })`, `'新建报销任务'`, `'创建并上传材料'`,
  `'开始材料盘点'`, `'取消去报销'`.
- **Dialogs and regions:** `getByRole('dialog', { name: '新建报销任务' })`, `getByRole('region', { name: '处置' })`.
- **Form fields:** `getByLabel('常驻城市')`, `getByLabel('拖入文件，或点击选择', { exact: true })`.
- **Test ids:** `getByTestId('reconcile-bucket' | 'reconcile-status' | 'erp-text' | 'review-purpose')`.

Routes are hash routes: `/#/tasks`, `/#/task/<id>/{upload,review,erp,reconcile,project}`, `/#/settings`, `/#/admin`.

**Writing a scenario:**
- Drive the feature under test through the page.
- Earlier stages may be set up through the API (`v.confirmedTask()`); say so in the scenario's header comment.
- New scenarios go in `scenarios/`, and the feature map below gets a line.

## Evidence

Each run writes `~/.baox-verify/<UTC-stamp>-<scenario>/` on the Mac:

- `transcript.txt`: every step, state line, 5xx response and page error, then `PASS <scenario>` or `FAIL <scenario>`;
- `snapshot-*.json`: the task as the server holds it after each recorded point;
- `NN-<label>.png` and `failure.png`: screenshots;
- `server.log`: the server's own output.

The exit status is 0 for PASS and 1 for FAIL.

rexec exports only text, and it refuses the whole set when one file looks like it holds a credential. Snapshots carry
step tokens and digests, so `drive.mjs` publishes only three files to `$REXEC_ARTIFACTS/verify/<run>/`:
`transcript.txt`, `server-tail.txt` (the last 200 lines) and `kept-on-mac.txt` (the paths of the PNGs and snapshots).
On FAIL the stdout also ends with the server log's last 80 lines. Collect the files with:

```bash
rexec artifacts JOB --into "$CLAUDE_JOB_DIR/tmp/verify"
```

The PNGs and snapshots stay on the Mac. Read a snapshot with
`rexec --no-sync 'cat ~/.baox-verify/<run>/snapshot-<label>.json | head -c 4000'`, and name the PNG paths when
reporting so the maintainer can open them there.

**Proof standards:**

- **Real path.** Exercise the real user path: the button the employee clicks, not a test-only endpoint.
- **Action and result.** Capture the action and the resulting state: a `v.shot` after the click *and* a `v.record` of
  the server snapshot.
- **Side effects.** An ERP outcome is proved by the snapshot's `erp` / `reconcile` / `stage`, not by the page text
  alone.
- **Doubles.** Only the ERP is doubled, at the seam that already isolates it in production (the fill and reconcile
  executors). The fakes write nothing anywhere; a fake-ERP PASS says nothing about the real ERP. Say which fake ran;
  the transcript's first line names it.

## Cleanup

`drive.mjs` tears down what it started, on PASS, FAIL, SIGTERM (rexec's deadline) and SIGINT. It kills its own server
child and removes the temp data directory. The evidence directory is never removed.

If a run was killed hard (`kill -9`, the Mac rebooted), a `server.pid` stays in its evidence directory:

```bash
rexec '.claude/skills/verify/verify.sh clean'   # stops only pids from server.pid whose command is e2e-main.mjs
```

Never kill by process name: the maintainer's `qa/dev.sh` instance and e2e runs use node and Chrome too.

## Feature map

`features/README.md` indexes the user-facing features with how to reach, drive and prove each. A proof that covers one
entry point of a feature whose map lists several is incomplete: drive the others or say which were left out.
