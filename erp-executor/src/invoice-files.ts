// How the employee's invoices reach the 发票无忧助手 (invoice assistant)'s file input. The job fetches every original
// by content and verifies it before any page action (a bad file stops there), then hands each upload batch to the
// assistant as local paths through `DOM.setFileInputFiles` (`staging.ts`). Measured live.
//
// This is upload, not consumption: ADR-0025 puts consumption at the 发票导入单据 click, so nothing here may
// start an attempt, and a failure here leaves the task retryable.

import type { CdpSession } from './cdp';
import { ExecutorError } from './page';
import type { BlobRef, BlobSource } from './protocol';
import { sha256Hex } from './sha256';

/** Puts one upload batch, named as `StagedInvoices.names` names them, into the assistant's file input. */
export type PutInvoiceFiles = (assistant: CdpSession, names: string[]) => Promise<void>;

/** A job's invoices, fetched and verified: one name per invoice (its extension picks the batch), and the route. */
export type StagedInvoices = { names: string[]; put: PutInvoiceFiles; discard(): Promise<void> };

const MIME_EXTENSIONS: Record<string, string> = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg' };

/** The original's bytes, refused unless they hash to what the plan names. */
export async function verifiedBytes(ref: BlobRef, blobs: BlobSource): Promise<Uint8Array> {
  const bytes = await blobs.read(ref);
  if (sha256Hex(bytes) !== ref.sha256) throw new ExecutorError('BLOB_HASH_MISMATCH', `发票文件 ${ref.fileName} 的内容与计划中的 sha256 不一致`);
  return bytes;
}

/** A file name the assistant can take: ordered, unique within the job, and ending in the original's format. */
export function stagedName(ref: BlobRef, index: number): string {
  const ext = /\.[^.]+$/.exec(ref.fileName)?.[0]?.toLowerCase() || MIME_EXTENSIONS[ref.mime] || '';
  const safeBase = ref.fileName.replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'invoice';
  return `${String(index + 1).padStart(2, '0')}-${safeBase}${ext}`;
}
