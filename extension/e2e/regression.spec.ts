// Seam 4 (spec #246 Testing Decisions), #259: the real-browser regression suite. A real Chromium with the extension an
// employee downloads from the real app, paired through its popup, runs 去报销 against the fake ERP's recorded pages,
// served on two sites so the 发票无忧助手 (invoice assistant) frame is genuinely cross-origin. This is the only place
// `chrome.debugger` and `DataTransfer` really execute. Two cases, and only two: a full 去报销 to hand-over, and a
// detach in the middle of one.
//
// WHAT A GREEN RUN DOES NOT PROVE. It runs against recorded HTML driven by `fake-erp-page.js`, not against piaozone or
// the live ERP. The #250 spike is still unrun: question 1 (can `chrome.debugger` reach the LIVE cross-origin assistant
// iframe) and question 2 (does a `DataTransfer` set in the page trigger the LIVE assistant's recognition) are
// unanswered. This suite guards the mechanism — the adapter's child-target route and the in-page upload working in a
// real browser — not the live answer; do not read it as the spike's result.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { jobEnded, test, type App, type Client } from './app';
import { DETACHED_MID_COMMAND } from '@baox/channel/job-link';
import { detachLikeChrome, type ErpSites } from './harness';

type ErpRecord = { mutations: Array<{ kind: string; detail: string }>; importMode: string | null };

const generated = (file: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`../../fixtures/generated/${file}`, import.meta.url))));
// A 全季酒店 e-invoice and its folio (@baox/fixtures m01/m02), on one project: one line, one invoice.
const INVOICE = { name: '全季酒店_发票.pdf', bytes: generated('m01-hotel-invoice.pdf') };
const FOLIO = { name: '全季酒店_结账单.pdf', bytes: generated('m02-hotel-folio.pdf') };
const PROJECT = { number: 'P-2307', name: '华东客户交付' };
const RECEIPT_NUMBER = 'SPD202609150001';

/**
 * A task ready for 去报销, and the fake ERP stocked to recognise its invoice by its bytes' sha256 — the only way a
 * row reaches the assistant's grid, so an import proves the bytes came through the file input intact.
 */
async function readyTask(app: App, employee: Client, erp: ErpSites) {
  const ready = await app.confirmedTask(employee, { files: [INVOICE, FOLIO], project: PROJECT, purpose: '上海产品评审出差' });
  const [line] = ready.lines;
  if (!line) throw new Error('expected one line');
  const face = Object.fromEntries(ready.materials.find((m) => m.materialId === line.voucherMaterialId)!.fields.map((field) => [field.key, field.value]));
  erp.stock({
    invoices: [{
      sha256: createHash('sha256').update(INVOICE.bytes).digest('hex'), invoiceNumber: face['invoiceNumber']!, receiptNumber: RECEIPT_NUMBER,
      seller: face['sellerName'] ?? '全季酒店', issueDate: face['issueDate'] ?? line.date,
      net: line.netAmount!, tax: line.taxAmount!, gross: line.grossAmount!, category: '全电普通发票',
    }],
    projects: [{ code: PROJECT.number, name: PROJECT.name }],
    expenseItems: [{ code: 'FY010001', name: '住宿' }],
  });
  return ready;
}

/** The ERP tab the job opened, as the employee finds it afterwards. */
const jobTab = (pages: Page[], erp: ErpSites) => {
  const found = pages.find((page) => page.url().startsWith(erp.entry));
  if (!found) throw new Error('the job left no ERP tab open');
  return found;
};

const recordOf = (page: Page) => page.evaluate(() => (window as unknown as { fakeErp: ErpRecord }).fakeErp);

const formOf = (page: Page) => page.evaluate(() => ({
  tab: document.querySelector('.form-tab')?.textContent,
  billNo: document.querySelector<HTMLInputElement>('[id$="-FBILLNO-EDITOR"]')?.value,
  purpose: document.querySelector<HTMLInputElement>('[id$="-FCAUSA-EDITOR"]')?.value,
}));

// A full run takes the extension's real pace (`DEFAULT_PACE`: settle sleeps of 1.2 s and more) plus parsing the originals.
test.describe.configure({ timeout: 300_000 });

test('去报销 reaches ERP 单据已交接 through the assistant, with the form filled and never saved', async ({ erp, app, employee, extension }) => {
  const ready = await readyTask(app, employee, erp);

  const done = await app.goReimburse(employee, ready);

  // The server's strict read-back matched at every stage and the bill was handed over (ERP 单据已交接).
  expect(done.erp.abortReason, JSON.stringify(done.erp)).toBeNull();
  expect(done).toMatchObject({ stage: 'done', erp: { status: 'done' }, readback: { status: 'matched' } });

  const page = jobTab(extension.context.pages(), erp);
  const { mutations, importMode } = await recordOf(page);
  // The invoice went through the assistant in the mode that leaves 费用明细 alone, and was imported once.
  expect(importMode).toBe('不生成费用明细');
  expect(mutations.filter((m) => m.kind === 'import')).toEqual([{ kind: 'import', detail: RECEIPT_NUMBER }]);
  expect(mutations.some((m) => m.kind === 'cell')).toBe(true);
  // ADR-0028: baox never clicks 保存. The fake ERP recorded no save, and the form is still the unsaved 新增 bill.
  expect(mutations.filter((m) => m.kind === 'save')).toEqual([]);
  expect(await formOf(page)).toEqual({ tab: '费用报销单-新增', billNo: '', purpose: '上海产品评审出差' });
});

// Where the detach lands decides what is right. Between two commands, #257 resumes in the same tab and the run can
// still reach hand-over. During the 发票导入单据 click — after `attempt_started` is durable, on the one irreversible act
// — nobody can know whether the click took effect, so the job must not go on, and the server, holding an attempt,
// makes it 对账 (reconcile). That is the point where a wrong answer costs the employee a duplicate import, so it is
// the point this case takes. Chrome fails the in-flight click with "Detached while handling command." BEFORE it raises
// `onDetach` (measured 2026-09-21); the adapter takes that failure as the detach itself, so the job ends the designed
// way — resumed, re-observed, then the link's own `debugger_detached_mid_command` — and not on the executor's catch of
// Chrome's English error. This case asserts both the 对账 and that designed code.
test('a detach during the 发票导入单据 click ends in 对账, and nothing is imported twice', async ({ erp, app, employee, extension }) => {
  const ready = await readyTask(app, employee, erp);
  // Every onDetach Chrome raises, as the extension hears it.
  await extension.worker.evaluate(() => {
    const seen: string[] = [];
    (self as unknown as { harnessDetaches: string[] }).harnessDetaches = seen;
    chrome.debugger.onDetach.addListener((_source, reason) => seen.push(reason));
  });
  // The click's `Input.dispatchMouseEvent` is in flight while this runs. Chrome takes the debugger away, and the click
  // is let through only once the server has decided the job — so the import lands after the decision, not before it.
  let released: Promise<unknown> = Promise.resolve();
  erp.onImportClick(() => {
    released = (async () => {
      await detachLikeChrome(jobTab(extension.context.pages(), erp));
      await app.until(employee, ready.task.taskId, jobEnded, 60_000);
    })();
    return released.then(() => undefined);
  });

  // Well inside the 120 s reconnection window: a job that ended only when the window expired would fail here.
  const outcome = await app.goReimburse(employee, ready, 60_000);
  await released;

  expect(await extension.worker.evaluate(() => (self as unknown as { harnessDetaches: string[] }).harnessDetaches)).toEqual(['target_closed']);
  // 对账 is what an attempt on record calls for: without one the server would have ended the job `aborted` in place.
  expect(outcome).toMatchObject({ stage: 'reconcile', reconcile: { status: 'pending' } });
  // The designed path ended it, and the employee reads why in Chinese, not Chrome's words.
  expect(outcome.erp.abortReason).toContain(DETACHED_MID_COMMAND.message);
  expect(outcome.erp.abortReason).not.toMatch(/Detached|executor_error/);

  const page = jobTab(extension.context.pages(), erp);
  // The held click's import lands on the ERP page once let through.
  await expect.poll(async () => (await recordOf(page)).mutations.map((m) => m.kind)).toContain('import');
  // Nothing else was written, before the break or after it: no second import, no fill, no save.
  expect((await recordOf(page)).mutations).toEqual([{ kind: 'import', detail: RECEIPT_NUMBER }]);
});
