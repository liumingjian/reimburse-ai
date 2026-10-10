# Dining evidence independent reviews

## Standards

Inspected HEAD `cb0f87f4a420c1cda091f66ccf3e133f867137cd`.

Reviewed `git diff 4ccf4c6f059fa2a19173de056bdc3a4da7a90409...HEAD` and both commits, `ae040c8` and `cb0f87f`.

No documented-standard breaches or actionable baseline smells found.

The regressions follow `docs/agents/coding-standards.md`, "Every QA-bug fix ships a regression test". `server/src/task-policy.test.ts` adds admission-table cases for confirmation, ERP attempts, parsing, lifecycle, stale tokens and cross-task blockers. `server/src/dining.test.ts` uses the prescribed `scenario(server).at(...)` public HTTP arrangement for action behavior, persistence, atomic refusal and evidence projection. The browser journeys exercise supplemental upload and manual association through the real server. This assessment concerns test placement and assertions; I did not run suites.

The implementation preserves the documented single owner in `docs/agents/coding-standards.md`, "taskPolicy table". Upload and association writes use `change_dining_evidence` admission, while web controls consume its declared availability. Receipt fields remain separate from append-only association intent, consistent with ADR-0017, "Decisions", and the dining rule in `docs/design/standalone-app.md`, "支付截图".

Boundary Discipline shaped the check that the pure dining resolver accepts resolved inputs and owns no transport or persistence. Type System Discipline shaped the inspection of schema-derived, discriminated assignment states. Minimize Reader Load shaped the smell assessment. The resolver shares occupancy judgment, both forms reuse one selector, and supplemental upload reuses existing batch persistence. The accepted design explicitly excludes a generic upload framework and new branded identifiers, so those abstractions are not warranted here.

Review stayed read-only apart from this external report. No repository edits, suites, private material access, ERP actions or GitHub writes occurred.

## Spec

Inspected HEAD `cb0f87f4a420c1cda091f66ccf3e133f867137cd` against base `4ccf4c6f059fa2a19173de056bdc3a4da7a90409`.

No actionable Spec findings. The implementation meets the two requested flows and the accepted design overrides in the inspected paths.

- Manual submission validates the independently entered amount and currently offered invoice before writing. `tasks.answerPending` separates the selection from printed facts and appends both facts in the same transaction and revision. `manualFilled` copies only kind slot keys.
- The dining resolver reserves explicit targets before automatic matching, rejects competing owners, retains failed choices, and matches only unique residual amount buckets. Inventory derives intent from its canonical edit even when recognition changes. Excluded sources stop reserving targets. Unavailable target IDs do not fall back to other equal-amount invoices.
- Supplemental upload uses the existing file judgement and batch writer. Applicability and task admission precede database writes. Accepted materials create one inventory run; all-rejected batches retain rejection facts without a new run. Upload context does not assign receipt ownership.
- The shared capability gates supplemental upload, manual selection and canonical edits. Existing policy ordering preserves stale-token, lifecycle and ERP restrictions. UI controls use the admitted capability, refresh association state from metadata, expose resolved explicit choices and reset, and show latest upload rejections.
- The diff leaves automatic recognition and hotel matching rules unchanged. The accepted override allowing replacement while a receipt is unavailable remains blocking until its evidence becomes valid.

Static inspection included the domain resolver, server mutation and projection paths, HTTP adapter, pending UI, policy cases, scenario regressions and browser journey. No tests were run under the review brief; root owns execution of the required gates. Existing scenarios cover manual atomic refusal, equal-amount ownership, reservation release, recognition changes and upload rejection. Target deletion/replacement has no dedicated new scenario, so that lifecycle branch has static evidence rather than a focused regression in this diff.

Type System Discipline guided tracing the discriminated association states through contract, projection and UI instead of treating a selected invoice ID as valid evidence.

## No-comments

Comment audit complete for #372.

Inspected `/tmp/reimburse-dining-followup/implement` from fixed base `4ccf4c6f059fa2a19173de056bdc3a4da7a90409` through HEAD `cb0f87f4a420c1cda091f66ccf3e133f867137cd`, including the working tree. The final working tree is clean. The first snapshot was `ae040c872a9fca899e5ac1e29cfc08c10f1be9b4` with pending implementation, test, and documentation edits; the audit result uses the final committed tree.

- Repository files touched: none. This report is the only written artifact.
- Deletion count: 0 comment blocks, 0 comment lines.
- Added or modified comments: none.
- Kept exceptions: none needed. No scoped comment required proof of a keep-list exception.
- `MUST KILL` targets: none within the comment scope.
- Scoped suppressions: none added or modified. No rule lookup was needed.
- Proposed exact comment-only patch: empty; no repository patch is proposed.

The audit covered all 31 changed files, including all 25 `.ts` and `.tsx` files. A TypeScript comment-token scan checked both base and final source against every changed hunk and compared the ordered comment text in each file. No comment range intersects an added or removed hunk, and every source file retains its base comment text. The added-line scan found no lint, TypeScript, formatter, or coverage suppression. The three changed Markdown files contain no HTML comments; the three changed JSON files only change golden data.

The existing two-line accommodation upload comment in `contract/src/adapter.ts` remains at lines 118 and 119, directly above `addPaymentScreenshots` on line 120. The new `supplementDiningEvidence` method follows it at line 121 without a comment. The final diff therefore contains no comment relocation or new comment content to judge.

Skips: unchanged #356 and other pre-existing comments, ordinary Markdown documentation prose, and JSON data. Per the delegated scope, no test suites ran and no private corpus or private materials were accessed.

Standards: 0 findings. Spec: 0 actionable findings. No unresolved issue within either axis.
