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
| `EXTENSION_MINIMUM_VERSION` raised in `contract/src/extension.ts` | Every QA browser's old extension is refused: re-download from the settings page and reload it before QA. |
| `EXTENSION_VERSION` raised, minimum unchanged | A new extension is available; reload it to QA the extension change. |
| `extension/` changed, `EXTENSION_VERSION` unchanged | The extension changed without a version bump; QA browsers keep running the old build. Flag it as a probable release mistake. |
| A new key in the migrations map of `server/src/db/migrations.ts` | Schema migration: rollback to the previous release is unsafe from now on (the database never migrates backwards, and there is no backup). |

Routine releases keep the installed origin, so 扩展配对 (extension pairing) survives; say so only if the user asks.

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
  changes from step 1, and the QA entry `http://10.250.0.222:8888`. Then end with `result:`.
- **Any other state** (`restored`, `busy`, `refused`, `failed`, `recovery-required`, `post-access-handoff`,
  `reconcile-needed`, or a candidate state other than `prepared`): the host is now the user's to decide on. Quote the
  operator's lines verbatim, attach `operator status` and `operator logs --lines 100`, and end with `needs input:`.
  Your part ends at the report: leave retries, `--candidate` reruns, rollback, `snapshot`, gate `admit`/`reopen`
  and `bootstrap-*` to the user.
