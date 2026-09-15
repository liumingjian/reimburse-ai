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

export interface Schema {
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
