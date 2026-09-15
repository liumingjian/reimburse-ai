# The ERP executor is a separable unit driven by a background ERP job

The new baox local app runs 去报销 (fill ERP) as a long background job: the page follows its progress over SSE instead of a blocking CLI call. The CDP code that touches ERP sits behind a **separable executor**. The server sends it one fill plan and gets back events, so V2 can replace the in-process executor with a `chrome.debugger` extension without touching the server. Decided in [#152](https://github.com/liumingjian/reimburse-ai/issues/152); builds on ADR-0014.

## Decisions

- **Coarse protocol.**
  - Each job gets one plan, holding the expected catalog entries, the invoices, the lines with their projects, and the 报销事由 (purpose). The step order lives in the plan, so the server still decides it.
  - The executor sends back `step`, `waiting_login`, `catalog_mismatch`, `attempt_started`, `readback` and `result`.
  - 对账 (reconcile) is a second, read-only job kind on the same protocol.
- **Durable attempt before the first mutation.**
  - Before each mutating ERP action (import, fill, save), the executor sends `attempt_started` and waits until the server has persisted it. The record holds preconditions, expected postconditions, a compatibility fingerprint (ERP build + form id) and the probed ERP account + 账套 (account set).
  - A failure before the first attempt aborts cleanly and may be retried.
  - Any loss after it (server restart, executor crash, lost connection, drift) becomes ERP 写入结果未知 (write result unknown) and goes to reconcile, never replay.
- **Job order.**
  1. Chromium ready.
  2. Login probe.
  3. 报销信息核对 (catalog check). A mismatch aborts before import, with no attempt.
  4. Import, fill, save.
  5. Strict readback.
- **Login pause.**
  - Job status `waiting_login`, step `erp_login`. Only two mutating actions are accepted, each with the stepToken:
    - `confirm-login`: triggers one re-probe. No polling, no timeout.
    - `cancel-erp-write`: back to write-pending. It is safe because no attempt exists yet.
  - Every other mutating action gets 409.
- **ERP authorisation is a login, not an identity match.**
  - baox app accounts are independent of ERP accounts: the user registers and logs in to baox, and authorises ERP only at 去报销.
  - Whichever ERP account is logged in may receive the draft. The probe records it on the attempt and never compares it.
  - A project that account cannot use is caught by the catalog check before import.
- **ERP 自动化控制权 (automation control) is a server-side lease** (`jobId`, `taskId`, CDP `targetId`, heartbeat). It is global: one ERP job at a time, whatever the number of app users.
  - The executor must hold the lease to act.
  - The lease is released on `waiting_login`, abort, catalog mismatch, error and done. Only `confirm-login` re-takes it.
  - Before every mutating action, the executor re-checks the target, the single visible form-instance UUID, 新增/修改 mode and URL. Drift releases the lease and ends in write result unknown.
  - The lease dies with the process, so a job found `running` after a restart is write result unknown.
- **Server owns judgement, executor only observes.**
  - The executor returns raw readbacks (receipt grid; nine fields per line).
  - The strict comparison and the #36 reconcile classifier run in the server.
- **Files by content, not path.**
  - The plan names invoices by sha256 + filename + MIME, and the executor reads bytes through a `BlobSource` port.
  - The v1 executor stages them in a temp dir for `DOM.setFileInputFiles`. How V2 injects files is left to V2.
- **Code boundary.**
  - `server/src/erp/`, split into `protocol.ts` (zod plan and event types), `jobs.ts` (persists events), and `executor/`, which a lint rule forbids from importing the rest of `server/`.
  - It becomes a root package only when the V2 extension becomes its second consumer.
- **Port scope beyond the old code.**
  - Per-action attempts replace the two-value `erpWriteState`.
  - Grids are always located by header label.
  - #32's error capture: piaozone iframe and `.k-window` text, cropped screenshots.
  - The compatibility fingerprint aborts on mismatch; a versioned compatibility catalog comes later.
- **Parity tests.**
  - Translated to Vitest: `erp-write-context`, `erp-draft-flow`, `erp-write-readback`, `erpreconcile(-strict)`, `erp-write-preview`, `erpform`, `chromium-cdp` and `probe`.
  - `next-erp` and `recovery-flow` become server tests: a job found running after `attempt_started` goes to reconcile and never writes twice.
  - New: one fake-executor job test.
  - The ego tests are dropped.

## Considered Options

- **A command per step** (server drives probe, import, fill, save one by one). Tighter server control, but a V2 extension would need a round-trip per step, and the server would duplicate the executor's page knowledge.
- **Executor compares readbacks itself.** Makes the executor thick and puts the reconcile classifier where V2 would have to re-implement it.
- **Keep the ERP identity gate** (bind a baox user to an ERP account and abort on mismatch). Rejected: baox accounts are its own; users may file under any ERP account they log in with.

## Consequences

- Supersedes ADR-0002's "foreground-blocking, no daemon" and its identity gate. Exclusive CDP control returns for the app's dedicated Chromium profile.
- Revises #24's identity precondition and CONTEXT.md's ERP 自动化授权 (ERP automation authorisation).
- Amends ADR-0014's home-city snapshot: 常驻城市 (home city) is remembered per app account. The current task's snapshot may be changed until its first ERP action attempt. A change re-derives expense categories, invalidates the whole-list confirmation, and becomes the default for later tasks.
- The contract gains `cancel-erp-write`, a `failed` step with verbatim ERP text and screenshot on drift aborts, and the ERP account on the done page.
