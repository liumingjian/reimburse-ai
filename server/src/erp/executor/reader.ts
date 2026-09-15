// The executor's read-only view of the expense form: raw readings for the server to judge.
// Origin: kernel/src/erpread.mjs (readFormTabs, readHeaderField) and kernel/src/erpreconcile.mjs
// (readReconciliation's four readings). It evaluates only; it never clicks, scrolls or writes.

import { evalIn, type CdpSession } from './cdp';
import { formTabs, readGridByColumn, type Grid } from './erpform';

/** The receipt grid (收票网格) is found by this header, the detail grid (明细网格) by the other. */
export const RECEIPTS_COLUMN = '价税合计';
export const DETAIL_COLUMN = '申请报销金额';

const READ_HEADER = (key: string) => `(() => {
  const key = ${JSON.stringify(key)};
  const all = [...document.querySelectorAll('[id]')]
    .filter((n) => n.id.endsWith('-' + key) || n.id.endsWith('-' + key + '-EDITOR'));
  if (all.length === 0) return { ok: false, reason: '页面上找不到表头字段 ' + key };
  const visible = all.filter((n) => {
    const b = n.getBoundingClientRect();
    const st = getComputedStyle(n);
    return b.width > 0 && b.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  });
  if (visible.length === 0) return { ok: false,
    reason: '表头字段 ' + key + ' 没有可见实例', instances: all.length, visibleInstances: 0 };
  // One form renders a wrapper, an -EDITOR textfield and an inner input under one form prefix; different prefixes
  // are different form instances and are refused.
  const fieldSuffix = '-' + key;
  const editorSuffix = fieldSuffix + '-EDITOR';
  const instanceOf = (n) => n.id.endsWith(editorSuffix)
    ? n.id.slice(0, -editorSuffix.length) : n.id.slice(0, -fieldSuffix.length);
  const groups = new Map();
  for (const n of visible) {
    const instance = instanceOf(n);
    const group = groups.get(instance) ?? [];
    group.push(n);
    groups.set(instance, group);
  }
  if (groups.size > 1) return { ok: false,
    reason: '表头字段 ' + key + ' 有 ' + groups.size + ' 个可见表单实例，认不出是哪一张单的',
    instances: all.length, visibleInstances: groups.size, visibleNodes: visible.length };
  const [instance, group] = groups.entries().next().value;
  const editors = group.filter((x) => x.id.endsWith(editorSuffix));
  if (editors.length > 1) return { ok: false,
    reason: '表头字段 ' + key + ' 的同一表单实例有 ' + editors.length + ' 个可见编辑控件，拒绝猜测',
    instances: all.length, visibleInstances: groups.size, visibleNodes: visible.length };
  const n = editors[0] || group[0];
  const nestedInputs = n.matches('input,textarea') ? [n] : [...n.querySelectorAll('input,textarea')];
  if (nestedInputs.length > 1) return { ok: false,
    reason: '表头字段 ' + key + ' 的可见编辑控件不唯一，拒绝猜测',
    instances: all.length, visibleInstances: groups.size, visibleNodes: visible.length };
  const input = nestedInputs[0] || null;
  const t = input || n;
  const b = t.getBoundingClientRect();
  return { ok: true, id: n.id, instance, tag: t.tagName, instances: all.length, visibleInstances: groups.size,
    visibleNodes: visible.length,
    value: String(input ? input.value : n.innerText).replace(/\\s+/g, ' ').trim(),
    x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2),
    inView: b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight };
})()`;

export type HeaderRead = { ok: true; id: string; instance: string; value: string } | { ok: false; reason: string };

/** Read one header field of the single visible form instance; `instance` is the form-instance UUID prefix. */
export const readHeaderField = (session: CdpSession, key: string) => evalIn<HeaderRead>(session, READ_HEADER(key));

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
