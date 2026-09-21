// Invoice staging for `DOM.setFileInputFiles`, which takes local paths: fetch each original by content, verify its
// sha256, and write it to a private temp directory. Node only. The browser extension has no filesystem and no path to
// hand over, so its bundle swaps this module for `staging.browser.ts` (the `browser` map in package.json); #256
// replaces the path-based upload there with a `DataTransfer` built in the page.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { BlobRef, BlobSource } from './protocol';
import { ExecutorError } from './page';
import { sha256Hex } from './sha256';

const MIME_EXTENSIONS: Record<string, string> = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg' };

/** Fetch invoice bytes by content, verify the hash, and stage them under `root` (default: the OS temp dir). */
export async function stageInvoices(refs: BlobRef[], blobs: BlobSource, root: string = tmpdir()): Promise<{ dir: string; paths: string[] }> {
  const dir = await mkdtemp(join(root, 'baox-erp-invoices-'));
  const paths: string[] = [];
  for (const [index, ref] of refs.entries()) {
    const bytes = await blobs.read(ref);
    if (sha256Hex(bytes) !== ref.sha256) throw new ExecutorError('BLOB_HASH_MISMATCH', `发票文件 ${ref.fileName} 的内容与计划中的 sha256 不一致`);
    const ext = extname(ref.fileName).toLowerCase() || MIME_EXTENSIONS[ref.mime] || '';
    const safeBase = ref.fileName.replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'invoice';
    const path = join(dir, `${String(index + 1).padStart(2, '0')}-${safeBase}${ext}`);
    await writeFile(path, bytes, { mode: 0o600 });
    paths.push(path);
  }
  return { dir, paths };
}

export async function discardStagedInvoices(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
