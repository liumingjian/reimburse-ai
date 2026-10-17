# Recovery after an import that was never saved

ADR-0026 established that 收票占用 is not terminal: invoices imported into a bill that was then abandoned
unsaved can be imported again into a fresh bill, and the ERP overwrites the existing 收票单
(`save-contract.md:618,621`, the 2026-09-11 run over eighteen rounds). That removed the premise under
ADR-0024's disposition for the `未保存·已导入未写明细` breakpoint, which sent the employee to 转人工 on the
grounds that "the invoices are consumed and the import cannot be replayed".

This ADR designs what replaces it. Decided in a grilling round on 2026-09-19.

> **Restated the same day by [ADR-0028](0028-baox-fills-the-form-the-employee-saves-it.md).** baox no longer clicks
> 保存, so "this job started no `save` attempt" is vacuously true and carries no information. The gate becomes
> observational: **重新去报销 is offered while the ERP shows no 单据编号.** A 单据编号 means the employee has saved,
> and re-importing would land in the one cell ADR-0026 left blank, so that case keeps 转人工. Everything below —
> why the prohibition is narrower than it was read, where the gate lives, what the recovery does, the task-owned
> 收票占用 — stands unchanged; only the predicate is different. The section on 未保存·就绪待保存 is superseded:
> that bucket is no longer a breakpoint at all.

## The replay prohibition is narrower than it was read

ADR-0016: "Any loss after it (server restart, executor crash, lost connection, drift) becomes ERP 写入结果未知
and goes to reconcile, never replay." The reason is stated in ADR-0024's own rejection of 「只重跑保存这一步」:

> It would assume we know the earlier save did not take effect, which is the one thing 对账 exists because we
> do not know.

So the prohibition is on acting again when the first outcome is **unknown** — not on acting again as such.

And attempts are recorded **per action**, not per job: `protocol.ts:58` defines `MUTATIONS = ['import',
'fill', 'save']`, `attempt_started` carries `action`, and `erp_attempt.action` is a checked, append-only
column (`migrations.ts:166`). An action that was never attempted has no unknown outcome attached to it.

ADR-0024 conflated "an attempt exists for this job" with "an attempt exists for this action". `afterAttempts`
(`fill-jobs.ts:36`) makes the same conflation — it asks only whether *any* attempt row exists. That guard is
correct for deciding a job's `result` status, and this ADR does not change it; what changes is what the
reconcile page may offer afterwards.

## Decisions

- **`未保存·已导入未写明细` moves from 转人工 to 原地等待.** Nothing was persisted: the form carries no
  单据编号 and is in 新增 mode, so there is no ERP document to hand anyone. The exits are 重新去报销 (gated,
  below) and 转人工 (always available). As in ADR-0024, 重新去报销 is **not a third disposition** — the
  disposition stays 原地等待 and GLOSSARY.md's 仅有的两种处置 stands.

- **The gate is the absence of a save attempt**: 重新去报销 is offered only when this job has **no
  `erp_attempt` row with `action = 'save'`**. Import and fill leave observable, non-persistent traces on an
  unsaved form; only `save` writes to the ERP's database, and only `save` can still be in flight when 对账
  reads the page (`save-contract.md`: 点保存后工具条变灰、页面转圈、页签过几秒才从「新增」变「修改」并出单号).
  A save that was fired is therefore the one action whose unknown outcome can invalidate the 未保存 reading,
  and it keeps 转人工 as the only exit.

- **The gate lives outside the classifier.** `classifyReconciliation` stays pure and unchanged: the bucket is
  a function of the ERP readings alone. Eligibility is computed at the disposition layer from `erp_attempt`.
  **The bucket says what the ERP shows; eligibility says what baox itself did.** Two sources, deliberately
  not mixed — mixing them would make the same ERP page classify differently depending on baox's own history,
  which is exactly the property that makes the classifier testable.

- **重新去报销 re-runs the fill job for the same task on a fresh 新增单.** Not the old page instance: V-45
  records that the 发票助手 can be used only once per page instance, and the automation lease died with the
  previous job anyway. The fresh job runs ADR-0016's full order — Chromium, login probe, catalog check,
  import, fill, save, strict read-back — and opens its own attempts. The task's confirmed materials, lines,
  projects and 事由 are reused; nothing is re-confirmed, because nothing about them changed.

- **收票占用 gains an owner.** The record persisted before the import click (ADR-0025) carries the `taskId`
  that created it. Re-importing an invoice whose occupancy belongs to **the same task** is permitted; an
  occupancy belonging to another task remains a hard block, unchanged from ADR-0007 and V-14. Without the
  owner, baox's own duplicate gate would block the recovery it is offering.

- **The import judge is unchanged, and it is what catches the case this cannot fix.** The verdict is the
  收票网格 read-back (V-45), plus the per-invoice error list, because the assistant's summary gives counts
  without reasons (`save-contract.md:437-444`). An invoice refused as `重复报销，禁止导入` is bound to a
  历史费用报销单, not to our abandoned bill; the run aborts to 转人工 carrying the ERP's verbatim text.
  **申请解绑 is never clicked, and neither is 「删除发票」** — ADR-0026 unbanned the latter for human use
  only, and this path does not need it, because overwrite does the work.

- **No numeric cap.** The bound is the authorisation ADR-0016 and the personal-account rules already require
  for every ERP write: one authorisation, one write attempt. The 对账 page shows how many imports this task
  has already made, read off `erp_attempt`, so an employee can see an escalation rather than being stopped at
  an arbitrary number.

- **`未保存·就绪待保存` gets the same gate.** It is the same shape — the fill finished, the job died, nothing
  was saved — and the machinery is identical. ADR-0024's rejection of 「只重跑保存这一步」 stands untouched:
  that option re-fired the save **on the old form**, assuming the earlier save had not landed. This is a
  fresh attempt on a fresh form, offered only when no save was ever fired, so the assumption is not made.

## Copy

ADR-0024 requires every breakpoint's copy to answer three questions. For `未保存·已导入未写明细`:

- **发票被占用了吗** — 被占着，但占它的是刚才那张**没保存的单**，不是被报销掉了。重新去报销时再导一次，
  ERP 会覆盖掉那条收票记录。
- **ERP 现在是什么样** — 一张没有保存的新增单，收票信息里已经有 N 行，费用明细还没写。它没有单据编号，
  关掉也不会留下单据，不需要你去清理。
- **下一步** — 重新去报销：从头开一张新单重走一遍。

The button is labelled 重新去报销 and never 重试, for the reason ADR-0024 gives: 原地等待 "不表示可以自动继续",
and the label is where that distinction is pinned.

## Testing

- The fake ERP must express overwrite-on-re-import: importing an invoice that already carries a 收票单 from an
  abandoned bill succeeds and reports 「已存在对应的收票单…已进行覆盖」. It cannot today, which is the same
  gap ADR-0023 recorded.
- A job that died after the import attempt reconciles to 原地等待, offers 重新去报销, and the recovery run
  produces one saved draft whose 收票网格 holds N rows — not 2N.
- A job that fired a save attempt and died reconciles with 重新去报销 **not** offered, whatever the bucket.

## Consequences

- ADR-0024's table changes in two rows. The rest of it — six copy variants, one page, 重新去报销 is not a
  disposition, the labelling rule — is unchanged and this ADR leans on all of it.
- An inconsistency surfaced while reading the two together and is **not** resolved here: ADR-0024's table
  gives `未保存·就绪待保存` the disposition 转人工, while `reconcile.ts` returns 原地等待 for it. One of them
  is wrong and the ADR is the later document, so the code may simply never have been updated. It needs a
  decision of its own.
- ADR-0016 is refined, not overturned: its guard is restated per action, which is the granularity its own
  protocol already records at. `afterAttempts` keeps its job-level rule for deciding a result status.
- GLOSSARY.md's 收票占用 entry gains the task owner, and 未保存·已导入未写明细 stops being described as a state
  with no way back.
