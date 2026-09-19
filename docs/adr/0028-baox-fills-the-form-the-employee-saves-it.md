# 去报销 ends at a filled form; the employee clicks 保存

Until now the terminal state of 去报销 was a **saved** ERP draft: baox imported, filled, clicked 保存, and
handed over a 单据编号. The user's decision on 2026-09-19 moves the line one step earlier — **baox never clicks
保存**. The run ends with a filled, strictly read-back, unsaved 费用报销单, and the employee commits it.

## Why the line moves

baox already never submits, approves or pays; the draft was always the employee's to submit or discard. This
puts the *first* durable write to the bill in their hands too, so baox writes nothing to the 费用报销单 at all.
The authority argument is the decision; two consequences are worth recording because they change other rounds:

- **The only irreversible act baox performs becomes the 发票导入单据 click.** ADR-0025 gave that click its own
  function precisely so the seam could be held by a lint rule and a test. It is now the *only* seam in the
  system, which is a much easier thing to guard than two.
- **The live suite stops producing drafts.** Together with ADR-0026 (re-import overwrites the 收票单), a full
  live run leaves nothing to clean up and nothing permanently spent. The earlier round that wanted a live gate
  "稳固" could not have one because every run consumed the sample and left a draft; that objection largely
  dissolves here.

An earlier round rejected "don't save" as a way to conserve invoices, and that rejection was correct: ADR-0025
puts consumption at the import click, so not saving conserves nothing. **This decision does not rest on that
argument.** It rests on where the commit authority sits.

## The machinery already exists

`READBACK_STAGES` (`protocol.ts:89`) already contains `before_save`, and `saveApprovedPreview` already performs
the strict read-back before the save and has the server judge it (`job.ts:258-262`, `readCurrent: reader((n) =>
(n === 0 ? 'before_save' : 'after_save'))`). Stopping there is removing the save, not building a new path.

## Decisions

- **The job order loses its last step.** ADR-0016's order becomes: Chromium, login probe, 报销信息核对, import,
  fill, strict read-back. `startAttempt('save', …)` and `saveReimbursement` are never called on the job path.
  `MUTATIONS` and `erp_attempt.action` keep `'save'` — the column's check constraint is append-only and the
  value stays meaningful for imported legacy tasks — but a test holds that no fill job ever starts one.

- **The terminal state is renamed.** `ERP 草稿已交接` is wrong once nothing is saved: 草稿 means a bill that
  reached the ERP's database, and this one did not. It becomes **`ERP 单据已交接`**, defined as: baox has filled
  the 费用报销单, the strict read-back passed, and it has permanently released the ERP 自动化控制权; the employee
  reviews and clicks 保存. The rename ripples into `contract/src/snapshot.ts`, `contract/src/legacy-import.ts`,
  `server/src/projection.ts`, `server/src/tasks.ts`, `server/src/db/schema.ts`, `server/src/erp/fill-state.ts`,
  `server/src/legacy/import.ts` and `web/src/pages/SettingsPage.tsx`, and is an implementation task.
  Legacy import (ADR-0015) is unaffected in meaning: an old task that verifiably saved really did hand over a
  saved draft, and keeps that reading.

- **`未保存·就绪待保存` stops being a breakpoint and becomes the success reading.** It is defined as receipts and
  detail equal to the cent on an unsaved form — which is exactly what a successful hand-over looks like. This
  also settles the inconsistency ADR-0027 surfaced (ADR-0024's table said 转人工, `reconcile.ts:141` returned
  原地等待): the row leaves the breakpoint table altogether.

- **`已保存` remains a success reading, with a new meaning**: the employee has already clicked 保存. 对账 run
  after the hand-over is how they confirm it, and the identity check still applies.

- **ADR-0027's recovery gate is restated observationally.** "This job started no `save` attempt" is now
  vacuously true, so it carries no information. The gate becomes: **重新去报销 is offered while the ERP shows no
  单据编号.** If a 单据编号 is present the employee has saved, and re-importing would land in the one cell
  ADR-0026 left blank (an invoice bound to a *saved* draft) — so that case keeps 转人工. The employee is the only
  party who can save, so they are also the authority on whether they have; the button is theirs to press.

- **`ERP 写入结果未知` stays reachable and keeps its meaning.** The import is still a durable ERP write whose
  outcome can be lost. Nothing about ADR-0016's attempt discipline relaxes.

## The cost, stated plainly

A pre-save read-back reads the **DOM**, and the DOM can disagree with the ERP's business model.
`reference-material-verification.md:86` records it happening:

> 首次保存时，事由控件虽然可见地显示"客户支持"，ERP 仍报"事由"必填，证明 DOM 展示值没有进入业务模型。

Today the save that follows immediately is what catches such a value; ERP raises 字段必录提示 and the run
retries the write properly. Without the save, **baox can no longer prove the filled values entered the model** —
it can only prove they are on screen. The same class of failure is already on file for the datepicker, which
"仍偶发静默丢弃" even after the `select()` fix.

Disposition: **the employee's own 保存 click becomes the validator.** That is acceptable here and nowhere else,
because this design puts them at the keyboard by definition. Two requirements follow, and they are not optional:

- The hand-over copy must set the expectation: 保存时如果 ERP 弹出「字段必录提示」或「处理结果」，说明有字段没有
  进入 ERP 的业务模型；回到 baox 重新去报销这一项，**不要手工补填**（手工补填会让 baox 的回读记录与实际单据分叉）。
- 对账 after the employee saves is the closing evidence, not an optional extra. It is the only thing that turns
  "on screen" into "in the model".

A model-level read — asking the K3Cloud client form for its field values rather than reading the DOM — would
remove the gap entirely. Nothing in the corpus says whether that is reachable. It is the highest-value unknown
this decision creates and belongs in the verification ledger, not in this ADR's assumptions.

## Considered Options

- **baox saves, and the employee deletes the draft if unhappy.** The status quo. Rejected by the decision; it
  also leans on the one cell ADR-0026 left blank — whether an invoice bound to a *saved* draft can be recovered
  at all — so its failure mode is the one we understand least.
- **Save behind a per-run switch.** Rejected: two code paths, and the one that ships would not be the one the
  gate exercises.
- **Keep saving but treat the draft as provisional.** Rejected: it does not move the authority, which is the
  whole of the decision, and it keeps every consequence above.

## Consequences

- ADR-0016's job order and ADR-0024's breakpoint table both change; ADR-0027's gate is restated. None of the
  three is overturned — their reasoning survives with the save removed.
- `personal-account-testing.md` §三 (草稿由用户本人清理) no longer describes baox-driven runs: baox creates no
  draft to clean up. The section still governs drafts the employee saves by hand.
- The strict read-back's tolerance for an empty 明细「收票单号」 (ADR-0023) is unaffected: in 不生成费用明细 mode
  that cell is empty regardless of saving.
- The three preconditions guarding a live save-run lose their subject. What replaces them is a question for the
  live-gate round, not this one.
