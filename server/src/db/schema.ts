// Row types for kysely. Every per-account fact carries `account_id` (ADR-0015, ADR-0018).

export type TaskLifecycle = 'open' | 'voided' | 'handed_off';

// Mutable: role, active and approval flags, and password change over an account's life. Accounts are never deleted.
export interface AccountTable {
  account_id: string;
  display_name: string;
  created_at: string;
  username: string | null;
  password_hash: string | null;
  role: 'user' | 'admin';
  active: number;
  approved: number;
  must_change_password: number;
}

export type AccountEventAction = 'approved' | 'promoted' | 'demoted' | 'deactivated' | 'reactivated' | 'temporary_password' | 'password_changed' | 'cli_reset_password';

// Append-only audit of account changes (#194). `actor_account_id` is null for the local CLI.
export interface AccountEventTable {
  event_id: string;
  account_id: string;
  actor_account_id: string | null;
  action: AccountEventAction;
  created_at: string;
}

// Mutable: `expires_at` slides; logout deletes the row.
export interface SessionTable {
  token_sha256: string;
  account_id: string;
  created_at: string;
  expires_at: string;
}

// 扩展配对 (extension pairing, ADR-0019), one row per 应用账号: `account_id` is the primary key, which is how "one
// active pairing per account" is enforced. The extension holds a random code and later a random token; only their
// sha256 is stored. Mutable: redeeming clears the code and writes the token, and every connection slides
// `last_connected_at`. Revoking (or issuing a new 配对码) deletes the row.
export interface ExtensionPairingTable {
  account_id: string;
  code_sha256: string | null;
  code_expires_at: string | null;
  token_sha256: string | null;
  // What the extension calls the browser it runs in; shown on the settings page, never acted on.
  browser: string | null;
  // The version the extension last reported (ADR-0021), refreshed on every connect. Null until something pairs.
  version: string | null;
  created_at: string;
  paired_at: string | null;
  last_connected_at: string | null;
}

// Mutable: `lifecycle` and `revision` (the per-task stepToken counter, ADR-0014).
export interface TaskTable {
  task_id: string;
  account_id: string;
  name: string;
  home_city: string;
  lifecycle: TaskLifecycle;
  revision: number;
  created_at: string;
  updated_at: string;
  // 0005_195: `legacy` for a read-only task imported from the legacy `~/.baox`; inserts default to `app`.
  origin?: TaskOrigin | undefined;
}

export type TaskOrigin = 'app' | 'legacy';

// Append-only from here down.
export interface UploadBatchTable {
  batch_id: string;
  task_id: string;
  account_id: string;
  no: number;
  uploaded_at: string;
}

export interface BlobTable {
  sha256: string;
  size: number;
  mime: string;
  created_at: string;
}

export interface MaterialTable {
  material_id: string;
  task_id: string;
  account_id: string;
  batch_id: string;
  blob_sha256: string;
  file_name: string;
  // Relative path supplied by a directory picker; null on material rows written before #280.
  source_path: string | null;
  created_at: string;
  // Position within the batch (0002_180); null for materials uploaded before it.
  batch_seq: number | null;
}

export interface UploadRejectionTable {
  rejection_id: string;
  task_id: string;
  account_id: string;
  batch_id: string;
  batch_seq: number;
  file_name: string;
  // Relative path supplied by a directory picker; null on rejection rows written before #280.
  source_path: string | null;
  size: number;
  reason_code: 'unsupported_type' | 'too_large' | 'heic' | 'duplicate_content';
  reason: string;
  created_at: string;
}

export interface MaterialExclusionTable {
  exclusion_id: string;
  task_id: string;
  account_id: string;
  material_id: string;
  revision: number;
  created_at: string;
}

export interface InventoryRunTable {
  run_id: string;
  task_id: string;
  account_id: string;
  version_no: number;
  revision: number;
  started_at: string;
}

export interface UploadReopenTable {
  reopen_id: string;
  task_id: string;
  account_id: string;
  revision: number;
  reopened_at: string;
}

// One parser outcome per material per inventory run (0003_183). `detail` is the JSON `ParseOutcome`.
export interface ParseResultTable {
  result_id: string;
  task_id: string;
  account_id: string;
  run_id: string;
  material_id: string;
  outcome: 'recognised' | 'unrecognised' | 'ambiguous' | 'failed';
  kind: string | null;
  layout: string | null;
  parser_version: string | null;
  detail: string;
  revision: number;
  created_at: string;
}

// ---- 0004_188 (all append-only) ----

export interface RuleSetTable {
  hash: string;
  kind: 'company_rules' | 'project_catalog';
  content: string;
  created_at: string;
}

export interface TaskRulePinTable {
  task_id: string;
  account_id: string;
  kind: string;
  hash: string;
  created_at: string;
}

export interface HomeCitySettingTable {
  setting_id: string;
  seq: number;
  account_id: string;
  home_city: string | null;
  source: 'task_create' | 'task_edit' | 'reset' | 'legacy_import';
  created_at: string;
}

export interface TaskHomeCityTable {
  change_id: string;
  task_id: string;
  account_id: string;
  home_city: string;
  revision: number;
  created_at: string;
}

// One accepted answer to a 待确认项 or one field edit (0004_187), keyed by the item id `<code>.<materialId>[.<key>]`
// or the edit address `edit.<materialId>.<field>`. The latest row per key wins; `answer` is the JSON answer.
export interface PendingAnswerTable {
  answer_id: string;
  task_id: string;
  account_id: string;
  item_id: string;
  material_id: string;
  answer: string;
  revision: number;
  created_at: string;
}

export interface ProjectBookEventTable {
  event_id: string;
  seq: number;
  scope: 'personal' | 'public';
  owner_account_id: string | null;
  number: string;
  action: 'admitted' | 'checked' | 'removed';
  name: string | null;
  verdict: string | null;
  expires_on: string | null;
  // Nullable advisory cutoff introduced after the legacy ERP expiry fact. Undefined is accepted by the TypeScript
  // row type so tests and databases created before the migration can still construct historical event rows.
  deadline_on?: string | null;
  // Null preserves the meaning of facts written before offline intake. `manual` marks a locally entered name that has
  // never been represented as a successful ERP catalog check.
  admission_source: 'manual' | null;
  // Null preserves the legacy event fold. Lifecycle and later maintenance facts use this explicit discriminator while
  // retaining the original `action` values accepted by the historical SQLite CHECK constraint.
  maintenance_action: 'deactivated' | 'restored' | 'edited' | 'converted' | 'deleted' | null;
  // An edit carries its original identity separately so a renumbering remains an append-only fact.
  previous_number: string | null;
  actor_account_id: string;
  created_at: string;
}

export interface ProjectAssignTable {
  assign_id: string;
  task_id: string;
  account_id: string;
  revision: number;
  // JSON string[]
  line_ids: string;
  project_number: string;
  project_name: string;
  project_source: 'personal' | 'public';
  only_unassigned: number;
  created_at: string;
}

export interface ProjectSubmissionTable {
  submission_id: string;
  task_id: string;
  account_id: string;
  revision: number;
  purpose: string;
  // JSON Record<lineId, {number, name, source}>
  selection: string;
  lines_digest: string;
  catalog_hash: string;
  created_at: string;
}

// ---- 0005_195 legacy import (all append-only) ----

// One run of the legacy import; `report` is the JSON `LegacyImportReport`. The latest run is the current state.
export interface ImportRunTable {
  run_id: string;
  seq: number;
  account_id: string;
  outcome: 'absent' | 'imported' | 'failed' | 'skipped';
  report: string;
  created_at: string;
}

// The ERP facts of one imported legacy task. `outcome`: `saved` → draft_handed_over (ERP 单据已交接), else handed_off
// (转人工).
export interface LegacyTaskTable {
  task_id: string;
  account_id: string;
  run_id: string;
  legacy_task_id: string;
  outcome: 'draft_handed_over' | 'handed_off';
  erp_write_state: string;
  erp_write_at: string | null;
  reconcile_bucket: string | null;
  bill_no: string | null;
  created_at: string;
}

// One invoice identity an imported legacy task holds (发票占用).
export interface LegacyClaimTable {
  claim_id: string;
  task_id: string;
  account_id: string;
  invoice_key: string;
  file_name: string;
  created_at: string;
}

export interface ReviewConfirmationTable {
  confirmation_id: string;
  task_id: string;
  account_id: string;
  digest: string;
  detail_digest: string;
  project_digest: string;
  revision: number;
  confirmed_at: string;
}

// One run of the 去报销 fill job (#191). `plan` is `{ plan: FillPlan, judge: JudgeBase }` JSON, frozen at the start.
export interface ErpJobTable {
  job_id: string;
  task_id: string;
  account_id: string;
  kind: 'fill';
  // 去报销 / 我已登录，继续 / 重新去报销 (ADR-0027). See `erp/fill-jobs.ts` FillTrigger.
  trigger: 'start' | 'confirm_login' | 'refill';
  confirmation_digest: string;
  plan: string;
  revision: number;
  started_at: string;
}

export interface ErpJobCancelTable {
  cancel_id: string;
  job_id: string;
  task_id: string;
  account_id: string;
  revision: number;
  created_at: string;
}

export interface ErpApprovedPreviewTable {
  job_id: string;
  task_id: string;
  account_id: string;
  digest: string;
  preview: string;
  created_at: string;
}

// 打印稿 (#190): per-material print settings, payment screenshots, composed sheets. See migration 0007_190_print.
export interface PrintSettingTable {
  setting_id: string;
  task_id: string;
  account_id: string;
  material_id: string;
  // 1 = turned 90°, 0 = upright, null = this row does not set the rotation.
  rotate: number | null;
  // JSON `[[x, y] x 4]` in original-image pixels, or null = this row does not set the crop.
  corners: string | null;
  revision: number;
  created_at: string;
}

export interface PaymentScreenshotTable {
  screenshot_id: string;
  task_id: string;
  account_id: string;
  voucher_material_id: string;
  blob_sha256: string;
  file_name: string;
  revision: number;
  created_at: string;
}

export interface PaymentScreenshotRemovalTable {
  removal_id: string;
  screenshot_id: string;
  task_id: string;
  account_id: string;
  revision: number;
  created_at: string;
}

export interface PrintRenderTable {
  render_id: string;
  task_id: string;
  account_id: string;
  confirmation_revision: number;
  pdf_sha256: string;
  // JSON `StoredPage[]` (server/src/print/facts.ts).
  pages: string;
  revision: number;
  created_at: string;
}

export interface ErpReconcileJobTable {
  job_id: string;
  fill_job_id: string;
  task_id: string;
  account_id: string;
  revision: number;
  started_at: string;
}

export interface ErpHandOffTable {
  hand_off_id: string;
  task_id: string;
  account_id: string;
  fill_job_id: string | null;
  bucket: string | null;
  revision: number;
  created_at: string;
}

// One durable maintenance barrier for this data directory. The migration creates its sole row; a missing or invalid
// value is intentionally treated as unknown by `maintenance.ts`.
export interface MaintenanceGateTable {
  gate_id: string;
  state: string;
  updated_at: string;
}

export interface Schema {
  maintenance_gate: MaintenanceGateTable;
  print_setting: PrintSettingTable;
  payment_screenshot: PaymentScreenshotTable;
  payment_screenshot_removal: PaymentScreenshotRemovalTable;
  print_render: PrintRenderTable;
  erp_reconcile_job: ErpReconcileJobTable;
  erp_hand_off: ErpHandOffTable;
  erp_job: ErpJobTable;
  erp_job_cancel: ErpJobCancelTable;
  erp_approved_preview: ErpApprovedPreviewTable;
  erp_job_event: { event_id: string; job_id: string; task_id: string; seq: number; type: string; payload: string; created_at: string };
  review_confirmation: ReviewConfirmationTable;
  import_run: ImportRunTable;
  legacy_task: LegacyTaskTable;
  legacy_claim: LegacyClaimTable;
  rule_set: RuleSetTable;
  task_rule_pin: TaskRulePinTable;
  home_city_setting: HomeCitySettingTable;
  task_home_city: TaskHomeCityTable;
  project_book_event: ProjectBookEventTable;
  project_assign: ProjectAssignTable;
  project_submission: ProjectSubmissionTable;
  erp_attempt: { attempt_id: string; job_id: string; task_id: string; action: 'import' | 'fill' | 'save'; preconditions: string; expected_postconditions: string; erp_build: string; form_id: string; erp_account: string; erp_tenant: string; erp_display_name: string; started_at: string };
  parse_result: ParseResultTable;
  pending_answer: PendingAnswerTable;
  account: AccountTable;
  account_event: AccountEventTable;
  session: SessionTable;
  extension_pairing: ExtensionPairingTable;
  task: TaskTable;
  upload_batch: UploadBatchTable;
  blob: BlobTable;
  material: MaterialTable;
  upload_rejection: UploadRejectionTable;
  material_exclusion: MaterialExclusionTable;
  inventory_run: InventoryRunTable;
  upload_reopen: UploadReopenTable;
}
