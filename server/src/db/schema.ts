// Row types for kysely. Every per-account fact carries `account_id` (ADR-0015, ADR-0018).

export type TaskLifecycle = 'open' | 'voided' | 'handed_off';

// Mutable: role, active flag and password change over an account's life. Accounts are deactivated, never deleted.
export interface AccountTable {
  account_id: string;
  display_name: string;
  created_at: string;
  username: string | null;
  password_hash: string | null;
  role: 'user' | 'admin';
  active: number;
}

// Mutable: `expires_at` slides; logout deletes the row.
export interface SessionTable {
  token_sha256: string;
  account_id: string;
  created_at: string;
  expires_at: string;
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
}

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

export interface Schema {
  rule_set: RuleSetTable;
  task_rule_pin: TaskRulePinTable;
  home_city_setting: HomeCitySettingTable;
  task_home_city: TaskHomeCityTable;
  project_book_event: ProjectBookEventTable;
  project_assign: ProjectAssignTable;
  project_submission: ProjectSubmissionTable;
  erp_attempt: { attempt_id: string; job_id: string; task_id: string; action: 'import' | 'fill' | 'save'; preconditions: string; expected_postconditions: string; erp_build: string; form_id: string; erp_account: string; erp_tenant: string; erp_display_name: string; started_at: string };
  parse_result: ParseResultTable;
  account: AccountTable;
  session: SessionTable;
  task: TaskTable;
  upload_batch: UploadBatchTable;
  blob: BlobTable;
  material: MaterialTable;
  upload_rejection: UploadRejectionTable;
  material_exclusion: MaterialExclusionTable;
  inventory_run: InventoryRunTable;
  upload_reopen: UploadReopenTable;
}
