# The strict read-back tolerates an empty 收票单号 link

The nine-field 严格回读 (strict read-back) is the one gate that stops baox reporting success on a bill it filled
wrongly. One of those nine fields, the detail row's 收票单号 (receipt number, `FRECINVBILLNO`), is a read-only link
the ERP owns; baox never writes it. Research said ERP leaves it **empty** under the 「不生成费用明细」 import mode
baox always uses, while `server/src/erp/readback.ts:374` required it to equal the bound receipt — a comparison an
empty cell can never pass. `server/src/erp/fill-plan.ts:203` recorded the clash as UNVERIFIED and pre-wired a refusal
message for it; the only green end-to-end save path in the suite depended on `assumeReceiptLink`, a fake-ERP flag the
fixture itself marks as an unverified assumption. Decided in [#231](https://github.com/liumingjian/reimburse-ai/issues/231);
it settles the "收票单号 contradiction" [#227](https://github.com/liumingjian/reimburse-ai/issues/227) named.

## Where the evidence was

It was never unverified. On 2026-09-11 a real end-to-end save ran against the live ERP — draft `FYBX20260911000011`,
four invoices, 收票 and 明细 含税合计 4,413.43 = 4,413.43, strict read-back matching on all four lines — and pinned
the ERP behaviours below. That record, and the code changes drawn from it, sat on the unmerged branch
`worktree-lockscreen-probe` (`6ed1707`, `a88081f`). The server port was taken from `50931a3`, i.e. from before those
commits, so the strict form was carried forward and the evidence was not. The research section is now salvaged into
`docs/research/erp-expense-flow/save-contract.md` ("2026-09-11 首次端到端自动保存").

The evidence is observation; the relaxations below are judgement, which is why they are an ADR rather than a
cherry-pick.

## Decisions

- **An empty 收票单号 is tolerated; a non-empty one must be exactly the bound receipt.** The field **stays** one of
  the nine 严格回读 fields rather than being demoted to side evidence. The difference matters on the day an ERP
  upgrade starts writing the link: under this shape the check resumes by itself, whereas a demoted field would go on
  being silently ignored.
- **A blank 税额 counts as 0, corroborated, never assumed.** ERP renders a zero tax as an empty cell (observed on the
  rail line). Blank reads as zero only when 申请报销金额 == 费用金额 agrees; an uncorroborated blank stays unreadable.
- **Rail e-tickets are checked on 价税合计 only.** The detail side carries the face amount with 税额 0.00 while ERP's
  receipt side computes a 9% deduction (644.95 / 58.05). The two differing is expected, not a defect.
- **The three land together.** They are one set of observations from one run, and relaxing only the link still fails
  read-back on every rail and taxi line — two of the four expense categories.
- **A wholly blank detail row does not participate in per-line matching.** Losing the link as a discriminator exposes
  surplus blank rows that a fresh 新增 bill brings. The criteria are `isEmptyDetailRow`'s, reused, not a second copy.
- **Disambiguation is ordered, and the fill's self-report is subordinate.** Match on the remaining columns; a unique
  hit wins; only when several rows match does the fill's own `rowsWritten` (`lineId` → `rowIndex`) name which one, and
  the named row must still match every column. A self-report can narrow a field of passing candidates; it can never
  make a row pass a check it would otherwise fail.
- **Fill targeting is untouched.** `detailRowsForFill` already routes a wholly blank row into `placeholders`, and the
  fill loop consumes those positionally (`server/src/erp/executor/draft-flow.ts:164-183, 249-273`). The empty link
  was only ever fatal at read-back. The unmerged branch's targeting code is byte-identical to mainline's, which is
  the strongest available evidence that no second change is needed.

## Considered Options

- **Demote 收票单号 to "verify only when non-empty" side evidence, leaving eight strict fields.** Behaviourally
  identical today and simpler to explain. Rejected for what it costs later: it discards the field's contract standing,
  so a future ERP that does write the link would be met with silence rather than a check.
- **Keep the strict comparison and wait for the link to appear after the fill or at save.** This is what mainline does
  today. Rejected: the 2026-09-11 run observed the cell still empty after a successful save, so the wait has no end.
- **Add a delete-row capability so surplus blank rows never reach read-back.** Rejected. Deleting is a destructive ERP
  write, and mis-targeting one destroys work; it also runs against "server owns judgement, executor only observes"
  (ADR-0016). A blank row is not a detail line, and read-back saying so is both cheaper and more honest.
- **Accept the ambiguity when two lines match on every remaining column** (the unmerged branch's position). Rejected:
  two identical 市内交通 legs on one day, same project and amount, are ordinary, and this would drop them into 转人工
  with nothing the employee could do about it.
- **Write a distinguishing marker into a detail column to keep rows separable.** Rejected: it puts content into the
  ERP that no 字段来源契约 authorises, purely for our own bookkeeping.

## Consequences

- `server/src/erp/readback.ts` changes in three places, and its failure text at `:379` — "没有一条同时匹配项目、
  费用项目、日期、金额和**收票关联**的 ERP 明细" — now points at the wrong culprit and must be rewritten.
- `assumeReceiptLink` stops being an assumption the happy path leans on: the fake ERP's default (link absent) becomes
  the modelled reality, and the tests that assert a stop (`server/src/erp/job.test.ts:160`,
  `server/src/erp-fill-executor.test.ts:82`) invert.
- `RECEIPT_LINK_NOTE` in `server/src/erp/fill-plan.ts` and its `receiptLinkMissing` wrapper lose their reason to
  exist: they explain a refusal that will no longer happen.
- The 对账 classifier is unaffected — it never used the link.
- Salvaging the research record also brought back three findings this ADR does not decide, but which the next work
  must not lose: the datepicker swallows Cmd/Ctrl+A and appends instead of replacing, and still drops writes silently
  after switching to `select()`; a save must be waited out (the tab turns 修改 seconds later, and an immediate
  read-back misjudges it as failed); the 发票助手's row count does not equal the invoice count. The first is a likely
  relative of the silent detail-row rollback in verification ledger V-44, and is tracked with it in
  [#233](https://github.com/liumingjian/reimburse-ai/issues/233).
