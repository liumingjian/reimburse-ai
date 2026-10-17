# Real dining QA repair

Bug [#370](https://github.com/liumingjian/reimburse-ai/issues/370) follows spec [#356](https://github.com/liumingjian/reimburse-ai/issues/356). The supplied folder contains two dining VAT invoices and one sideways receipt photograph. Production parsing initially recognised none. After the repair, all three are recognised and all 21 independently transcribed face fields match. Originals, private expectations and actual-task screenshots remain outside Git.

## Ownership and behavior

The VAT item mapper accepts the dining child of the printed production/living-services parent class with a strict item-row boundary. The e-invoice parser version is 4. The receipt parser version is 2 and reads an explicitly printed paid label across columns using aligned text centers. It distinguishes absent labels, unreadable labels and values. Every occurrence of the highest present paid-label family must be readable and agree. It never computes payment from the total and discount.

The image reader rotates an entire flattened sideways page in both quarter-turn directions, reads both, and chooses by character-weighted OCR confidence. Returned observations and geometry come from the chosen page. Temporary image matrices are released. Upright pages retain their existing path. Shared rows, paper detection, hotel parsing and exact-cent material pairing are unchanged.

The existing QA task contains an additional photograph absent from the supplied folder. Its paper quadrilateral includes the background and warps amount rows. This separate defect is [#371](https://github.com/liumingjian/reimburse-ai/issues/371). Its captured geometry is retained as an explicit unrecognised case. It is excluded from the positive private accuracy gate. An initial positive expectation and provisional aliases for that photo were withdrawn when the runtime paper diagnosis disproved their safety.

## Regression and review evidence

The original parser and actual-OCR regressions were committed red at `7acb293` before implementation at `af47753`. The initial targeted run had 23 failures and 66 passes; the fourth-photo expectation was subsequently superseded by the documented #371 negative scope. Captures preserve all observation geometry and order, with synthetic text and QR replacements.

Independent review found that a paid label beside a complete table field was skipped, incorrectly selecting a lower-priority total. Synthetic expected payment `530.00` produced `600.00`. Red regressions at `0369f0a` preceded the first repair at `9809057`. Closure review exposed the same failure when the preceding field was split into OCR observations. The root reproduced that variant before the final repair. The obsolete full unit run on `9d91976` was interrupted and is not counted as passing.

Ten contract goldens and the preset data update parser-version metadata only. The contract diff changes 110 version leaves from 3 to 4. Captured observation counts and geometry remain 57, 57, 154 and 81.

The final checkpoint below identifies the reviewed code and gate results.

## Local QA and limits

The dev instance runs at `http://127.0.0.1:5173/` with persistent QA data. Actual browser reprocessing recognises the supplied three materials, pairs the equal-amount invoice and receipt, and leaves the other invoice awaiting a receipt. The extra warped photograph remains unrecognised. No human answers or financial writes were supplied by the agent.

Private verification is scoped to these three originals and 21 fields. It does not complete [#365](https://github.com/liumingjian/reimburse-ai/issues/365), which requires more real invoice/receipt pairs. Live ERP save/readback remains [#366](https://github.com/liumingjian/reimburse-ai/issues/366). Existing intermittent hotel e2e diagnosis remains [#369](https://github.com/liumingjian/reimburse-ai/issues/369).

## Decisions and audit

The canonical [decision trail](decisions.tsv) records the diagnoses, superseded fourth-photo scope, review counterexamples and gate results. Maintainer-local evidence is under `/tmp/reimburse-dining-qa/`.

- Fix Root Causes places the invoice, receipt and orientation repairs in their existing owners.
- Model the Domain and Type System Discipline represent amount reading as absent, unreadable or a value with its evidence runs.
- Exhaust the Design Space compares three ownership-local designs before selecting the Sol design with duplicate-label and matrix-lifecycle safeguards.
- Attack the Premise replaces the disproved single-observation field-boundary assumption with a split-invariant scalar-field boundary.
- Prove It Works requires actual original bytes, independent face expectations and the existing browser task before readiness.

Independent reviewers use the configured GPT models. A different model family is unavailable in this runtime.
The final independent trail audit by `gpt-6.1-sol` returned **No new flags** for the QA follow-up rows.
It checked only the authorized root transcript and produced artifacts. It verified both red-first review repairs,
the superseded fourth-photo scope, the interrupted obsolete gate, matching final code markers and all passing totals.
The full maintainer-local report is `/tmp/reimburse-dining-qa/trail-final-audit.md`.

## Final checkpoint

The frozen code revision is `c42a80e949028a4fdf024f0e8b27bedbe07a941b`. The final scalar-boundary regressions were committed red at `446ef27`, with nine failures and 60 passes, then fixed at `67d333f`. All 649 related tests pass, including 69 receipt cases. `c42a80e` removes one redundant comment and names the scalar-field grammar explicitly. A fresh comment audit has no remaining findings or suppressions.

| Final command | Result |
| --- | --- |
| `pnpm typecheck` | Passed |
| `NODE_OPTIONS=--max-old-space-size=8192 pnpm test` | Lint and all 1,607 unit tests passed |
| `pnpm test:e2e` | All 378 mock and server browser tests passed |
| `BAOX_PRIVATE_CORPUS=<local supplied-three corpus> pnpm test:private` | All gates met for the three supplied originals and 21 face fields, each at 100% |

Unit totals are contract 17, erp-executor 207, deploy/operator 70, extension 73, web 313 and server 927, including real OCR. All broad runs are serial on the native Mac. The existing 8 GB verification heap setting is unchanged. Main remains `094732d561991f95d211a0ccb2429e5ad631a786`; its prior 377-pass browser baseline remains applicable.

Independent [Spec closure](qa370-spec-review.md) at this frozen revision reports zero unresolved correctness findings.
[Standards closure](qa370-standards-review.md) also reports zero actionable findings or remaining baseline smells.
The reviewers ran no tests or OCR. The root reran the split-field counterexample and obtained the required `530.00`.

Maintainer-local final logs are `/tmp/reimburse-dining-qa/final-typecheck.log`, `final-unit.log`, `final-e2e.log`, `final-private.log` and `qa-final-result.log`. `final-code-head.txt` and `final-e2e-head.txt` identify the same frozen revision. The root refreshes the local dev mirror from the integration checkout after the reviewed code is fast-forwarded. Later commits contain review evidence only.
