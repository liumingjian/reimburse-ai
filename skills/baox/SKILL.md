---
name: baox
description: Reimbursement main flow. Use when the user wants to start or continue a reimbursement from a folder of invoices and itineraries, or when baox-recover hands a 未保存·导入前 task back. Covers everything up to the first ERP write.
allowed-tools: Bash, Read
---

# baox — reimbursement main flow

Everything the user sees is Chinese: the ERP, its field labels, the open-item names, and your own replies.
English is for this file only.

## Entry gate: has this task already dispatched an ERP write?

Before running any command here, check whether this task has already dispatched an upload, a receipt import,
a detail line, or a save. **If it has, the bill is not yours** — hand it to `baox-recover`, which reconciles
it read-only and tells the user where it stopped. Whether a receipt came back, whether the browser is still
open, and whether anyone saw the result make no difference to ownership.

You do not replay the import, re-save, or refresh the page to "see whether it went through". When it is
unknown whether a write landed, it landed — the same rule that decides 「占着」 in step 6.

`probe` and `catalog` (step 10) are read-only and **do not** count as a write attempt. A task that has only
run those is still yours.

**One exception, and only this one.** When `baox-recover` has just reconciled the task and reported bucket
`未保存·导入前`, that reading is the evidence that nothing reached the ERP: the invoices are unconsumed and
the batch is yours again. Take it from step 1. Anything weaker — the user saying it did not go through, your
own memory of the run, a browser window that looks empty — is not that evidence, and the task stays
`baox-recover`'s. Nothing in the kernel records this handback, so it holds for the reconciliation you were
just handed and not for a task you find in this state later; in that case reconcile again first.

## What you do

Three things: run the kernel commands, read the kernel's JSON back to the user in plain Chinese, and turn
the user's corrections into structured kernel input.

The kernel decides. You do not classify a material, and you do not derive, average, pro-rate, or invent any
amount. **Nothing the user says in chat is ever a business fact** — facts come from what the kernel read and
from what the local web pages received.

**consent**: consent comes only from a submit event the kernel observed. 「没问题」「继续」「对的」 in chat
never clears an open item, ticks a reading, allocates a segment, or picks a project. This word governs
steps 5, 8 and 9.

**`baox` below stands for the kernel entry point**, which is not on `PATH`:
`node "$HOME/Library/Application Support/baox/runtime/bin/baox.mjs"` (Windows: `%APPDATA%\baox\`).
If it is not installed, send the user to `baox-setup` first.

Exit codes: `0` continue / `1` **the command did not complete** / `2` **an open item or a hard block is
unresolved — do not continue**.

On exit 1, the JSON says which kind it was, and they need opposite responses:

- an `error` key — the kernel threw. Read it out and stop.
- a `status` key instead, `timeout` — a local page (`confirm-readings`, `allocate`, `select-task`) waited for
  the user's submit and did not get one. Nothing is wrong; say so and run the command again.

## 1. Material intake

```bash
baox intake --dir "<材料目录>"
```

The kernel only reads that directory: **no moves, no renames, no overwrites, no deletions**. Everything it
produces goes to the task workspace.

Three things in the result are worth telling the user:

- `task.resumed` true means this directory already had an unfinished task and the kernel resumed it rather
  than starting another. One directory, one task.
- `inventory.isNewVersion` true with a non-empty `supersededVersionId` means the materials changed and a new
  inventory version exists. Treat the old ERP readiness snapshot as void and redo the confirmations. Do not
  wait to be told: the kernel's automatic fallback keys on the **shape** of the candidate lines (line id,
  voucher material, date, city, total), not on the inventory version, so swapping in a different invoice
  with the same date, city and total leaves the old confirmation standing. After any material change, rerun
  step 10 rather than trusting `projectSource` to have fallen back on its own.
- `inventory.ignoredCount` counts OS junk (`.DS_Store` and friends). They are not user materials, but they
  were not silently dropped either — say so if the user asks.

## 2. Explaining intake open items

Every entry in `openItems` gets said, **split into two groups by `blocking`**.

| kind | Means | What the user can do |
| --- | --- | --- |
| `unsupported_format` | Not PDF/PNG/JPG (v1 supports those three) | Re-export it, or take it out of the folder |
| `empty_file` | 0 bytes | Export the material again |
| `read_error` | Unreadable | Check permissions, check whether it is corrupt |
| `symlink` | A symlink; the kernel does not follow it (it would leave the material root) | Copy the real file in |
| `extension_mismatch` | Extension disagrees with the content (non-blocking) | Usually nothing. **Content wins** — tell the user which kind the kernel went with |
| `duplicate_content` | Several paths hold a **byte-identical file** (non-blocking) | Just report it. This is not a duplicate invoice — invoice identity decides that, one layer up |

When `readyForNextStep` is false, ask the user to add, remove, or replace files **in the original material
directory**, then run intake again. The local web offers no upload, and you do not edit the task workspace.

## 3. Role triage and invoice parsing

```bash
baox classify --dir "<材料目录>"
```

This reruns intake first (it is idempotent). If the intake layer still has a hard block it returns
`stage: "intake"` and stops — clear step 2 first and come back.

Each material then gets a `role`:

| role | Means | Consequence |
| --- | --- | --- |
| `primary_voucher` | The reimbursement voucher itself (the invoice) | Carries invoice identity, issue date and three amounts; only these reach the ERP upload list |
| `reference` | Supporting material (itinerary, hotel folio, …) | **Not an invoice**, never uploaded, evidence only |

Three things to keep straight when reporting:

- `invoiceNumber` is **masked**. The full number lives in the task workspace, and there is no reason to read
  it out.
- `amountCheck` `balanced` means the face satisfies 不含税 + 税额 = 价税合计; `partial` means the face never
  carried those parts (a railway e-ticket is like this).
- Everything in `candidates` is a **candidate**, not a parsed value. `buyerTaxId`, for one, is inferred from
  its position on the face and does not mean the buyer has been verified.

## 4. Explaining triage open items

| kind | Means | What the user can do |
| --- | --- | --- |
| `image_awaiting_reading` | An image has not been read yet | Step 5 |
| `reading_awaiting_confirmation` | Read, but not yet confirmed by the user | Run `confirm-readings` |
| `reading_stale` | The image changed; the old reading is void | Read it again |
| `image_unreadable` | Even looking at it, the face cannot be read | Ask for a clearer original |
| `no_text_in_pdf` | A PDF with no text layer, usually a scan | Ask for the electronic original |
| `kind_unrecognized` | A PDF with text, but not a kind v1 supports | Check whether it belongs in this reimbursement |
| `identity_incomplete` | An invoice whose 20-digit number cannot be read | Ask for a complete original. **Invoice identity is never supplied by conversation** |
| `issue_date_missing` | No issue date | As above |
| `amount_mismatch` | The three amounts on the face do not balance | Check the original. Do not produce a number that "works" |
| `amount_missing` | A required amount such as 价税合计 is missing | Ask for a complete original |
| `amount_not_on_face` | The face never carried net and tax (non-blocking) | Nothing to do; confirmed later from the ERP receipt readback |
| `duplicate_invoice` | Several materials point at **one legal invoice** | Remove or replace a material. There is no "confirm and continue" here |
| `no_primary_voucher` | Not one primary voucher in the folder | This folder is not a reimbursement; check it is the right one |

`duplicate_invoice` and intake's `duplicate_content` are different things: the first is **legal duplication**
by invoice number and holds even when the bytes differ; the second is only "these files are identical".

## 5. Reading image materials

When step 4 shows `image_awaiting_reading`, `reading_stale`, or `reading_awaiting_confirmation`, read
`references/image-reading.md` and follow it. Done when the work order is empty and the user has submitted the
confirmation page; then rerun `classify`.

## 6. Cross-task duplicate invoice check

Once the materials are clean, the kernel compares these invoice identities against **the other tasks baox
has recorded on this machine**.

```bash
baox history --dir "<材料目录>"
```

It also gates `events`, `select-task` and `lines`: a hit stops the whole batch.

| Open item | Means | How to say it |
| --- | --- | --- |
| `duplicate_across_tasks` | This invoice is in another task, and that task still holds it | Blocking. **No "confirm and continue"**: either remove the invoice from this batch, or confirm that the other task is genuinely not being filed and abandon it |
| `history_scope_local` | The scope of the comparison (non-blocking) | Say it every single time, see below |

**「占着」 has an exact definition**: the task is still open, or it has touched the ERP (including with an
unknown write result). The second kind **cannot be released by abandoning** — when it is unknown whether a
write landed, it landed.

Only once the user confirms the other task is not being filed:

```bash
baox tasks
baox abandon-task --task <taskId> --reason "<为什么不报了>"
```

Abandoning is a status change, **not a cleanup**: the task workspace is left intact. Ask the user first.
A task in the way may be another batch someone is still working on.

`abandon-task` can come back `verdict: "rejected"` at exit 2, and the reason decides where you go:

- **The other task has touched the ERP.** Its invoices are not yours to release, and no wording releases
  them. That task belongs to `baox-recover` — say so, and stop. This batch cannot proceed over those
  invoices until the other bill is settled in the ERP.
- Any other reason (no such task, wrong status) is a hard block too: read it out and stop.

**Say this every time: having checked is not the same as not having been filed.** The kernel only knows
baox's own records on this machine. Anything keyed directly into the ERP, filed by a colleague, filed on a
previous computer, or filed before the baox data directory was deleted is invisible here.
`readyForNextStep: true` only means baox has not seen it twice.

## 7. Expense events and candidate lines

```bash
baox events --dir "<材料目录>"
```

This turns materials into **expense events**: one thing that actually happened. Transport goes by
identifiable leg, consecutive lodging by one continuous stay, a train ticket by the ticket. An event has
exactly one primary voucher and zero or more reference materials, and projects into one **candidate line**.

`events` reruns intake and triage first and stops at whichever layer still has a hard block.

Report three things per event:

- **When and where it happened, and from which material** (`date` / `city` / `route` / `dateEvidence`).
  The issue date is **not** the date the expense happened — a railway ticket uses the travel date, a
  ride-hail invoice the pickup date, lodging the check-in date. When it cannot be read the kernel blocks
  with `event_date_missing`; the issue date does not stand in for it.
- **Where the amount came from** (`amountSource`): `invoice_face` is printed on the face, `user_allocation`
  came from the user segment by segment.
- **Why it split into these segments** (`splitBasis` / `splitNote`). A split needs evidence: `itinerary_rows`
  means the itinerary listed them; `no_itinerary` means there was no corroboration and it is one trip.

`reconciliation` is each invoice's balance check: the segments must sum back to the face's net, tax, and
total. A railway ticket's `not_on_face` is a fact about the face (it only carries a fare), not a failure.

Reference materials under `evidence.unlinked` matched no invoice — **non-blocking**, but tell the user: it
may belong to a different reimbursement, or the matching invoice may not be in the folder yet. That call is
theirs.

## 8. Allocating a combined transport invoice

The kernel routes two hard blocks to the same page: `allocation_required`, when one transport invoice covers
several segments, and `allocation_stale`, when the invoice file behind an existing allocation changed. Read
`references/allocation.md` and follow it for either. Done when `events` reports `readyForNextStep: true` with
no allocation item left.

## 9. Category and project

Once the material layer is clean, a candidate line is still missing three things, **from three different
sources that never mix**.

**The expense category is derived by the kernel, not asked of the user.** Lodging depends on whether a hotel
folio is linked; railway tickets go to long-distance transport by ticket kind; city transport splits into
local and non-local by comparing the city of the expense with the resident city. The basis is in
`categoryBasis` — read it out if asked. When it cannot be derived the kernel blocks
(`category_undecidable` / `category_city_missing`), and the call stays the kernel's. "It looks like lodging"
is not a derivation.

**The resident city, the reimbursement reason, and each line's project come only from the user's submission
on the task selection page.**

```bash
baox select-task --dir "<材料目录>"
```

The page allows multi-select and filling one project number into many rows at once. 「项目都填 111454」 in
chat does not count and you cannot fill it in for them — same **consent** rule as reading confirmation and
allocation.

```bash
baox lines --dir "<材料目录>"
```

`lines` gives the final shape of the candidate lines. Three things to keep straight:

- **All four categories carry an `expenseItemCode`, from different sources.** Lodging `FY010001`, local city
  transport `FY008001`, and long-distance transport `FY010003` have been saved and read back on the real ERP
  (`source: erp_save_readback`). Non-local city transport `FY010002` comes from the company's own reference
  table (`source: user_declared`) and has never been saved as a detail line, so those lines carry a
  **non-blocking** `expense_item_unconfirmed`. It does not block, but **after the first draft save, check the
  expense item the ERP reads back**; if it disagrees, stop and ask. Never guess a code, and never substitute
  one category's code for another's. (All four exist in the ERP master data — step 10 — but "the master data
  has this record" and "a detail line saves under it" are different claims.)
- **A project number is unverified until it is checked.** `projectSource: user_input_unverified` is a fact;
  it becomes `erp_catalog_confirmed` only after step 10.
- **Change a line and the selection goes stale** (`task_selection_stale`). Reallocating a combined transport
  invoice means selecting again.

## 10. Read-only master-data verification

This needs the ERP logged in as **this** user, so probe first. Always pass `--expect`:

```bash
baox probe --expect "<员工姓名或登录账号>"
```

Without `--expect` the probe only reports that *somebody* is logged in — it returns `matched` for any
identity, and `mismatched` can never come back. That is not the check you want here.

Only `status: matched` continues. `not_logged_in` is the common one — **ask the user to log in themselves**
in the dedicated baox Chrome window. Account and password stay with the user, and an `account` in the output
does not mean logged in (the login page shows the last account too). `mismatched` is a hard block: someone
else is in this ERP session, and nothing in this flow may run under their identity.

Then verify:

```bash
# the four expense item codes in the reference table, plus every project number this task selected
baox catalog --dir "<材料目录>" --expect "<员工姓名或登录账号>"

# asking whether one project number exists — note this still checks all four expense items first,
# so unrelated expense-item drift can make even this call exit 2
baox catalog --project 111454
```

It goes through Kingdee's own read-only query service: **no bill is opened, no picker is clicked, nothing is
written.** Exit 0 means everything passed, and those lines' `projectSource` rises to `erp_catalog_confirmed`
with the project names in the output — **read the project names to the user** so they can confirm it is the
project they meant. A number alone shows nothing.

Exit 2 covers several cases, and they are not interchangeable:

| Case | Means | Do |
| --- | --- | --- |
| project `missing` | No such number in the ERP project catalog | Ask the user to rerun `select-task` with a real project number |
| project `ambiguous` | One number matched several records | baox does not pick. Ask the user |
| `unusable` | The master data is disabled or unapproved | Stop and ask. Do not switch to another code |
| expense item `name_mismatch` | Code matches, name does not | **Stop.** The repo's reference table and the ERP have drifted apart; a human checks this. Do not adopt the ERP's name and carry on |
| `queryFailures` non-empty | The query itself failed | This is "not verified", not "verified". It is not a pass |
| A `note` with no `problems` and no `queryFailures` | This task has not run `select-task`, so there is no project number to check | Go back to step 9 |

**Verification decays, but not on everything.** It is keyed by project number and bound to a fingerprint of
the candidate lines — line id, voucher material, date, city, total. Change a project number or reallocate an
invoice and `projectSource` falls back to `user_input_unverified` on its own. Replace an invoice file with
one carrying the same date, city and total and the fingerprint does not move, so the old
`erp_catalog_confirmed` survives a change it should not have survived. **Rerun `catalog` after any material
change**, and quote only the result of that run.

## Done before any ERP write

All of these hold at once: the latest `lines` reports `readyForNextStep: true`; `catalog` passed with exit 0;
and rereading `lines` shows every project's `projectSource` as `erp_catalog_confirmed`. Anything short of
that is not ready — name what is missing instead of reporting the batch as done.

## What this flow does not do yet

Querying records that already exist in the ERP, uploading invoices, and saving a draft are **not wired into
this flow**. Say so plainly when asked.

The kernel does carry `erp-fill`, a rehearsal that writes fields on a bill page without saving. It is not
part of the steps above, and running it makes the task `baox-recover`'s by the entry gate at the top.

The duplicate check covers this task and the other tasks baox recorded on this machine (step 6) and
**cannot see the ERP**. An invoice filed last year, or by a colleague, produces no reaction here.
`readyForNextStep: true` does not mean these invoices have never been reimbursed.
