// How the employee's invoices reach the 发票无忧助手 (invoice assistant)'s file input. The job fetches every original
// by content and verifies it before any page action (a bad file stops there), then hands each upload batch to the
// assistant through one of two routes:
//
// - local paths through `DOM.setFileInputFiles` (`staging.ts`): the server's own CDP executor, which has a
//   filesystem. Measured live; the route `pnpm dev`, e2e and `test:erp-live` use.
// - bytes built into `File` objects inside the page (`stageInPage` below): the browser extension, which has no local
//   path to give (ADR-0021). The extension's bundle also swaps `staging.ts` for this one (`staging.browser.ts`).
//
// Either way this is upload, not consumption: ADR-0025 puts consumption at the 发票导入单据 click, so nothing here may
// start an attempt, and a failure here leaves the task retryable.

import { evalIn, type CdpSession } from './cdp';
import { ExecutorError } from './page';
import type { BlobRef, BlobSource } from './protocol';
import { sha256Hex } from './sha256';

/** Puts one upload batch, named as `StagedInvoices.names` names them, into the assistant's file input. */
export type PutInvoiceFiles = (assistant: CdpSession, names: string[]) => Promise<void>;

/** A job's invoices, fetched and verified: one name per invoice (its extension picks the batch), and the route. */
export type StagedInvoices = { names: string[]; put: PutInvoiceFiles; discard(): Promise<void> };

export type InvoiceStaging = (refs: BlobRef[], blobs: BlobSource, root?: string) => Promise<StagedInvoices>;

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

export type InPageFile = { name: string; mime: string; bytes: Uint8Array };

/** The in-page route: bytes held in memory, handed to the page batch by batch. Nothing to discard. */
export const stageInPage: InvoiceStaging = async (refs, blobs) => {
  const byName = new Map<string, InPageFile>();
  for (const [index, ref] of refs.entries()) {
    const name = stagedName(ref, index);
    byName.set(name, { name, mime: ref.mime, bytes: await verifiedBytes(ref, blobs) });
  }
  return {
    names: [...byName.keys()],
    put: (assistant, names) => putFilesInPage(assistant, names.map((name) => byName.get(name)!)),
    discard: async () => undefined,
  };
};

const base64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/**
 * The in-page upload, and the only place it happens: build a `File` per invoice and a `DataTransfer` inside
 * `Runtime.evaluate`, assign it to the assistant's hidden `multiple` file input, and fire `input` and `change` as a
 * picked file would.
 *
 * PROVISIONAL on the unrun #250 spike, question 2 (`docs/research/spike-250-chrome-debugger-and-datatransfer.md`):
 * nobody has yet seen the live assistant RECOGNISE files assigned this way. What is known: the fake ERP does, and in a
 * real Chromium the hidden input's own `change` handler receives the exact bytes (`extension/e2e/debugger.spec.ts`).
 * If the spike finds the live assistant ignores them, this function is what changes.
 */
export async function putFilesInPage(assistant: CdpSession, files: InPageFile[]): Promise<void> {
  const payload = JSON.stringify(files.map((file) => ({ name: file.name, type: file.mime, base64: base64(file.bytes) })));
  const outcome = await evalIn<{ ok: boolean; reason?: string; held?: number }>(assistant, `(() => {
  const input = document.querySelector('input[type=file]');
  if (!input) return { ok: false, reason: 'no_input' };
  const transfer = new DataTransfer();
  for (const file of ${payload}) {
    const binary = atob(file.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    transfer.items.add(new File([bytes], file.name, { type: file.type }));
  }
  input.files = transfer.files;
  const held = input.files ? input.files.length : 0;
  for (const type of ['input', 'change']) input.dispatchEvent(new Event(type, { bubbles: true }));
  return { ok: held === ${files.length}, held };
})()`, { timeout: 60_000 });
  if (outcome?.reason === 'no_input') throw new ExecutorError('INVOICE_FILE_INPUT_NOT_FOUND', '发票助手中找不到文件上传控件');
  if (!outcome?.ok) throw new ExecutorError('INVOICE_FILES_NOT_ACCEPTED', `发票助手的文件上传控件没有收下发票文件（收下 ${outcome?.held ?? 0} 个，应为 ${files.length} 个）`);
}
