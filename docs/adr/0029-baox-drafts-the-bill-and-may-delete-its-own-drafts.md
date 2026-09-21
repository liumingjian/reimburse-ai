# baox 暂存 (saves a draft of) the bill, and may delete the drafts it created

ADR-0028 moved the commit authority to the employee: baox filled the 费用报销单 (expense reimbursement bill) and
stopped, unsaved, and a person clicked 保存 (save). The owner's decision on 2026-09-20 moves it back one step, for
one reason ADR-0028 did not have to answer: **无人值守 (unattended) operation**. A batch that runs with nobody
watching cannot end at "a person clicks 保存", and a run that leaves nothing behind also leaves nothing to retry
from. The run now ends at a 暂存 (saved draft), and baox is authorised to delete the drafts it created.

This is a reversal of a rule the owner previously set — "`server/src/erp/**` must never contain a delete path" —
and it was reversed deliberately and explicitly, not eroded. It is recorded here so that a future reader does not
read the never-delete comments still standing elsewhere as the live rule.

## Why the line moves back

ADR-0028's argument was about authority: the first durable write to the bill belonged to the employee. That
argument is untouched for the attended flow. What changed is that an unattended flow has no employee inside the
loop at all, and the two properties it needs — **能跑完 (it finishes without a person)** and **能收回 (a wrong
result can be taken back)** — are only available together at 暂存:

- a 暂存 bill is in the ERP database, so a batch can end without anyone present;
- a 暂存 bill is still deletable, whereas a 提交 (submitted) one has entered the approval flow and coming back
  out of it is a human process.

Not saving conserves nothing (ADR-0025 puts consumption at the import click), so this decision rests on the same
axis ADR-0028 did — where authority sits — with the unattended case added to the question.

**The coupling is the decision, not a side effect.** Today nothing needs cleaning up *because* baox never saves:
an unsaved 新增 (new) form never reaches the ERP database, has no 单据编号 (bill number), and vanishes when its
tab is closed (`fill-state.ts` tells the user exactly this). The moment baox drafts, every failed unattended run
leaves a real, numbered, 收票-occupying bill. Drafting and deleting are therefore one decision: choosing the first
without the second would produce artefacts nobody can remove.

## Decisions

- **The terminal state becomes a 暂存 draft.** `ERP 单据已交接` (the handover, ADR-0028) remains the attended
  terminal state; the unattended path continues to 暂存 and hands over a 单据编号.

- **baox may delete a 费用报销单 it created, and only that.** Four preconditions, all of which must hold; any one
  failing refuses the delete and escalates to a person:
  1. the bill carries baox's ownership marker (below);
  2. its status is 暂存 — never 提交, never 审核 (audited);
  3. its 收票 (receipts) agree with the occupancy ledger's holding for that task;
  4. an immutable audit row is written *before* the delete executes, on the same mechanism as `attempt_started`
     (ADR-0025): durable first, act second, so a crash mid-delete is reconstructible.

- **Ownership is proven from the ERP side, not from the local database.** The marker is written into the bill
  itself, so ownership survives a lost, moved or rebuilt local store, and so the delete decision can be made by
  looking only at ERP. The local ledger records the same fact for audit, but is never the admission criterion.
  A delete must be judged safe from ERP alone; otherwise a local store that cannot be trusted makes deleting
  untrustworthy too.

  **The marker goes in `FCausa` (事由, the bill's purpose text), as a suffix.** V-60 read all 81 head fields:
  every text field is already spoken for, and 事由 is the only free-text one. A dedicated `F_BJYC_*` custom field
  would be cleaner and remains the target, but the owner's decision on 2026-09-20 is that adding one is not
  currently available, so the suffix is what ships. The employee can see it; a bill stating that a program built
  it is defensible rather than embarrassing.

  **The recogniser reads the marker's content, never its location.** Ownership is decided by matching the marker
  text, so moving it to a custom field later changes one constant and no logic. The marker must survive being
  read back verbatim, must not collide with anything a person would type, and must not be derivable by guessing —
  it names a job, so an unrelated bill cannot accidentally carry one.

- **Deletion goes through one gateway module, and the never-click guards are narrowed rather than relaxed.** The
  existing assertion — no executor module performs a save or delete — stays; it gains exactly one named
  exception. Authorisation becomes a single auditable point instead of an unenforced area. `hit.test.ts`'s rule
  (only `cdp.ts`/`hit.ts` may call `clickAt`) is the precedent being copied.

- **Deletion is issued against the bill's internal id, not by clicking a row in a list.** Picking the wrong row
  in a UI list deletes the wrong bill; an API call naming the bill cannot. This is the one place where DOM driving
  is least defensible, so it is the first place to leave it.

- **The write transport is not decided here.** Whether the fill itself moves from DOM typing to the WebAPI is
  open pending measurement; V-60 records what is already known (reads work on the session cookie alone; `View`
  and its family take `[formId, dataJson]`; `RequestAmount` — the 申请报销金额 column whose ~260ms model lag
  causes V-59's lost writes — is a plain assignable field over the API). The owner authorised a **read-only**
  feasibility probe and no write request has been sent.

## Considered Options

- **Keep ADR-0028 unchanged and accept that unattended runs stop at an unsaved form.** Rejected: the run cannot
  end without a person, which is the requirement.
- **Go all the way to 提交.** Rejected: it hands the irreversible step to the machine and puts recovery inside an
  approval workflow. 暂存 is the last point that is both reachable unattended and retractable.
- **Prove ownership from the local ledger alone.** Rejected: the window between a successful save and the ledger
  write is exactly where a crash produces an unownable orphan, and a rebuilt store loses ownership of every bill.
- **Delete by clicking 删除 in the ERP list UI.** Rejected: the selection is positional, and a mis-selected row
  destroys a real voucher.
- **Relax the never-click assertions.** Rejected: a permission spread across a module is not auditable. One
  gateway, one exception, one test.

## Consequences

- ADR-0028 is superseded for the unattended path and stands for the attended one; its status line says so.
- A local record of "ERP documents this app created" becomes load-bearing. Today `billNo` exists only inside
  event JSON, never as a first-class column, and there is no inventory of created bills — that gap has to close.
- ADR-0026 (收票占用 is not terminal) gets a second, cleaner recovery route: delete the draft rather than rely on
  re-import overwriting its 收票单.
- The delete gateway needs its own live verification before it is trusted, and the first such run must be on a
  bill baox itself created in a test project — never on an existing one.
- ADR-0025's promised oxlint click-boundary rule is still unwritten; with deletion entering the codebase it stops
  being a nicety.
