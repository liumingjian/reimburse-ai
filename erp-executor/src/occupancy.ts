// The precondition of an 自动重新去报销 (ADR-0034), asked of ERP read-only (ExecuteBillQuery) before anything is
// uploaded. A re-run on a fresh 新增单 is safe only while the task's bill never landed: no 费用报销单 of this account
// holds any of its invoices (V-63: a bill that holds one refuses the re-import, whatever its status; the bill that
// held two in 2026-09-20 was a 暂存 draft), and no draft carries the marker of one of the task's earlier jobs.

import { type CdpSession } from './cdp';
import { queryRows } from './catalog';
import { DRAFT_FORM, findDrafts } from './draft';
import { DRAFT_MARK, INVOICE_NO } from './protocol';

// The field of 费用报销单 that ExecuteBillQuery filters on to find the bill holding an invoice number. None yet: S6
// (2026-10-13) found 发票号码 only on 电子发票, an entry V-60 read empty on a bill whose 收票信息 held four, so a query
// on it could answer «none» for an invoice that is held. Until a live run finds the field that finds a known holder,
// every re-run stops as unanswered: a wrong field would read as «free».
export const RECEIPT_INVOICE_NO: string | null = null;

export type Holder = { invoiceNo: string; billNo: string | null; status: string };

export type RerunCheck =
  | { ok: true }
  | { ok: false; code: 'rerun_invoice_held'; holders: Holder[] }
  | { ok: false; code: 'rerun_draft_found'; drafts: string[] }
  | { ok: false; code: 'rerun_check_failed'; reason: string };

/** Whether this account's ERP is clear for a re-run of the task: none of `invoiceNos` held, none of `marks` drafted. */
export async function checkRerun(session: CdpSession, { invoiceNos, marks }: { invoiceNos: string[]; marks: string[] }, field: string | null = RECEIPT_INVOICE_NO): Promise<RerunCheck> {
  if (!field) return { ok: false, code: 'rerun_check_failed', reason: '还没有实测确认怎样在报销系统里按发票号码查到占用它的单据' };
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(field)) return { ok: false, code: 'rerun_check_failed', reason: '查询字段的格式不对，没有查询' };
  // Both are spliced into a filter: the plan's schema already holds them to their patterns, this holds the query to it.
  const unsafe = [...invoiceNos.filter((no) => !INVOICE_NO.test(no)), ...marks.filter((mark) => !DRAFT_MARK.test(mark))];
  if (unsafe.length || !invoiceNos.length) return { ok: false, code: 'rerun_check_failed', reason: '发票号码或归属标记的格式不对，没有查询' };
  const held = await queryRows(session, {
    formId: DRAFT_FORM,
    fieldKeys: `FBillNo,FDocumentStatus,${field}`,
    filter: invoiceNos.map((no) => `${field} = '${no}'`).join(' or '),
    limit: 50,
  });
  if (!held.ok) return { ok: false, code: 'rerun_check_failed', reason: held.reason };
  const holders = held.rows.map((row) => ({ billNo: String(row[0] ?? '').trim() || null, status: String(row[1] ?? ''), invoiceNo: String(row[2] ?? '') }));
  if (holders.length) return { ok: false, code: 'rerun_invoice_held', holders };
  const drafts: string[] = [];
  for (const mark of marks) {
    const found = await findDrafts(session, mark);
    if (!found.ok) return { ok: false, code: 'rerun_check_failed', reason: found.reason };
    drafts.push(...found.drafts.map((draft) => draft.id));
  }
  return drafts.length ? { ok: false, code: 'rerun_draft_found', drafts } : { ok: true };
}

/** What the run says when the check stops it: nothing was uploaded or written. */
export function rerunRefusal(check: Exclude<RerunCheck, { ok: true }>): string {
  switch (check.code) {
    case 'rerun_invoice_held': {
      const bills = [...new Set(check.holders.map((h) => h.billNo ?? '一张没有单据编号的暂存单'))];
      return `没有自动重新去报销：这次的发票已经关联在费用报销单 ${bills.join('、')} 上。报销系统没有被改动。`;
    }
    case 'rerun_draft_found':
      return `没有自动重新去报销：报销系统里已经有这次报销暂存的单据（内码 ${check.drafts.join('、')}）。报销系统没有被改动。`;
    case 'rerun_check_failed':
      // ERP's own wording of why it could not answer stays out of the employee's sentence: it may name the system.
      return '没有自动重新去报销：查不清这次的发票是否已被别的单据占用。报销系统没有被改动。';
  }
}
