# Dining implementation verification

Spec: [#356](https://github.com/liumingjian/reimburse-ai/issues/356). Integration branch: `spec/356-dining`.
Implementation tickets: #357–#364. Real materials and live ERP readback remain separate human follow-ups, #365 and #366.

## Original implementation checkpoint

The main baseline is `094732d561991f95d211a0ccb2429e5ad631a786`, with all 377 e2e tests passing.
Fetching `origin/main` again before final verification confirmed the same revision.
The final reviewed and tested code revision is `eac8f8923b9ee7a319ca0f1d392b15c19c6c6b28`.
The evidence commits immediately after that checkpoint changed this review directory only.
The later maintainer QA repair changes parsing and image orientation. Its final revision and checks are recorded in
[Real dining QA repair](qa370-verification.md).

Commands ran directly on the maintainer's Mac. This checkout has usable Git history and no `rexec` command.
Broad suites ran serially. Package parallelism within `pnpm test` remains the repository default.

| Command | Result |
| --- | --- |
| `pnpm typecheck` | Passed across all workspace packages |
| `NODE_OPTIONS=--max-old-space-size=8192 pnpm test` | Lint and all 1,548 unit tests passed |
| `pnpm test:e2e` | All 378 mock and server browser tests passed on the exact code revision above |
| `pnpm test:private` | Skipped: `BAOX_PRIVATE_CORPUS` is not set; no private-corpus accuracy claim |

The 8 GB heap is a verification setting. The baseline operator archive test exhausted the default heap; its unchanged suite passed with this setting before implementation. No production timeout or retry was changed.

| Unit package | Files passed | Tests passed |
| --- | ---: | ---: |
| contract | 1 | 17 |
| erp-executor | 17 | 207 |
| deploy/operator | 9 | 70 |
| extension | 8 | 73 |
| web | 38 | 313 |
| server, including real OCR | 84 | 868 |

Maintainer-local logs are under `/tmp/reimburse-spec-356/`: `final-root-gate-head.txt`, `final-typecheck.log`, `final-test.log`, `final-private.log`, `review-fix-final-e2e-head.txt`, and `review-fix-final-e2e.log`.
The two HEAD markers contain the identical code revision above. The full e2e log ends `378 passed (1.1m)`; the full unit log records every package's successful completion.

## Behavior and artifacts

Dining VAT invoices derive 招待费 and ERP item FY009001 with `user_declared` provenance. A complete dining receipt must match the invoice's amount exactly, in cents, with a unique invoice and receipt at that amount. Duplicate groups remain unpaired. Missing evidence, unequal amounts, and orphan receipts block progress; uploading a correct receipt does not silently discard a wrong one.

PDF receipts, discounted receipts, a one-cent mismatch, and a tilted synthetic phone photo have reproducible generated fixtures and recognition snapshots. The photo test runs through the real OCR reader and is registered in `OCR_TESTS`. These are synthetic materials.

The real-server dining browser journey uploads an invoice and receipt, verifies pairing and 招待费, switches the preview, and downloads a one-page PDF with both materials. [Screenshots and reproduction commands](README.md) show the prior unsupported invoice, both preview documents, and the composed print page. Discounted and photographed receipts have their own mock print variants.

## Independent review and corrections

Full Spec and Standards reviews covered `094732d...c8d4a53`.
The Spec review found one P2 hotel-isolation defect: the negative dining check inherited the positive extractor's 64-character span cap, so a long compound hotel observation could become ambiguous.
Standards found no documented breaches and suggested two local duplication reductions in mock pending templates and project preview controls.

One implementer handled all findings. The exact long-observation counterexample failed through actual dispatch and a hand-authored recognition snapshot, then passed as `hotel_folio/labelled` with its expected hotel fields. The first repair passed all 378 e2e tests, but independent closure review caught a second P2: a split `房号` label following another field in one visual row was missed. That counterexample also failed through actual dispatch before the final repair.

The final code checks complete observations and rows on every observed page while retaining observation-span matching. Additional regressions cover attached room values, second-page anchors, and a long split row. The existing hotel parser is unchanged.
Related server validation passed 596 tests; related UI validation passed 285 tests. The final exact-tip full gate above followed those repairs.

Independent closure review of `c8d4a53...eac8f89` passed both Spec and Standards with zero unresolved findings. The two duplication suggestions use a local typed mock constructor and one preview button/dialog selecting the existing component. Review reports and red/green logs remain in the maintainer-local evidence directory.

The comment audit removed 18 redundant lines across eight files. Required pending-code documentation and evidenced vendor constraints remain. No suppression directives were added.

## Remaining evidence limits

- [#365](https://github.com/liumingjian/reimburse-ai/issues/365): real dining invoice/receipt pairs and private-gate expectations. Synthetic OCR success does not complete this task.
- [#366](https://github.com/liumingjian/reimburse-ai/issues/366): a real ERP save and readback. No live financial write was performed here.
- [#369](https://github.com/liumingjian/reimburse-ai/issues/369): capture failure reasons for intermittent existing hotel e2e parsing failures observed during intermediate gates. The final full gate is green; the failure cause remains unproven. A parse-worker exit race is a hypothesis, not an established diagnosis.

## Decision trail

The canonical append-only [decision trail](decisions.tsv) is committed beside this report; `/tmp/reimburse-spec-356/decisions.tsv` links to that same file. Its temporary log pointers are maintainer-local. A root transcript audit and independent `gpt-6.1-sol` audit checked its rows against actions, commits, and resolving artifacts. The trail explicitly corrects an earlier unsupported CSS causal attribution: the observed preview failure still selected the invoice, and the omitted CSS was only a suspected cause. The later journey fix waits for the initial invoice render and asserts the selected receipt.

Principles that changed implementation choices:

- **Separate Before Serializing Shared State:** one writer per worktree and file; serialize broad tests on the shared Mac.
- **Model the Domain:** retain the existing material/reference model and select the preview label/component together.
- **Type System Discipline:** derive the mock constructor's inputs from `PendingTemplate`.
- **Prove It Works:** verify real OCR, actual dispatch, the browser journey, and the downloaded print PDF before readiness.

Independent audits use the user's configured GPT models. A different-model-family reviewer is unavailable in this runtime; this is an independence limit.

The final independent trail audit by `gpt-6.1-sol` returned **No new flags**. It checked the regression repairs, matching code HEAD markers, all gate totals, private-corpus skip, eight closed implementation tickets, nine removed worktrees, ready PR #368, and the parent issue's merge-pending status. The code-to-evidence-commit diff contains only this review directory. The complete initial and final reports remain at `/tmp/reimburse-spec-356/trail-audit.md` and `/tmp/reimburse-spec-356/trail-audit-final.md`; the known limits above remain open.
