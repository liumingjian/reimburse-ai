# Dining evidence follow-up verification

This follow-up implements [#372](https://github.com/liumingjian/reimburse-ai/issues/372), the maintainer's local-QA request to supplement missing dining receipts and manually associate unrecognized receipts with invoices. It extends [#356](https://github.com/liumingjian/reimburse-ai/issues/356) on the existing `spec/356-dining` integration branch and [PR #368](https://github.com/liumingjian/reimburse-ai/pull/368). Main is not merged.

## Result

The dining invoice's pending item offers `补传餐饮小票`. An orphan receipt offers `补传餐饮发票`. Normal file validation and rejection feedback apply, and any accepted supplemental material starts a fresh inventory version and run.

For an unrecognized receipt, `手工补填` offers `餐饮小票`, independently entered `实付金额`, and an optional `关联餐饮发票` selector. Typed orphan receipts can also choose their invoice. Explicit associations remain inspectable and editable before confirmation. The user can explicitly reset an association to automatic matching.

Invoice selection never fills the receipt amount. Each valid meal has one invoice and one receipt whose amounts agree exactly to the cent. Explicit choices resolve equal-amount ambiguity before unique residual automatic matching. Failed explicit choices remain visible and block completion until repaired or reset. Exclusion of the receipt releases its reservation. Hotel matching is unchanged.

## Architecture decision

Model the Domain led to one receipt-owned canonical pairing intent separate from independently filled receipt facts. A stale target cannot erase the receipt's kind or amount. A pure dining resolver owns exact matching, reservations and stale choices. The existing pending-answer ledger stores intent; event evidence remains the business association. No new relation table is introduced.

Exhaust the Design Space compared two independent canonical-intent packages and one structurally distinct embedded-answer sketch. The independent cross-judge selected the Sol package, with a smaller contract control and additional recognition-transition tests. The initial Astra candidate could not run because of an account concurrency error. The later independent Astra judge completed after the other agents were stopped. The available panel is GPT only; this is model diversity within one family.

Separate Before Serializing Shared State gave the implementation one exclusive worktree. Root owns the existing canonical decision trail. Design and review reports use separate output files. Broad suites run serially on the Mac. Prove It Works required actual user actions and snapshot reads, beyond compilation and worker reports.

## Runtime evidence

Root reproduced the missing upload control on a synthetic isolated baseline task. That pending item had exclusion only and no file input. Root then synced committed checkpoint `ae040c8` to the maintainer's running dev instance and created a separate matching dev copy at port 5174, with its own data directory and browser profile, ERP disabled, and pnpm-pinned Node 24.21.0.

The root driver uploaded the public dining invoice, supplemented a genuine synthetic unrecognized itemized receipt plus a rejected text file, and observed the rejection reason and v2 inventory. It selected the invoice while asserting that the paid input remained blank. A 240.01 receipt amount against the 240.00 invoice returned `400 check_failed` and saved neither manual facts nor pairing intent. Independently entering the receipt's printed 240.00 then produced a `user` field, a valid canonical choice, one event and one line with that receipt, reciprocal material links, and no open evidence blocker. The resolved association could be reopened for editing.

Root then synced final candidate `cb0f87f` to both dev copies and repeated the same complete flow successfully on a fresh synthetic task. The final replay is `/tmp/reimburse-dining-followup/final-runtime.js` and `final-runtime-proof.log`.

The checkpoint replay and results are local at `/tmp/reimburse-dining-followup/full-runtime.js`, `runtime-proof.log`, `resolved-proof.log`, and `runtime-after.yaml`. All materials in these artifacts are synthetic. No original/private QA task or ERP browser was changed. Early helper mistakes involved cached UI authentication after out-of-band setup, an incorrect ARIA role, and an incorrect candidate-field shape. The corrected driver passed on a fresh synthetic task; these helper errors are not feature regressions.

The first targeted browser run also found the mismatch message displayed twice, in the open manual form and its action group. The final candidate leaves that error in the manual form; related UI tests and both targeted browser journeys passed after the correction. The failed and corrected runs are retained locally as `dining-e2e.log` and `dining-e2e-rerun.log`.

## Final checks and independent review

Frozen candidate `cb0f87f4a420c1cda091f66ccf3e133f867137cd` contains two ordered commits based on unchanged integration tip `4ccf4c6`. Native Mac verification used pnpm-pinned Node 24.21.0. Exact-candidate `pnpm typecheck`, `NODE_OPTIONS=--max-old-space-size=8192 pnpm test` (including lint, 1,635 unit tests), and `pnpm test:e2e` (379 mock/server tests) all passed. Logs are local at `/tmp/reimburse-dining-followup/final-{typecheck,unit,e2e}.log`. No test is skipped or deleted by this follow-up. Remote main remains the previously tested `094732d561991f95d211a0ccb2429e5ad631a786`; the fast-forward integration result is the tested candidate.

The scoped no-comments audit inspected all 31 changed files at the final clean candidate. Zero added/modified comments, zero suppressions, zero deletions/restorations/reruns, no architect reshaping, fixes, encoding offers or open constraints. No broader cleanup was performed.

Independent no-comments, Standards and Spec reviews used separate contexts and the fixed base/candidate diff. Standards: zero findings. Spec: zero actionable findings. The reviewer's stated coverage limit is that target deletion/replacement has static path evidence rather than a dedicated new lifecycle scenario; exclusion, recognition changes, stale choices and reservation release have focused regressions. Legacy mock unknown fixtures do not persist the new manual classification; real HTTP scenarios and real-server browser journeys establish this feature's behavior. See [independent reviews](qa372-reviews.md).

The [independent trail audit](qa372-trail-audit.md) found one omitted intermediate browser correction, now recorded in the append-only trail and this report. No unresolved audit flags remain. The auditor was dispatched as `gpt-6-astra`; runtime model identity is not independently observable. Review diversity is within the GPT family.

## Existing limitations

This change adds user repair controls, not new recognition layouts. [#371](https://github.com/liumingjian/reimburse-ai/issues/371) remains the tracked automatic-recognition limitation for the additional original receipt photo. Manual association still requires the independently entered receipt amount to match the chosen invoice. The scoped first-QA private evidence remains three real materials with 21 face fields. The broader real-pair corpus task [#365](https://github.com/liumingjian/reimburse-ai/issues/365) and live ERP mapping task [#366](https://github.com/liumingjian/reimburse-ai/issues/366) remain open.
