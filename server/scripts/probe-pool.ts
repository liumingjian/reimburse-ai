// Read-only question: do invoices uploaded but never imported stay in the 发票无忧助手's list for the next run?
// It matters because `uploadInvoices` refuses to start when the assistant already holds rows
// (`INVOICE_ASSISTANT_NOT_EMPTY`), so leftovers from a failed run would block every later 去报销.
//
// Closes the assistant, closes the spent 费用报销单-新增 tab, opens a fresh form and a fresh assistant, walks to the
// upload view and counts the rows it finds. Uploads nothing and imports nothing.

import { autoAttach, clickAt, connect, evalIn, targets } from '@baox/erp-executor/cdp';
import { cdpPortOf } from '@baox/erp-executor/chromium';
import { closeInvoiceAssistant, openInvoiceAssistant, openNewReimbursement, type WritePage } from '@baox/erp-executor/steps';

const VIS = `(n) => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n);
  return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; }`;

const PICKER = `(() => {
  const vis = ${VIS};
  const own = (n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join('').trim();
  const caption = [...document.querySelectorAll('body *')].find((n) => vis(n) && own(n) === '电脑端选取');
  if (!caption) return { ok: false };
  const item = caption.closest('.accessItem') || caption.parentElement;
  const anchors = item ? [...item.querySelectorAll('a[href]')] : [];
  if (anchors.length !== 1) return { ok: false };
  const b = [anchors[0], ...anchors[0].querySelectorAll('*')].map((n) => n.getBoundingClientRect()).find((r) => r.width > 0 && r.height > 0);
  return b ? { ok: true, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } : { ok: false };
})()`;

const STATE = `(() => {
  const vis = ${VIS};
  const own = (n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join('').trim();
  return {
    url: location.href.split('?')[0],
    hasUploadTab: [...document.querySelectorAll('body *')].some((n) => vis(n) && own(n) === '上传发票影像'),
    dataRows: [...document.querySelectorAll('input.ant-checkbox-input')].filter((n) => vis(n) && !n.closest('thead')).length,
    tbodyRows: document.querySelectorAll('tbody tr').length,
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
  };
})()`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const all = await targets(cdpPortOf());
const erp = all.find((t) => t.type === 'page' && String(t.url).includes('erp.antute.com.cn'));
if (!erp) { console.error('no ERP page open'); process.exit(1); }
const session = await connect(erp.webSocketDebuggerUrl!);
try {
  const page: WritePage = { session, children: await autoAttach(session) };
  console.log('close assistant:', JSON.stringify(await closeInvoiceAssistant(page)));
  await sleep(1500);
  const closed = await evalIn<{ ok: boolean; reason?: string }>(session, `(() => {
    const vis = ${VIS};
    const tab = [...document.querySelectorAll('li.k-item')].filter(vis).find((n) => String(n.textContent || '').trim() === '费用报销单-新增');
    if (!tab) return { ok: false, reason: 'no tab' };
    const closer = [...tab.querySelectorAll('span.mainTabCloseButton')].filter(vis);
    if (closer.length !== 1) return { ok: false, reason: 'closer ' + closer.length };
    closer[0].click();
    return { ok: true };
  })()`);
  console.log('close spent tab:', JSON.stringify(closed));
  await sleep(3000);
  console.log('fresh form:', JSON.stringify(await openNewReimbursement(page, { timeoutMs: 45_000 })));
  console.log('fresh assistant:', JSON.stringify(await openInvoiceAssistant(page, { timeoutMs: 90_000 })));
  await sleep(12_000);

  // Reuse the page's own children map: a second autoAttach starts empty and misses targets already attached.
  const assistant = await page.children!.waitFor((url) => url.includes('piaozone'), { timeout: 30_000 });
  if (!assistant) { console.error('no assistant session'); process.exit(1); }
  const point = await evalIn<{ ok: boolean; x: number; y: number }>(assistant, PICKER);
  console.log('picker:', JSON.stringify(point));
  if (!point?.ok) process.exit(1);
  await clickAt(assistant, point.x, point.y);
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    const state = await evalIn<{ hasUploadTab: boolean }>(assistant, STATE);
    if (state?.hasUploadTab) { console.log('upload view:', JSON.stringify(state)); process.exit(0); }
  }
  console.log('upload view never appeared:', JSON.stringify(await evalIn(assistant, STATE)));
  process.exit(1);
} finally {
  session.close();
}
