# Each 对账 breakpoint gets its own copy, and 重新去报销 is not a third disposition

`server/src/erp/reconcile.ts` places a bill in exactly one of the six 对账中断点 (reconcile breakpoints) and returns
one of the two 处置 (dispositions), 原地等待 or 转人工. The classification has existed since the port; what the
employee sees for each breakpoint had never been designed, and the six differ on the question they most want answered.
Decided in [#232](https://github.com/liumingjian/reimburse-ai/issues/232).

> **Amended again 2026-09-19 by [ADR-0028](0028-baox-fills-the-form-the-employee-saves-it.md).** baox no longer
> clicks 保存, so 未保存·就绪待保存 leaves the breakpoint table and becomes the success reading — a filled,
> read-back, unsaved form is what a hand-over looks like. 已保存 now means the employee saved it themselves.
>
> **Amended 2026-09-19 by [ADR-0027](0027-recovery-after-an-import-that-was-never-saved.md).** Two rows of the
> table below changed. The premise for sending 未保存·已导入未写明细 to 转人工 — "the invoices are consumed and
> the import cannot be replayed" — was false: ADR-0026 shows the ERP overwrites the 收票单 on re-import. The rest
> of this ADR stands, and ADR-0027 rests on it.

## Decisions

- **One 对账结果 page with six sets of copy**, and buttons driven by the disposition. GLOSSARY.md defines a breakpoint
  as "不是一个「全绿/不全绿」的判断，正常停下与异常停下都各有自己的格" — collapsing the six into the two
  dispositions would throw away exactly the part the employee needs.
- **Every breakpoint's copy answers three questions**: are my invoices occupied, what is on the ERP right now, what do
  I do next.
- **The 原地等待 button must never read like a retry.** 原地等待 explicitly "不表示可以自动继续".
- **The six exits.**

  | 中断点 | 处置 | Exit offered |
  | --- | --- | --- |
  | 未保存·导入前 | 原地等待 | 重新去报销, stating plainly that no ERP write happened and no invoice is occupied |
  | 未保存·已导入未写明细 | ~~转人工~~ 原地等待 | 重新去报销 while the ERP shows no 单据编号 ([ADR-0027](0027-recovery-after-an-import-that-was-never-saved.md), as restated by ADR-0028), else 转人工 |
  | ~~未保存·就绪待保存~~ | not a breakpoint | Success: the form is filled and handed over for the employee to save ([ADR-0028](0028-baox-fills-the-form-the-employee-saves-it.md)) |
  | 已保存, identity holds | 原地等待 | Success: the employee has saved it. It projects as ERP 单据已交接 and the word 对账 never appears |
  | 已保存, identity fails | 转人工 | 转人工 |
  | 未知 | 原地等待 | 再对一次账 / 转人工 |

- **「重新去报销」 is not a third disposition.** The disposition remains 原地等待: baox issues no further ERP write
  for this attempt. Starting a fresh 报销任务 afterwards is the user's own action. It is not a replay either —
  ADR-0016 forbids replay only *after* `attempt_started` is persisted, and ADR-0020 already states that aborting
  before it means the job "can simply be run again". GLOSSARY.md's 仅有的两种处置 stands unchanged.
- **Because that distinction is easy to misread, it is pinned in the interface**: the button is labelled 重新去报销,
  never 重试, and sits next to the sentence saying no invoice was occupied.

## Considered Options

- **Show only the two dispositions and keep the breakpoint name for the audit trail.** The smallest possible surface,
  and wrong: "was my invoice consumed" has different answers across the six, and it is the first thing an employee
  asks.
- **A separate page per breakpoint.** The same page six times over; the copy differs, the structure does not.
- **Offer 「只重跑保存这一步」 at 未保存·就绪待保存**, where both sides are equal to the cent and only the save is
  missing. Rejected, and this is the load-bearing rejection: that breakpoint is reached *after* `attempt_started`, so
  re-running the save is precisely the replay ADR-0016 forbids. It would assume we know the earlier save did not take
  effect, which is the one thing 对账 exists because we do not know.
  **(Still rejected after ADR-0027.** That ADR offers a fresh attempt on a *fresh* form, gated on no `save` attempt
  ever having been started — so it never re-fires a save, and never assumes anything about one. What ADR-0027 does
  correct is the sentence above reading `attempt_started` as job-level: attempts carry an `action`, and "an import
  attempt exists" is not "a save attempt exists".)
- **Send 未保存·导入前 to 转人工 as well, for a uniform rule.** Rejected: it charges a manual hand-off for a run that
  provably wrote nothing and consumed no invoice, which teaches employees that stopping is always expensive.
- **Treat 已保存 with a holding identity as a reconcile outcome and show the 对账 page.** Rejected: that state is
  success. Showing an employee a reconciliation screen for a bill that is fine invites them to intervene in a draft
  that does not need it.

## Consequences

- The 对账 result page is a user-facing deliverable with six copy variants, not a status badge.
- 未保存·导入前 needs a path back into a fresh 去报销 for the same materials, distinct from the recovery paths that
  exist after an attempt.
- 已保存 with a holding identity must project as ERP 草稿已交接 rather than routing through the reconcile page at all.
- GLOSSARY.md is unchanged: 原地等待 and 转人工 remain the only two 处置.
