# Invoice consumption begins at the import click, not at upload

For months the corpus held that sending an invoice into the 发票助手 (invoice assistant) consumes it.
`GLOSSARY.md` said so directly — "上传这一步消耗发票" — and the fill-detail issue set repeated it. The
consequence was expensive: a 排练 (rehearsal) that exercised the `DataTransfer` upload route would need
"an invoice nobody cares about", and no such invoice exists. That unmet requirement blocked the rehearsal
harness, and the harness is in turn a precondition for ever spending the one real sample on a live save-run.
The blockage was an artefact of the wording.

Decided in a grilling round on 2026-09-19. No issue was opened for it: a grilling round ends with a
consensus summary, and only a user-invoked `/to-spec` turns that into a spec.

## The boundary is one click later than we said

Two recorded live observations put it beyond doubt, and both were already in the corpus:

- `docs/research/erp-expense-flow/verification-ledger.md:90` (V-45, round 3) — a 曹操出行 invoice was uploaded,
  recognised and selected (`checked=true`, hard evidence), then the import click produced nothing: the 收票网格
  stayed at its total row. Result recorded at the end of the row: the invoice "已进发票无忧票池且**未绑定任何
  单据**，可直接复用".
- `docs/research/erp-expense-flow/save-contract.md:437-441` — an import rejected as `重复报销，禁止导入`
  left "收票网格没长行、明细网格没动，**发票也没被消耗**".

Upload and recognition are free and repeatable. What consumes an invoice is the click on 「发票导入单据」
that writes a row into the 收票网格 (receipt grid) — the same click that creates the ERP-generated 收票单
number. The old wording said 导入 but surrounded it with 上传, and the looser reading is the one that
propagated.

## Decisions

- **The consumption boundary is the import click.** `收票占用` (receipt occupancy) is the new term for the
  resulting ERP-side state, and it is distinct from `发票占用` (invoice occupancy), which is baox's own
  bookkeeping and is released by 任务作废. baox does not release 收票占用 and has no means to: deleting the
  bill and 申请解绑 are both on the never-click list.
- **排练 stops at that click.** Filling, read-back, upload and recognition are all inside the rehearsal and
  all free, so the rehearsal is infinitely repeatable. Crossing the click belongs to the live run. No third
  instrument sits in between.
- **`uploadAndImportInvoices` splits in two.** `server/src/erp/executor/steps.ts:156-190` currently welds
  `setFileInputFiles` to the import click in one function that calls itself "THE import mutation". It becomes
  `uploadInvoices` (no side effect, rehearsal-safe) and `importInvoices` (the one mutation). The seam is the
  consumption boundary, deliberately: giving the irreversible step its own function turns "the rehearsal must
  never call it" into something an oxlint boundary rule and a test can hold, rather than a comment someone
  eventually ignores.
  *Implemented 2026-09-19* as `uploadInvoices` / `importInvoices`, with `attempt_started` moved into the seam
  between them. Until then the attempt was recorded when the assistant opened, which is earlier than this ADR
  asks for: a run that failed while uploading — consuming nothing — was still recorded as having written to the
  ERP, and the task it belonged to could never be 作废 again. The oxlint boundary rule named here is still to do.
- **收票占用 is persisted before the import click**, not after it — the same discipline `attempt_started`
  already follows in ADR-0016. If the run dies mid-import the invoice is still recorded as consumed. The error
  direction is conservative: wrongly retiring a free invoice costs one invoice, while wrongly believing a
  consumed one is free costs the 未保存·已导入未写明细 breakpoint.
- **baox's knowledge of 收票占用 is permanently partial.** An invoice reimbursed on paper, or by someone else,
  is occupied in the ERP with nothing in baox to show it. baox can never guarantee an invoice is free, so
  未保存·已导入未写明细 is an expected outcome rather than a fault, and ADR-0024's copy for that breakpoint
  must not read like a malfunction.
- **The transport probe uses a synthetic fixture.** `fixtures/generated/m05-caocao-invoice.pdf` carries a
  fabricated 发票号码 and seller, so the assistant will reject it — and a rejection still proves the bytes
  reached the file input and the control fired, which is the whole of what the `DataTransfer` route needs to
  demonstrate. Sending fabricated data to the third-party assistant at `piaozone.com` is also cleaner than
  sending a real invoice there.

## One limit on "infinitely repeatable", and an open question inside it

The corpus contradicts itself on whether the 发票助手 can be reopened in the same page instance, and the
rehearsal's repeatability depends on the answer:

- `verification-ledger.md:90` (V-45, 2026-09-05) records it as a hard constraint — after 「发票导入单据」 closes
  the assistant, clicking 「选择发票」 again pops the Kendo window but the iframe never loads, and the only known
  recovery is a page refresh, which on this ERP drops the login.
- `save-contract.md:621` (2026-09-11, drawn from 18 rounds) records the opposite — "重开助手可以：同一页面实例里
  导入真票之后放弃单据、换新单再开助手，照常加载并能再次导入".

The later record wins on both recency and sample size, so the rehearsal is planned as repeatable within one login.
But note what neither record covers: both describe reopening *after an import*. The rehearsal's own shape — upload,
never import, abandon the bill, reopen — has never been observed. It is cheap to find out, because finding out
consumes nothing, and it is the first thing the rehearsal harness will establish. Until then, "infinitely
repeatable" is the expectation, not a verified property.

## Consequences

The "non-renewable sample" framing is downgraded, not the safety rules that grew out of it. baox still never
deletes a bill, never requests an unbind, and never replays an import. But the claim that a live save-run
binds its invoices *irreversibly* was a baox-side replay prohibition that hardened into an assertion about
the ERP, and the corpus actually contradicts it: `save-contract.md:446` states that 重复报销 is reversible
once the holding bill is deleted, and the 2026-09-11 save re-imported previously-imported invoices with the
ERP reporting 「已存在对应的收票单…已进行覆盖」. No deletion experiment has ever been run, so this is
unsettled rather than decided — deleting draft `FYBX20260911000011` by hand and re-checking its four invoices
would settle it at zero cost, since those invoices are already spent.

The three preconditions before a live save-run stand unchanged, but on a different footing: not "the sample is
precious, so be careful", which may not survive the experiment above, but "the rehearsal is now free, so there
is no reason to skip it". A correct rule defended by a failing argument does not stay defended.
