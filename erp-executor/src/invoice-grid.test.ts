// Row selection in the 发票无忧助手 (invoice assistant), against the fake ERP's measured grid.
//
// Every shape asserted here was measured live on 2026-09-19 by `server/scripts/probe-grid.ts` and
// `probe-tick.ts`, on the real 报销系统 with a 12-invoice task, at the moment `INVOICE_SELECTION_UNCONFIRMED`
// aborted:
//   - the grid groups by 票种 into an antd tab strip (`数电票 10`, `数电票（铁路电子客票） 2`), one pane visible;
//   - a tick SURVIVES a switch (4/10 ticked -> switch away -> switch back -> still 4/10);
//   - the 已选取N张发票 footer counts UPLOADS, and did not move through a tick, an untick and two switches;
//   - rows 0-4 were inside the 800x530 iframe viewport, row 5 had an IMG painted over its tick point, and rows
//     6-9 were outside it, where `elementFromPoint` answers null and a real mouse event reaches nothing.
// The old loop snapshotted every row's coordinates once, clicked blind, and confirmed by COUNTING ticked boxes,
// so it ticked what happened to be in view, saw a count that never reached the total, and could not say why.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openInvoiceAssistant, openNewReimbursement, uploadInvoices, type WritePage } from './steps';
import { createFakeErp, type FakeErp, type FakeErpOptions, type FakeInvoice } from './testing/fake-erp';

// The executor may not import the rest of the server (ADR-0016), so the test pace is its own: the fake ERP
// answers at once, and the waits only need to be long enough to fail.
const FAST_PACE = { quietMs: 2, pollMs: 1, settleMs: 2, longMs: 2000 };

const PLAIN = '数电票';
const RAIL = '数电票（铁路电子客票）';

const invoice = (index: number, category: string, format = 'pdf'): FakeInvoice & { format: string } => ({
  bytes: new TextEncoder().encode(`%PDF-1.4\n% fake invoice ${index}\n%%EOF\n`),
  invoiceNumber: `264270000006405580${String(index).padStart(2, '0')}`,
  receiptNumber: `SPD20260919${String(index).padStart(4, '0')}`,
  seller: `销方 ${index}`, issueDate: '2026-09-04', net: '94.34', tax: '5.66', gross: '100.00',
  category, format,
});

// Four 数电票 then two 数电票（铁路电子客票）: the 12-invoice live task in miniature, same two 票种.
const SIX = [...[1, 2, 3, 4].map((i) => invoice(i, PLAIN)), ...[5, 6].map((i) => invoice(i, RAIL))];

let dir: string | null = null;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

function stage(invoices: Array<FakeInvoice & { format: string }>) {
  dir = mkdtempSync(join(tmpdir(), 'baox-grid-'));
  return invoices.map((one, index) => {
    const path = join(dir!, `${index + 1}-${one.invoiceNumber}.${one.format}`);
    writeFileSync(path, one.bytes);
    return path;
  });
}

async function assistantWith(overrides: Partial<FakeErpOptions> = {}, invoices = SIX) {
  const fake = await createFakeErp({ invoices, projects: [], expenseItems: [], ...overrides });
  const page: WritePage = { session: fake.session, pace: FAST_PACE };
  await openNewReimbursement(page, { timeoutMs: 2000 });
  await openInvoiceAssistant(page, { timeoutMs: 2000 });
  return { fake, page };
}

/** Every recognised row across every 票种 pane, hidden ones included: ticks live on the rows, not on the pane. */
const rows = (fake: FakeErp) =>
  [...fake.assistantDocument!.querySelectorAll('tbody[data-pane] tr')].map((tr: any) => ({
    pane: String(tr.parentElement.getAttribute('data-pane')),
    number: String(tr.children[2].textContent).trim(),
    checked: Boolean(tr.querySelector('input.ant-checkbox-input').checked),
  }));
const footer = (fake: FakeErp) => String(fake.assistantDocument!.querySelector('#assistant-selected').textContent).trim();
const tabs = (fake: FakeErp) => [...fake.assistantDocument!.querySelectorAll('.ant-tabs-tab')].map((n: any) => String(n.textContent).trim());
/** Real mouse presses that reached the assistant iframe. */
const presses = (fake: FakeErp) =>
  fake.commands.filter((c) => c.sessionId && c.method === 'Input.dispatchMouseEvent' && c.params['type'] === 'mousePressed');

const failure = (promise: Promise<unknown>) => promise.then(() => ({ code: null, message: '(没有失败)' }), (error: any) => ({ code: String(error.code), message: String(error.message) }));

describe('selecting the recognised rows across the 票种 panes', () => {
  it('ticks every row of every 票种, including the panes it has to switch to and the rows below the fold', async () => {
    const { fake, page } = await assistantWith();
    const result = await uploadInvoices(page, stage(SIX));

    expect(result).toMatchObject({ ok: true, selectedRows: 6 });
    expect(rows(fake).filter((row) => !row.checked)).toEqual([]);
    expect(rows(fake).map((row) => row.pane)).toEqual([PLAIN, PLAIN, PLAIN, PLAIN, RAIL, RAIL]);
    expect(tabs(fake)).toEqual([`${PLAIN} 4`, `${RAIL} 2`]);
    // One click per row, plus 电脑端选取, 知道了 and the one tab switch: nothing is clicked twice.
    expect(presses(fake)).toHaveLength(6 + 3);
  });

  it('leaves the 已选取N张发票 footer alone: it counts uploads, so it can never witness a tick', async () => {
    const { fake, page } = await assistantWith();
    const paths = stage(SIX);
    await uploadInvoices(page, paths);
    // Six ticks later the counter says exactly what it said with nothing ticked at all.
    expect(footer(fake)).toBe('已选取6张发票 所有已选发票已选0份附件');
    expect(rows(fake).every((row) => row.checked)).toBe(true);
  });

  it('refuses the whole import when a 票种 pane cannot be reached, rather than importing the pane it could reach', async () => {
    const { fake, page } = await assistantWith({ assistantPaneSwitchDead: true });
    const result = await failure(uploadInvoices(page, stage(SIX)));

    expect(result.code).toBe('INVOICE_GROUP_SWITCH_FAILED');
    expect(result.message).toContain(RAIL);
    expect(result.message).toContain('没有导入任何发票');
    expect(rows(fake).filter((row) => row.pane === RAIL).every((row) => row.checked)).toBe(false);
  });

  it('names the row and its 发票号码 when a tick does not confirm, and never re-fires at the same point', async () => {
    const dead = SIX[2]!;
    const { fake, page } = await assistantWith({ assistantDeadTickNumbers: [dead.invoiceNumber] });
    const result = await failure(uploadInvoices(page, stage(SIX)));

    expect(result.code).toBe('INVOICE_SELECTION_UNCONFIRMED');
    expect(result.message).toContain(dead.invoiceNumber);
    expect(result.message).toContain(PLAIN);
    expect(result.message).toContain('没有导入任何发票');
    // 电脑端选取 + 知道了 + two rows ticked + ONE click on the row that did not take: the point was re-measured
    // and came back the same, and a point already known to be wrong is not clicked a second time.
    expect(presses(fake)).toHaveLength(2 + 2 + 1);
  });

  it('names what is painted over a tick point instead of clicking into it', async () => {
    const covered = SIX[1]!;
    const { fake, page } = await assistantWith({ assistantCoveredTickNumbers: [covered.invoiceNumber] });
    const result = await failure(uploadInvoices(page, stage(SIX)));

    expect(result.code).toBe('INVOICE_SELECTION_OBSTRUCTED');
    expect(result.message).toContain(covered.invoiceNumber);
    expect(result.message).toContain('IMG');
    expect(rows(fake).find((row) => row.number === covered.invoiceNumber)!.checked).toBe(false);
    // The obstructed row is not clicked at all: 电脑端选取, 知道了 and the one row that ticked before it.
    expect(presses(fake)).toHaveLength(2 + 1);
  });

  it('refuses to import a partial selection when the assistant recognised fewer invoices than the task has', async () => {
    // The sixth file is bytes the assistant does not recognise, so its row never appears.
    const stranger = { ...invoice(9, RAIL), bytes: new TextEncoder().encode('%PDF-1.4\n% not an invoice\n%%EOF\n') };
    const { fake, page } = await assistantWith({}, SIX);
    const result = await failure(uploadInvoices(page, stage([...SIX.slice(0, 5), stranger])));

    expect(result.code).toBe('INVOICE_SELECTION_INCOMPLETE');
    expect(result.message).toBe('任务有 6 张发票，发票助手里只勾上了 5 张，拒绝只导入一部分。没有导入任何发票。');
    expect(rows(fake).filter((row) => row.checked)).toHaveLength(5);
  });

  it('waits for a second upload batch to be recognised, even though the first batch keeps the grid non-empty', async () => {
    // Two batches, because the assistant's file chooser takes one format at a time. The second batch's rows land
    // in a pane that is not showing, so `rows.length > 0` on the visible pane is true from the first batch onwards
    // and says nothing about whether the second has been recognised.
    const batched = [...[1, 2, 3, 4].map((i) => invoice(i, PLAIN)), ...[5, 6].map((i) => invoice(i, RAIL, 'png'))];
    const { fake, page } = await assistantWith({ assistantRecognitionTicks: 40 }, batched);
    const result = await uploadInvoices(page, stage(batched));

    expect(result).toMatchObject({ ok: true, selectedRows: 6 });
    expect(rows(fake).filter((row) => row.pane === RAIL).map((row) => row.checked)).toEqual([true, true]);
  });
});
