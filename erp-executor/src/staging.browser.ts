// The browser build's stand-in for `staging.ts`, selected by the `browser` map in package.json. A browser has no local
// path to stage an invoice at, so a fill job run by the extension stops here: after the login probe and 报销信息核对
// (catalog check), before navigating and before any attempt — a clean, retryable `aborted` with nothing written to
// ERP. #256 replaces the path-based upload with a `DataTransfer` built in the page and retires this file.

import type { BlobRef, BlobSource } from './protocol';
import { ExecutorError } from './page';

export const INVOICE_STAGING_UNAVAILABLE = 'INVOICE_STAGING_UNAVAILABLE';

export async function stageInvoices(_refs: BlobRef[], _blobs: BlobSource, _root?: string): Promise<{ dir: string; paths: string[] }> {
  throw new ExecutorError(INVOICE_STAGING_UNAVAILABLE, '这个版本的浏览器扩展还不能把发票交给发票助手；报销系统没有被改动。');
}

export async function discardStagedInvoices(_dir: string): Promise<void> {}
