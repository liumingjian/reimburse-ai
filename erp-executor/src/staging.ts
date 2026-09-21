// The local-path route for invoices (`invoice-files.ts`): fetch each original by content, verify its sha256, write it
// to a private temp directory, and hand the paths to `DOM.setFileInputFiles`. Node only — the server's own CDP
// executor. The browser extension has no filesystem and no path to hand over, so its bundle swaps this module for
// `staging.browser.ts` (the `browser` map in package.json), which puts the bytes into the page instead.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlobRef, BlobSource } from './protocol';
import { stagedName, verifiedBytes, type StagedInvoices } from './invoice-files';
import { setFileInputPaths } from './steps';

/** Fetch invoice bytes by content, verify the hash, and stage them under `root` (default: the OS temp dir). */
export async function stageInvoices(refs: BlobRef[], blobs: BlobSource, root: string = tmpdir()): Promise<StagedInvoices> {
  const dir = await mkdtemp(join(root, 'baox-erp-invoices-'));
  const names: string[] = [];
  try {
    for (const [index, ref] of refs.entries()) {
      const bytes = await verifiedBytes(ref, blobs);
      const path = join(dir, stagedName(ref, index));
      await writeFile(path, bytes, { mode: 0o600 });
      names.push(path);
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return { names, put: setFileInputPaths, discard: () => rm(dir, { recursive: true, force: true }) };
}
