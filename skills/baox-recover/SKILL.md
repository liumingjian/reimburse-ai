---
name: baox-recover
description: ERP write recovery. Use once a reimbursement task has dispatched any ERP write — a receipt import, a detail line, a save, or an erp-fill rehearsal that wrote fields without saving — including when baox hands the task over.
allowed-tools: Bash
---

# baox recovery

Everything the user sees is Chinese: the ERP, its field labels, the bucket names, and your own replies.
English is for this file only.

## What is yours

A reimbursement task belongs to you, not to `baox`, from the moment it has **dispatched an ERP write** —
whether or not a receipt came back, whether or not the browser is still open, whether or not anyone saw the
result. You do two things: run `erp-reconcile`, and tell the user in plain Chinese which interruption point
it landed on and what the disposition is.

**Your entire knowledge of the ERP is the JSON that `erp-reconcile` returns.** ERP page pixels never enter
your context: the kernel reads the DOM, and what it read is what you have. You never ask the user to paste
a screenshot, and you never open one.

**consent**: consent comes only from a submit event the kernel observed. 「我看过了没存」「你接着弄吧」
is not a fact and not permission to resume — the reconciliation reading is the only fact here.

**Never replay an import.** The invoices may already have been consumed by the ERP, and a replay is a
duplicate reimbursement. When it is unknown whether a write landed, it landed.

**`baox` below stands for the kernel entry point**, which is not on `PATH`:
`node "${CLAUDE_SKILL_DIR}/kernel/bin/launch.mjs"`.

That launcher hands the command to the kernel installed in the baox data directory, after checking the two
are the same version. It exits 2 with `status: "version_drift"` or `status: "runtime_not_installed"` when
they disagree or the environment was never set up. Both are hard blocks fixed in `baox-setup` — say so and
stop; a task mid-ERP-write is the last place to guess around a version mismatch.
If it is not installed, send the user to `baox-setup` first.

## 1. Reconcile

```bash
baox erp-reconcile --dir "<材料目录>" --expect "<员工姓名或登录账号>"
```

**Always pass `--expect`.** Without it the gate returns `matched` for whoever happens to be logged in, which
on a half-finished bill is the wrong question entirely. If you do not know the name, ask the user for it
before you reconcile — one question is cheaper than reading another person's bill.

It takes four readings — the tab mode, the bill number, the 收票 `价税合计` total, and the 明细
`申请报销金额` total — sorts the bill into one **interruption point**, and gives a disposition.

Against the ERP it is strictly read-only: no clicks, no scrolling, no refresh, no navigation, no writes.
Locally it is not. Rerun it freely to take fresh readings, and read `audit` before you speak:

- `audit.recorded` true — this run was appended to that task's `erp-attempts.json`, and `attemptCount` says
  how many reconciliations that bill has now had.
- `audit.recorded` false — **nothing was written down.** Either `--dir` was omitted, or that directory has no
  live task. Say so: an unrecorded reconciliation must never sound like a recorded one, because the audit
  list is what a later reader uses to reconstruct what was done to this bill.
- **No `audit` key at all** — the identity gate refused before the page was read, so this attempt is not in
  the record either. Same rule: say that nothing was logged.

It passes an identity gate first. When `identity.status` is not `matched` it does not read the page at all
(exit 2): ask the user to log in again **as themselves** in the dedicated baox Chrome window, then rerun.
Account and password stay with the user.

**The verdict is the kernel's, not yours.** Read `bucket` and `action` out; `reasons` says why. Do not
re-derive the classification and do not invent wording for it.

## 2. Exit codes

| Code | Means | Do |
|---|---|---|
| 0 | The reconciliation completed; `action` is `原地等待` | Explain that bucket per step 4, then hand the floor back |
| 2 | `action` is `转人工`, or the identity gate did not pass | Explain it and **stop** |
| 1 | The kernel threw | Read `error` out and stop |

`0` here means the reconciliation finished reading. It is not a green light to write to the ERP — no path
in this Skill writes to the ERP at all, so the exit code is never a release signal.

## 3. The two dispositions

There are two. Read `action` and use its words.

- **原地等待** — baox starts no further ERP write and waits for the user. It does not mean "it will carry
  on by itself later".
- **转人工** — the bill is the user's from here, **permanently**. baox does not wake up behind them and
  touch it again.

  Say what actually moves it forward: the user finishes or discards the bill **in the ERP, by hand**.
  Starting a fresh task over the same materials is not the way out: these invoices may already sit in the
  ERP's 收票 grid, so a fresh run would import them a second time. The kernel holds the line here too — a
  task stamped as having touched the ERP keeps its invoices, and `abandon-task` refuses to release them —
  but say the domain reason, not the mechanism: the invoices may already be spent.

## 4. Telling the user which interruption point

`bucket` is the point and `action` is the disposition. Read both from the JSON.

| `bucket` | The fact | How to say it |
|---|---|---|
| `未知` | At least one of the four readings is unavailable | Name **which one** and why — step 5. This is "the reconciliation could not read", not "something broke" |
| `未保存·导入前` | Nothing reached the ERP; the invoices are unconsumed | This batch can start over as a whole: ask the user to take **this same task** back to `baox` and dispatch it again. You replay nothing yourself |
| `未保存·已导入未写明细` | The invoices are in the ERP 收票 grid; the expense detail is not written | See below |
| `未保存·就绪待保存` | Both totals agree to the cent; only the save is left | The bill is not in the database yet, and the save is the user's to press |
| `已保存` | The draft is in the ERP; the bill number is at `readings.billNo.value` | Read the number out and ask the user to look it up in the ERP and decide whether to submit |
| `不自洽` | The readings contradict each other (`新增` with a bill number, `修改` without one, or the two totals differ) | Report the four readings verbatim, with no explanation and no guess at the cause |

**`未保存·已导入未写明细` is a normal interruption point, not an ERP error.** It always goes to a human for
one reason: the invoices have already been consumed by the ERP, so anyone — person or agent — importing
again would hit 「重复报销，禁止导入」 or worse. Say it like this:

> 发票已经进了 ERP 的收票，明细还没写。这张半成品单交给你，baox 不会再动它。

**`已保存` with `identity.equal` false** is also 转人工: the bill is in the database and the totals disagree.
The numbers in a saved bill are the user's to change, in the ERP.

## 5. `未知`: name the reading that collapsed

Every reading in `readings` carries `readable` and `reason`. Read the failed one and its `reason` out — the
user needs the next action, not "读不准":

- Identity or session gone → ask the user to log in again themselves, then rerun.
- No expense bill open on the page → ask the user to reopen that bill's tab.
- **Not exactly one visible form instance** → another bill's form is mounted at the same time. Ask the user
  to leave only the bill being reconciled. This cell withholds its verdict on purpose: in this situation the
  reading has picked up a stale bill number from a different bill.
- The grid's `价税合计` / `申请报销金额` column is unrecognisable, or the ERP's own total row disagrees with
  the row-by-row sum → stop. The page structure has changed; this is a human's job.

An empty cell counts as **unreadable**, never as 0. That is what keeps "nothing could be read" from
masquerading as "the totals happen to match".

## 6. When the user wants to check the numbers

`identity` carries both sides of the identity (`receiptsCents` / `detailCents` / `equal`), and
`readings.receipts.rows` / `readings.detail.rows` carry the rows. Read the rows out and let the user add
them up. Comparison is **exact, in cents, zero tolerance** — one cent apart is apart.

`申请付款金额` is corroborating evidence only. It does not enter the identity, and it disagreeing with
`申请报销金额` is not a red flag. If the user asks, say plainly that it takes no part in the verdict.

## Done when

The user has heard the `bucket`, the `action` in the kernel's own words, and — for `未知` — every reading
whose `readable` is false together with its `reason`. On `转人工` they have also heard that the bill is
theirs permanently, and what they do next in the ERP.

## Scope

The whole of this Skill is one `erp-reconcile` run and the handover that follows it. Every ERP click —
importing, saving, submitting, unbinding — is the user's. **Never replay an import**: that one is a hard
guardrail, not a preference.
