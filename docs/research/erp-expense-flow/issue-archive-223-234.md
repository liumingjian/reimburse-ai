# Issue archive: #223-#234 (fill-detail grilling round)

Captured 2026-09-19, verbatim, before the issues were closed. These twelve issues were
created as a side effect of a grilling round, which is not how this project's pipeline
works: a grilling round ends with a consensus summary, and only a user-invoked `/to-spec`
turns that summary into a spec, and `/to-tickets` into tickets. The issues were therefore
torn down.

Several of them held content that existed nowhere else - notably #228, #229, #230, #233
and #234, plus the V1 scope statement in #227 and the file:line pointers in #231. That
content is preserved here verbatim so the teardown costs nothing. ADR-0019 through
ADR-0024 remain the decision record and are unaffected; their "Decided in #NNN" lines
now point at closed issues, which is normal.

This file is a record, not a backlog. Nothing in it is a commitment to build.

---

## #223 - Per-app-account ERP control lease and extension pairing

State at capture: OPEN. Labels: enhancement

### Body

The extension architecture moves the ERP browser out of the server and into each employee's own browser. Two things follow, and they are one decision.

## Control

`ERP 自动化控制权` (ERP automation control) is today global and explicitly *not* partitioned by app account: `server/src/erp-lease.ts` is a single in-memory lease, and a second user's 去报销 gets a 409 `erp_in_use` (ADR-0018).

That rule exists for two disciplines, not for concurrency: 发票占用 (invoice occupancy) and "an ERP write of unknown outcome is never replayed" (ADR-0016). Both are properties of **one ERP account writing one bill**. Serialising across *different* users buys nothing and turns the system into a queue once ten people use it.

**Decision: the lease becomes per app account.** One user cannot run two ERP jobs at once; different users never block each other.

## Pairing

The server must know which app account a connected extension belongs to, or one user's ERP job gets routed into another user's browser.

**Decision: one-time pairing code.** The web UI issues a short-lived single-use code; the extension exchanges it for a long-lived token held in `chrome.storage.local`. The token carries the app account id, and the server routes ERP commands by that id.

Rejected: reusing the web session cookie (welds the extension to browser cookie lifetime and to `SameSite` / WebSocket-Origin semantics, and dies on web logout), and authorising afresh on every 去报销 (defeats the point of automation).

## Scope

- Partition the lease by app account; remove the global 409 path.
- Pairing code issue/redeem endpoints, token storage, revocation in the account UI.
- Route ERP commands and observations by app account.
- Update `CONTEXT.md`: control is per app account, and expires when that account's browser connection is lost rather than when the app process exits.

Recorded as an ADR.


### Comments

**liumingjian**:

Recorded as ADR-0019: `docs/adr/0019-per-account-erp-control-and-extension-pairing.md`

---

## #224 - Reconnection discipline: a reconnect restores the channel, not the page

State at capture: OPEN. Labels: enhancement

### Body

ADR-0016's central discipline is: persist `attempt_started` before the first mutation, and from then on any loss means **ERP 写入结果未知 (ERP write outcome unknown)** → 对账 (reconciliation), **never replay**.

That discipline is affordable today because "loss" only means the server process crashed, which is rare. Under the extension architecture the executor sits behind a WAN link, a tab the user can close, a laptop lid, and a service worker Chrome may evict. **Losing the connection mid-write becomes an ordinary event.** Applied verbatim, users would routinely be told to go and reconcile.

## Decisions

**1. A reconnection window.** Within N seconds the extension may reconnect and resume the event stream by `jobId`.

This weakens nothing. `attempt_started` is still persisted before the first mutation. The window only decouples *the event stream was interrupted* (recoverable) from *the ERP write outcome is unknown* (not recoverable). Judgement stays on the server.

**Explicitly rejected:** letting the extension finish the remaining steps on its own and report back afterwards. That would void `server owns judgement, executor only observes`, which is the foundation the no-replay rule stands on.

**2. Reconnection restores the channel, not the page.** After reconnecting, the extension must re-observe: still the same bill, still the same identity, the 发票助手 (invoice assistant) in a recognisable state. The assistant is one-shot — once closed it cannot be reopened — so a restored event stream says nothing about whether filling can continue. Anything uncertain goes to one of the six 对账 breakpoints. Never resume optimistically.

**3. A `chrome.debugger` detach is the same event.** The "Chrome is being debugged" banner carries a *Cancel* button, on unmanaged machines it cannot be suppressed (see the distribution issue), and it looks like a warning — users will click it. On detach: if `attempt_started` exists, go to 对账; if not, abort in place and say plainly that **no ERP write happened** and the job can simply be run again.

Rejected for both 2 and 3: silently re-attaching and continuing (vouches for a page nobody observed), and asking the user whether to continue (the user is the party least able to know what state the page is in).

Recorded as an ADR.


### Comments

**liumingjian**:

Recorded as ADR-0020: `docs/adr/0020-reconnection-restores-the-channel-not-the-page.md`

---

## #225 - Extension fill technique, browser scope, distribution and version negotiation

State at capture: OPEN. Labels: enhancement

### Body

How the extension actually drives the ERP page, and how it reaches employees' machines. These are one issue because the technique forces the `debugger` permission, and the distribution channel determines what that permission costs.

## Technique: hybrid

The ERP is 金蝶 K3Cloud (Kingdee K3Cloud); the bill is built from Kendo controls. Two measured facts from the research corpus constrain this:

1. **Kendo controls ignore programmatic assignment.** Writing `value` and dispatching `input`/`change` leaves the control's internal state stale. A synthesized Meta+A select-all demonstrably failed, leaving concatenation artefacts (`客户支持客户支持`, `0.0018.25`). Non-`isTrusted` events are not reliable on the detail grid.
2. **`DOM.setFileInputFiles` takes paths only.** With the originals on the server, the extension has no local path to give it.

**Decision:**
- **File upload via the content script**: build `File` objects from bytes the server sends, assemble a `DataTransfer`, assign `input.files`. No path needed. This route has already been demonstrated working on this exact page.
- **Detail grid via `chrome.debugger`**: `Input.dispatchKeyEvent` produces genuine trusted events.

Rejected: a debugger-free extension (cannot fill the grid), and all-`chrome.debugger` (upload would need `setFileInputFiles`, which needs paths).

## Browsers: Chrome and Edge only

`chrome.debugger` is Chromium-only; Firefox and Safari have no equivalent. K3Cloud is in practice only seriously tested on Chromium anyway. Firefox support would be a second executor, not an adaptation. Write this into scope.

## Distribution: unpacked, developer mode

**Established fact: employees use personal machines; Chrome is not under enterprise policy.** That removes `ExtensionInstallForcelist`, and with it any policy that could silence the debugger banner.

**Decision: load-unpacked in developer mode.** Two consequences are now fixed and must be designed around, not wished away:

- **The banner is permanent.** "Chrome is being debugged" stays at the top of the browser throughout filling. The product must tell the user this is expected, and treat clicking *Cancel* as a control loss (see the reconnection-discipline issue).
- **There is no auto-update**, which forces the next decision.

## Version negotiation

Versions in the field will diverge. ADR-0016's fill protocol is coarse: the server hands down one whole plan and the extension executes it. An old extension receiving a new plan shape does not fail cleanly — worst case it executes **half** of it: some fields written, invoices imported, then stuck. That lands in the most expensive 对账 breakpoint, **未知 (unknown)**: invoices occupied, outcome undecidable.

**Decision: the extension reports its version on pairing and on every connect; the server enforces a minimum and refuses to connect below it,** with upgrade instructions.

Refusing costs "no reimbursement today, go update". Allowing costs one irreversible ERP write of unknown outcome plus a manual reconciliation. Not the same order of magnitude. Best-effort backwards compatibility was rejected: it would require maintaining a fill path per historical version, and we cannot even reliably know which version a user is running.

Recorded as an ADR.


### Comments

**liumingjian**:

Recorded as ADR-0021: `docs/adr/0021-hybrid-fill-technique-and-unpacked-distribution.md`

---

## #226 - Central storage and encryption model for invoice originals

State at capture: OPEN. Labels: enhancement

### Body

Once the server runs on Linux and serves several people, invoice originals (PDFs and images) need a home and a protection model.

## Central storage

**Decision: keep originals centrally**, readable only through their owner's tasks.

Not storing originals — keeping only OCR results and hashes, and having the extension read files from the user's disk at fill time — sounds better for privacy but removes half the product: 去打印 (go to print) composes the originals into a printable document, and 收票单号 (receipt number) readback checks against them. It also loses everything when a user changes machines.

## Protection: full-disk, not envelope

**Decision: full-disk/partition encryption (LUKS) plus encrypted backups, plus owner-scoped authorisation. No application-level envelope encryption.**

Per-file data keys under a master key sound stronger, but the server **must be able to read plaintext** to run OCR, compose print output and verify readback. The master key would therefore live in the service process and the decrypt path would run constantly. It does not defend against "the application is compromised"; it only defends against "someone walks off with the disk" — which full-disk encryption already covers. In this threat model envelope encryption is paper benefit and real complexity.

A retention/cleanup policy after a reimbursement completes is a sensible later addition on top of this, not a substitute for it.

## Scope

- Owner-scoped authorisation on every read path for originals.
- Deployment documentation: encrypted volume, encrypted backups.
- Confirm content-addressed blob deduplication stays reachable only via the owner's tasks (ADR-0018 already requires this).

Recorded as an ADR.


### Comments

**liumingjian**:

Recorded as ADR-0022: `docs/adr/0022-central-invoice-originals-with-full-disk-encryption.md`

---

## #227 - V1 scope: extension executor plus a reachable service; run live on CDP first

State at capture: OPEN. Labels: enhancement

### Body

## Scope

V1 = the extension executor + making the service reachable. Concretely:

- Extension executor (see the pairing, reconnection and fill-technique issues).
- Master-data lookups go through the extension.
- Configurable bind host instead of a hardcoded `127.0.0.1`; `Secure` cookies.
- **TLS via an nginx/Caddy reverse proxy, not inside Node.**

Deferred: rate limiting, OCR worker concurrency. The OCR worker is an independent performance problem with zero coupling to the extension architecture; bundling it in would keep this round from ever closing.

Rejected: doing everything at once, and "extension only, still single-user". The latter fails to validate anything that matters — the extension's real complexity (auth, disconnection, file injection) only appears once there genuinely is a network in between.

## Order: run live on CDP first, then build the extension

Keep the existing CDP executor. Demote it to development and test only (e2e, the stateful jsdom fake ERP, `pnpm test:erp-live`); the extension executor serves production.

The seam already exists: `server/src/erp/protocol.ts` defines `FillExecutor` as a `createApp` injection point, and an oxlint rule plus `lint-boundary.test.ts` actually enforce the boundary. ADR-0016 made the executor separable precisely in anticipation of a second consumer. The extension is that consumer. Deleting the CDP executor would throw away the whole test infrastructure and buy nothing.

**Run against the real ERP on CDP first.** The fill plan, 严格回读 (strict readback) and 对账 (reconciliation) classification are executor-independent and shared by both approaches. Validating their assumptions against the real ERP first — especially the 收票单号 contradiction — means extension development does not have to fight "what does the ERP actually do" and "can the extension do it" as two unknowns at once.

## Hard prerequisite

`baox admin reset-password` must be dealt with **before** the service is exposed to the network. Tracked separately.


### Comments

**liumingjian**:

The 收票单号 contradiction named here is settled — by salvage, not by a live run.

Research recorded the detail 收票单号 as empty under 不生成费用明细; mainline's strict read-back required it to equal the bound receipt. The evidence that resolves it existed since 2026-09-11 (a real end-to-end save, draft `FYBX20260911000011`, 4 invoices, 收票/明细 含税合计 4,413.43 = 4,413.43) but sat on the unmerged branch `worktree-lockscreen-probe` (`6ed1707`, `a88081f`). The server port came from `50931a3`, i.e. from before those commits, so the strict form was carried forward and the evidence was not.

The research section is now salvaged into `docs/research/erp-expense-flow/save-contract.md`. The judgement drawn from it is ADR-0023, implemented in #231. The same run also pins two behaviours mainline never had: ERP renders a zero 税额 as a blank cell, and rail lines must be checked on 价税合计 only.

Consequence for this issue's plan: "run live on CDP first" no longer needs to spend the non-renewable sample to answer this. #233 records what a live save-run is still for and what must be true before it runs.

---

## #228 - Remove the unconditional baox admin reset-password backdoor before network exposure

State at capture: OPEN. Labels: enhancement, ready-for-agent

### Body

ADR-0018 gives the local machine a fallback: `baox admin reset-password <username>` resets any account's password unconditionally, on the reasoning that "access to the machine counts as authority". That reasoning holds for a process bound to `127.0.0.1` on one person's laptop.

It does not survive the move to a shared Linux server. There, anyone who can get a shell can become any user — including reading other people's invoice originals. It degrades the whole authorisation model to "whoever has shell is god".

## Decision

- **Remove the unconditional CLI.**
- Administrators reset other users' passwords in the web UI (a temporary password the user must change at next login — this part of ADR-0018 stays).
- Keep a **minimal emergency CLI** for the locked-out-admin case: it may only reset an administrator's own account, and it writes an audit record.

Rejected: keeping it as-is and relying on SSH access control (unacceptable in a multi-user system), and removing it entirely (locks you out of your own deployment).

## Blocking

This must land **before** the service binds to anything other than `127.0.0.1`. It amends ADR-0018's password-recovery clause.


---

## #229 - Check project and expense-item master data read-only as the ERP job's first step

State at capture: OPEN. Labels: enhancement, ready-for-agent

### Body

Filling needs a project number and a 费用项目 (expense item) code. In the ERP these are master data: they can be renamed, deactivated, or simply not exist.

## Decision

**Check them read-only as the first step of the ERP job**, before anything is written. If they do not check out, abort there.

At that point no `attempt_started` exists, so there is no 对账 (reconciliation), no 发票占用 (invoice occupancy), and nothing to undo — the cost of aborting is zero.

Rejected:

- **Checking at 整单明细确认 (whole-bill detail confirmation).** It surfaces problems earliest, but under the extension architecture the server cannot reach the ERP at all; it would have to borrow the extension for a separate lookup, which splits the ERP job into two phases.
- **No explicit check, relying on 严格回读 (strict readback).** The failure would only surface at the "未保存·已导入未写明细" breakpoint — invoices already occupied. The most expensive possible place to find out.

## Note

This gives the live run a free probe of `FY010002` (外地市内交通), still marked `user_declared` in the verification ledger (V-10): if the code is wrong, the run stops here having written nothing.


---

## #230 - Verify the DataTransfer upload route by rehearsal, not by a live save-run

State at capture: OPEN. Labels: enhancement

### Body

The hybrid fill technique uploads files through the content script: build `File` objects from server-sent bytes, assemble a `DataTransfer`, assign `input.files`. The research corpus shows this working on this ERP page — but as a standalone spike, not inside a complete reimbursement flow.

## Decision

**Do not fold this into `pnpm test:erp-live`.** Verify it with 排练 (rehearsal) instead.

A live run saves a real draft, which binds its invoices (发票占用) irreversibly. The sample invoices are a single, non-renewable set. Folding an unvalidated route into that run risks failing around the "未保存·已导入未写明细" breakpoint with the invoices already consumed — spending an irreversible resource to answer a question that can be answered separately.

排练 fills fields on a new bill, reads each back, and exits **without saving**. It consumes no invoices and is infinitely repeatable. That is the right instrument for this.

## Scope

- A rehearsal harness that exercises the `DataTransfer` upload route end to end on the real ERP.
- Confirm the file reaches the 发票助手 (invoice assistant) and is recognised, then exit without saving.


### Comments

**liumingjian**:

Scope widened (see ADR-0023 / #231 / #233 for the round this came out of).

Verifying only "the file reaches the 发票助手 and is recognised" under-uses the instrument. A rehearsal needs a live ERP session and a person watching it; while that session is open it should also:

- fill every detail field in contract order and read each back (the shape `erp-fill --rehearse` already has, per verification ledger V-44);
- **read the detail rows' 收票单号 and report how many are non-empty.** This is the only way to observe whether ERP links the receipt after the fill without spending an invoice on a live save. The salvaged research section "2026-09-11 首次端到端自动保存" says it stays empty even after a successful save, and ADR-0023 relies on that; a rehearsal re-confirms it on the current ERP build for free;
- exercise the silent-rollback conditions from V-44, which only repeated rehearsal can catch.

## One correction to this issue's premise

> 排练 fills fields on a new bill, reads each back, and exits **without saving**. It consumes no invoices and is infinitely repeatable.

True of the fill and read-back. **Not true of the upload step this issue is about.** Once an invoice passes through the 发票助手 it is consumed by the ERP — that is exactly what the 未保存·已导入未写明细 breakpoint means. A rehearsal that exercises the `DataTransfer` route therefore needs an invoice we do not care about; using the 曹操 sample would spend it before the run it is reserved for (#233).

CONTEXT.md's 排练 entry has been corrected accordingly.


---

## #231 - Relax strict read-back: empty 收票单号 link, blank tax as zero, rail gross-only

State at capture: OPEN. Labels: enhancement

### Body

The strict per-line read-back (`server/src/erp/readback.ts:374`) requires the detail row's 收票单号 (receipt number) to equal the bound receipt. Research says ERP leaves that cell **empty** under the 「不生成费用明细」 import mode baox always uses, so the comparison can never pass. `server/src/erp/fill-plan.ts:203` records the clash as UNVERIFIED, and the only green end-to-end save path in the test suite depends on `assumeReceiptLink`, a fake-ERP flag the fixture itself marks as an unverified assumption.

It is no longer unverified. The salvaged research section "2026-09-11 首次端到端自动保存" in `docs/research/erp-expense-flow/save-contract.md` records a real end-to-end save (draft `FYBX20260911000011`, 4 invoices, 收票/明细 含税合计 4,413.43 = 4,413.43) and pins three ERP behaviours at once. That evidence sat on the unmerged branch `worktree-lockscreen-probe` (commits `6ed1707`, `a88081f`) and never reached main; the server port carried the strict version forward.

## Decision

See ADR-0023. Three relaxations land together, because they come from the same run and fixing only the first still fails on rail lines:

1. **Empty 收票单号 is tolerated**; a non-empty one must still be exactly the bound receipt.
2. **A blank 税额 counts as 0**, and only when 申请报销金额 == 费用金额 corroborates it. ERP renders a zero tax as an empty cell.
3. **Rail e-tickets are checked on 价税合计 only.** ERP's receipt side computes a 9% deduction (644.95 / 58.05) that deliberately differs from the detail side.

Plus two consequences of losing the link as a discriminator:

4. **A wholly blank detail row does not participate in per-line matching** (reuse `isEmptyDetailRow`'s criteria). There is no delete-row path and none is being added.
5. **Disambiguation order when several ERP rows match all remaining columns**: match on the remaining columns first; a unique hit wins; only on multiple hits does the fill's own `rowsWritten` (lineId -> rowIndex) name the row, and the named row must still match every column. The fill's self-report can never make a row *pass* a check it would otherwise fail.

## Not in scope

Fill targeting is unchanged. It already tolerates an empty link: `detailRowsForFill` routes a wholly blank row into `placeholders` and the fill loop consumes those positionally (`server/src/erp/executor/draft-flow.ts:164-183, 249-273`). The unmerged branch's targeting code is byte-identical to mainline's.


---

## #232 - Design the user-facing handling of the six 对账 breakpoints

State at capture: OPEN. Labels: enhancement

### Body

`server/src/erp/reconcile.ts` already places a bill in exactly one of the six 对账中断点 (reconcile breakpoints) and returns one of the two 处置 (dispositions). What the user sees for each breakpoint has never been designed.

## Decision

See ADR-0024.

**One 对账结果 page**, six sets of copy, buttons driven by the disposition. Each breakpoint's copy must answer three questions: are my invoices occupied, what is on the ERP right now, what do I do next. The 原地等待 (wait in place) button must never read like a retry.

| 中断点 | 处置 | User-facing exit |
| --- | --- | --- |
| 未保存·导入前 | 原地等待 | 重新去报销 — say plainly that no ERP write happened and no invoice is occupied |
| 未保存·已导入未写明细 | 转人工 | 转人工; the invoices are consumed |
| 未保存·就绪待保存 | 转人工 | 转人工 |
| 已保存 (identity holds) | 原地等待 | This is success: 走 ERP 草稿已交接, never show the word 对账 |
| 已保存 (identity fails) | 转人工 | 转人工 |
| 未知 | 原地等待 | 再对一次账 / 转人工 |

## 原地等待 vs a new task

「重新去报销」 is **not** a third disposition. The disposition is still 原地等待: baox issues no further ERP write for this attempt. Starting a fresh 报销任务 afterwards is the user's own new action, and it is not a replay — ADR-0016 forbids replay only after `attempt_started` is persisted, and ADR-0020 already says that aborting before it means the job "can simply be run again". CONTEXT.md's "仅有的两种处置" stands unchanged.

This distinction is easy to misread, so the button is labelled 重新去报销, never 重试.


---

## #233 - Preconditions before spending the sample on a live save-run

State at capture: OPEN. Labels: enhancement

### Body

A full `pnpm test:erp-live` run (without `--probe-only`) saves a real draft and irreversibly binds its invoices (发票占用). The sample is a single non-renewable set of 曹操出行 PDFs. It must not be spent to answer a question something cheaper can answer.

## Decision

**Do not run it yet.** #227 named the 收票单号 contradiction as the most important thing a live run should settle; it is now settled by salvaged evidence instead (see #231). What remains that only a real save can answer is the save itself.

Preconditions, all three:

1. The three read-back relaxations of #231 have landed on main and their unit tests pass.
2. One complete 排练 (rehearsal), including the upload route, is green (#230).
3. The silent detail-row rollback recorded in the verification ledger V-44 is either located or confirmed not to reproduce in rehearsal. The related date-cell finding in `docs/research/erp-expense-flow/save-contract.md` "2026-09-11 首次端到端自动保存" — the datepicker swallows Cmd/Ctrl+A and appends, and still drops writes silently after switching to `select()` — is likely the same family and should be checked together.

## Blocking note for #230

排练 fills and reads back without saving, so it consumes no invoices — **except at the upload step**. Once an invoice passes through the 发票助手 it is consumed by the ERP; that is the whole meaning of the 未保存·已导入未写明细 breakpoint. A rehearsal that exercises the `DataTransfer` upload route therefore needs an invoice we do not care about. Using the 曹操 sample for the rehearsal would spend it before the run it is reserved for.


### Comments

**liumingjian**:

Retry discipline for the fill, decided in the same round. It belongs with precondition 3 because it is what the executor must do when the silent rollback happens, whether or not we ever locate its cause.

Two failure shapes, told apart by whether a write happened:

- **没进编辑态** — the click landed but the editor never bound (focus on the `td`; `contains` is true anyway, keystrokes vanish without error). No write happened. Recoverable: re-locate the editor and retry **once**.
- **静默回滚** — the editor was bound, the value was typed, and the row reads back the old value after leaving edit mode, with no dialog and no error. A write happened and the ERP swallowed it. **Zero retries of the value.** V-44 observed `3433.96` / `999.99` / `3433.96` all settling back to `¥50.12`, and a field that had succeeded minutes earlier rolling back too.

Stop on the second. If an ERP 动作尝试 is already persisted, go to 对账 (ADR-0016); if not, abort in place and tell the user plainly that no ERP write happened.

Now in CONTEXT.md as 「静默回滚」.


---

## #234 - Retire the route string; map 天数 / 住宿·出差地 / 行内事由

State at capture: OPEN. Labels: enhancement

### Body

Verification ledger V-44 records three ERP detail columns that are still unmapped — 天数, 住宿/出差地, 行内事由 — and one shape mismatch: 出发地/目的地 are **two columns** in the ERP while the kernel still carries a single `route` string.

## Decisions

- **Retire the `route` string.** 「整单明细确认」 (the whole-list confirmation) is the business authority and already lists 出发点 and 目的地 as two separate fields, matching the ERP. A single string in between only creates one opportunity to split it wrongly, and a wrong split lands in the nine 严格回读 fields.
- **天数**: derived from the two confirmed dates. Note the direction — CONTEXT.md forbids deriving a *date* from the other date plus 天数; computing 天数 from two confirmed dates is the reverse and is fine. Derive only when both dates are present.
- **住宿/出差地**: the 城市 already on the whole-list confirmation. No new field.
- **行内事由**: **not written.** CONTEXT.md's 字段来源契约 requires an authoritative source per ERP field, and this one has none: 报销事由 belongs to the header (`FCAUSA`, confirmed by V-44). Copying the header purpose onto every line would invent content, and would create a strict-readback field with no expected value.

## How this gets falsified cheaply

If the ERP requires 行内事由 to be non-empty, 排练 (rehearsal) will show it immediately — no invoice spent. Only then decide its source. Same for 天数 and 城市 mapping. This is "fill what has a source, wait for evidence on what does not", not a guess.


