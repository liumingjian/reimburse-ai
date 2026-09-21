// The executor's read-only view of the expense form: raw readings for the server to judge.
// Origin: 50931a3:kernel/src/erpread.mjs (readFormTabs, readHeaderField) and 50931a3:kernel/src/erpreconcile.mjs
// (readReconciliation's four readings). It evaluates only; it never clicks, scrolls or writes.

import { evalIn, type CdpSession } from './cdp';
import { formTabs, readGridByColumn, type Grid } from './erpform';
import { headerFieldSnippet } from './header-locator';

/** The receipt grid (收票网格) is found by this header, the detail grid (明细网格) by the other. */
export const RECEIPTS_COLUMN = '价税合计';
export const DETAIL_COLUMN = '申请报销金额';

export type HeaderRead = { ok: true; id: string; instance: string; value: string } | { ok: false; reason: string };

/**
 * Read one header field of the single visible form instance; `instance` is the form-instance UUID prefix.
 * The locator is `header-locator.ts`, the same one the write path uses: a field this can read is a field
 * `writeHeader` can write, which is exactly what stopped being true when the two rules drifted apart.
 */
export const readHeaderField = (session: CdpSession, key: string) =>
  evalIn<HeaderRead>(session, headerFieldSnippet(key));

export type FormReadings = {
  formMode: { readable: boolean; value: 'new' | 'modify' | null; reason?: string };
  billNo: { readable: boolean; value: string | null; reason?: string };
  receiptsGrid: Grid;
  detailGrid: Grid;
  /** Not part of the protocol readings: the executor's own drift guard uses it. */
  formInstanceId: string | null;
};

/** The four readings reconcile and the strict read-back work on (same shapes as the kernel's readReconciliation). */
export async function readForm(session: CdpSession): Promise<FormReadings> {
  const tabs = await formTabs(session);
  const formMode = tabs.length === 1
    ? { readable: true, value: tabs[0]!.mode }
    : { readable: false, value: null,
        reason: tabs.length === 0
          ? '页面上没有打开的费用报销单（既没有「新增」也没有「修改」页签）'
          : `页面上同时开着 ${tabs.length} 个费用报销单页签（${tabs.map((t) => t.label).join('、')}），认不出对的是哪一张` };
  const bill = await readHeaderField(session, 'FBILLNO');
  const billNo = bill.ok
    ? { readable: true, value: bill.value === '' ? null : bill.value }
    : { readable: false, value: null, reason: bill.reason };
  const receiptsGrid = await readGridByColumn(session, RECEIPTS_COLUMN);
  const detailGrid = await readGridByColumn(session, DETAIL_COLUMN);
  return { formMode, billNo, receiptsGrid, detailGrid, formInstanceId: bill.ok ? bill.instance : null };
}

/** Drop the executor-only field before the readings cross the protocol. */
export const protocolReadings = ({ formInstanceId: _ignored, ...readings }: FormReadings) => readings;

export const pageUrl = (session: CdpSession) => evalIn<string>(session, 'location.origin + location.pathname');
