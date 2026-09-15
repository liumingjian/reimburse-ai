# The local app derives a task's stage and step from stored facts

The new baox local app (no model in the loop, at most one non-terminal 报销任务 (reimbursement task), the server decides the next step) re-designs the task core instead of porting `50931a3:kernel/src/state.mjs`. We keep ADR-0009's principle, that the next step follows only from facts the server itself observed, and drop everything that existed to steer a model. The server stores **facts**; a pure function `project(facts) → { stage, step, blockers }` derives what the page sees. No `stage` column exists. Decided in [#150](https://github.com/liumingjian/reimburse-ai/issues/150).

This ADR settles the numbering collisions noted on the wayfinder map: on `origin/main` they were already resolved by renumbering (MarkItDown stays 0011, Carbon is 0012, managed OCR is 0013), so this is 0014.

## Decisions

- **Identity and lifecycle.** A task is identified by a server-generated opaque `taskId`, not by a materials directory. The only stored lifecycle fact is `open | voided | handed_off`. ERP 草稿已交接 (draft handed over) is derived: saved and strict readback matched. A strict-readback mismatch is **not** terminal; the task stays open (stage `done`, step `hand_off`) until the user chooses 转人工 (hand off to a human). 任务存档 (task archiving) is gone: legacy tasks are not migrated.
- **Stored facts.** Upload batches and materials, field candidates and 解析记录 (resolution records), pending-item answers, the project assignment and 报销事由 (purpose), the confirmation `{ digest, confirmedAt }`, ERP action attempts, background jobs `(kind, status)`, and the lifecycle fact. Everything else is recomputed.
- **Old kernel states.**
  - Vanish (model actor): every `pdf_markdown_*`, `image_awaiting_reading`, `reading_rejected`, `reading_stale`, `reading_disputed`.
  - Vanish (Skill era or legacy): `env_chrome_down`, `recovery_write_blocked`, `archived`.
  - Leave the task machine: `schema_too_new` becomes an app-startup check; `home_city_required` and `profile_confirmation` become the new-task form (the home-city snapshot is taken at creation); `env_not_logged_in`, `env_identity_*` and `env_chromium_required` become preconditions inside the ERP job (`waiting_login` / step `erp_login`; a mismatched identity aborts the job).
  - Become automatic server work inside a stage: `inventory_stale`, `classify_pending`, `events_pending`, `preparation_package_pending`.
  - Become pending items (step `answer_pending`): `intake_open_items`, `allocation_required`, `allocation_stale`, and the field gaps `reading_awaiting_confirmation` used to defer.
  - Survive: `duplicate_blocked` (a blocker), `project_book_empty`, `project_unassigned`, `preparation_blocked`, `preparation_confirmation`, `erp_write_pending`, `erp_write_complete`, `handed_off_recover`.
- **报销信息核对 (catalog check) moves into the ERP job.** It is the job's first step, before any invoice is imported. The whole-list confirmation and 去打印 (print) therefore never need an ERP session. A mismatch aborts the job before any ERP action attempt exists (no reconcile) and returns the task to stage `project`, step `assign_projects`, with the mismatch table; the reassignment changes the digest and so invalidates the old confirmation.
- **Stages.** `catalog` is removed from `TASK_STAGES`; `voided` is added. The Skill-era "N/10" phase numbering (`KERNEL_PHASES`) is dropped: `stage` is the only milestone, which removes the phase-4/5 ambiguity. Terminals project as: draft handed over → `done` with a matched readback; 转人工 from either path → `reconcile` with `reconcile.status = handed_off`, step `none`; voided → `voided`, step `none`, read-only.
- **stepToken.** Per task: `taskId` plus a per-task `revision` counter that increments on every accepted change to that task's facts, including job progress. A stale token gets 409 with the fresh snapshot. Print-only adjustments (rotation, crop, payment screenshot) carry no token and do not bump `revision`. The global `~/.baox/steps.json` is gone.
- **材料盘点 (material inventory) versions.** A version is the set of uploaded, not-deleted materials; only uploading or deleting creates one. Excluding a material is a 人工纠正 (manual correction) inside the version. Inventory is always started explicitly: whenever an un-inventoried version exists, the step is `start_inventory`. Materials are frozen once the first ERP action attempt exists.
- **待确认项 (pending items) and 整单明细确认 (whole-list confirmation).** Pending items are derived per inventory run; answers are stored as resolution records under a stable key `(kind, materialId, field or segment)` and carry over while their material is unchanged. The confirmation's status is derived: `confirmed` when the stored digest equals the current digest (lines, project assignment, purpose, pinned rule and catalog versions); `invalidated` when an earlier confirmation no longer matches; otherwise `unconfirmed`. Reverting a change revives the old confirmation.
- **Background jobs.** While a job runs the step is `none`, and every mutating action, uploads included, gets 409. The ERP job's login pause is the one exception; the ERP adapter ticket owns its details.

## Considered Options

- **A stored `stage` with explicit transitions.** Easier to read in the database, but every fact change would need a matching transition, and a missed one leaves a stage that lies. Derivation keeps one source of truth and makes the state machine testable without a database.
- **Catalog check before confirmation, requiring an ERP login** (the old order) or **against a cached catalog with a freshness window.** The first makes printing depend on an ERP session; the second adds a staleness rule for no gain, since the ERP job must probe identity anyway and can check before consuming any invoice.
- **A `phase` label in the snapshot** to keep the 10-phase badge. It preserves numbering that no longer matches anything the user does.
- **A token that hashes the snapshot.** Same meaning as the revision counter, more cost.

## Consequences

- Revises ADR-0009: the consumer of the decided step is the page, not a model. Retires ADR-0010's command guard, which only defended against a model.
- The contract changes in the slices that need it: drop the `catalog` stage and `KERNEL_PHASES`, add `voided`, move the `catalog` section under the ERP job, and derive `stepToken` per task.
- The ERP adapter must run the read-only catalog check as its first job step and report a mismatch as a pre-import abort, not as an ERP action attempt.
- Amended by ADR-0016: the current task's 常驻城市 (home city) snapshot can change until the first ERP action attempt. Amended by ADR-0018: at most one non-terminal task per app account, not per install.
