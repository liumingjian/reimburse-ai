---
name: deploy-intranet
description: Deploy a pushed commit to the intranet host 10.250.0.222 (QA/POC) for manual QA. Usage: /deploy-intranet [Git ref]
disable-model-invocation: true
---

The user wants a commit on the 内网主机 (intranet host) `10.250.0.222` for manual QA. This skill is a thin wrapper:
`pnpm --filter @baox/operator operator deploy` (`deploy/operator/src/cli.ts`) already locks the source archive,
builds a candidate on the host, takes a recovery snapshot, switches behind the maintenance gate, and restores the
previous release on a failed switch. Your job is choosing the commit, reading the operator's verdict, and reporting.
The procedure and host layout live in `docs/deployment/intranet-phase-1.md`.

The host holds made-up data only (ADR-0022); it is not production.

## Where operator commands run

Run every `operator` command on the maintainer's mac: it holds the VPN route and the `root@10.250.0.222` SSH key.
The operator reads git history (`git archive`, `git rev-parse`), so the mac's copy of this checkout must include `.git`.
From a linked worktree, `rexec --with-git` gives no usable git root (the worktree's `.git` is a file pointing at a
server path). Clone instead, into your job's tmp directory, and sync the clone; write its path out literally in the
rexec call. The operator never reads the clone's remote, so leave `origin` as the clone sets it.

```bash
git clone -q --no-hardlinks /home/agent/repos/reimburse-ai <job tmp>/deploy-src
git -C <job tmp>/deploy-src checkout -q <sha>
rexec --with-git --sync <job tmp>/deploy-src --label deploy 'pnpm install --frozen-lockfile && pnpm --filter @baox/operator operator status --json'
```

If `node_modules` is missing there, run `pnpm install --frozen-lockfile` first. Append `--json` to any operator
command when you need to parse its result.

## Steps

### 1. Lock the commit

- With an argument, resolve it: `git rev-parse --verify '<ref>^{commit}'`.
- Without one, use `HEAD` of the current branch. A detached `HEAD` has no branch to check: stop and ask for an
  explicit ref.

Then `git fetch origin` and require the commit to be **pushed**: `git branch -r --contains <sha>` is non-empty. For
the no-argument case also require the branch to be in step with its upstream (`git rev-list --left-right --count
@{u}...HEAD` prints behind and ahead counts; both must be 0). Ahead or unpushed: stop and tell the user to push; pushing is theirs. Behind: stop and tell
them to pull or name the ref.

List uncommitted changes from `git status --short` as "not part of this deploy"; they do not block.

Done when you hold one full 40-hex SHA that is on `origin`. Pass that SHA, never a branch name, to every later command.

### 2. Preflight

```bash
pnpm --filter @baox/operator operator deploy --dry-run <sha>
pnpm --filter @baox/operator operator status --json
```

A non-zero dry-run is a refusal (gate closed, active ERP action attempt, missing bootstrap, SSH or VPN failure).
Relay the refusal line verbatim and stop.

`status` gives `host.currentRelease`, a path ending in `releases/<commit12>-<archive12>` (older phase-1 releases:
`baox-<commit12>-<suffix>`). The first 12-hex run is the deployed commit. If it equals your SHA's prefix, report
"already deployed" and stop.

Done when the dry-run exits 0 and you know the deployed commit, or know it cannot be resolved locally.

### 3. Impact check

Diff the deployed commit against the target (`git diff <deployed>..<sha> -- <path>`). Each hit becomes a line in the
final report:

| Watch | Hit means |
|---|---|
| `MINIMUM_EXECUTOR_VERSION` raised in `contract/src/channel.ts` | Every installed 本地执行器 older than it is refused until it updates itself (ADR-0035); QA waits until the QA PC's 本地执行器 shows connected on the 设置页. |
| `local-executor/` or `channel/` changed | Installed 本地执行器s replace themselves with the new build at start, every 30 idle minutes, or when refused (ADR-0035); a QA PC runs the old build until then. |
| A new key in the migrations map of `server/src/db/migrations.ts` | Schema migration: rollback to the previous release is unsafe from now on (the database never migrates backwards, and there is no backup). |

Routine releases keep the installed origin, so each 本地执行器's 配对 (pairing) survives; say so only if the user asks.

If the deployed commit is missing from local history, write "impact unknown: deployed commit `<commit12>` not in
local history" and continue.

Done when every row above is checked and recorded as hit or clear.

### 4. Deploy

```bash
pnpm --filter @baox/operator operator deploy <sha> --json
```

The candidate build runs on the host and takes several minutes: dispatch it in the background and collect the result,
rather than holding a foreground call open. Run it exactly once. The same command is also the resume path for an
interrupted switch; that is the operator's decision, never yours to make by re-running.

Done when you hold the command's exit code and its `cutover` (or `candidate`) state.

### 5. Report

Write the report in the user's language.

- **`verified`**: the release name, the recovery snapshot ID, the step-3 impact lines, the excluded working-tree
  changes from step 1, the QA entry `http://10.250.0.222:8888`, and the phase table. Then end with `result:`.
- **Any other state** (`restored`, `busy`, `refused`, `failed`, `recovery-required`, `post-access-handoff`,
  `reconcile-needed`, or a candidate state other than `prepared`): the host is now the user's to decide on. Quote the
  operator's lines verbatim, attach `operator status` and `operator logs --lines 100`, and end with `needs input:`.
  Your part ends at the report: leave retries, `--candidate` reruns, rollback, `snapshot`, gate `admit`/`reopen`
  and `bootstrap-*` to the user.

Put the phase table right before the closing `result:` or `needs input:` line in every report. Build it from the
top-level `phaseTimings` of the deploy JSON: one row per entry in order (`phase`, `durationMs` as seconds with one
decimal, marked failed when `failed` is true, marked "reused" when `reused` is true, and naming the packages in
`rebuilt` when present), then a total row. The host's deployment journal holds the same list.
When `phaseTimings` is empty (neither a verified cutover nor a fresh candidate build), write "no phase timings
recorded" instead of a table.
