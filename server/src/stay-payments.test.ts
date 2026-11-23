import { PAYMENT_COPY, STAY_TRIO_CONFIRM_PAID, type TaskSnapshot } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { placePayments, type PaymentShot, type PaymentStay } from './stay-payments';
import { api, byFileName, sample, type Upload } from './test/api';
import { type TestClient } from './test/harness';
import { presetParser } from './test/parse-presets';
import { paymentScreenshots, postStayScreenshots } from './test/payment-screenshots';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

// ADR-0032: 支付截图 materials are placed with the stay they were paid in, and a stay's screenshots are checked by sum.

const shot = (materialId: string, values: Record<string, string>): PaymentShot => ({ materialId, fileName: `${materialId}.jpg`, values: { amount: '100.00', ...values } });
const stay = (invoiceId: string, checkIn: string | null, checkOut: string | null, more: Partial<PaymentStay> = {}): PaymentStay => ({ invoiceId, totalAmount: '500.00', checkIn, checkOut, issueDate: checkOut, hotelNames: [], ...more });
const place = (shots: PaymentShot[], stays: PaymentStay[], choices = new Map<string, string>()) => placePayments(shots, stays, choices);

describe('placePayments', () => {
  const august = stay('aug', '2026-08-09', '2026-08-12');
  const september = stay('sep', '2026-09-16', '2026-09-18');

  it('places a payment made during the stay, a booking paid up to 30 days ahead, and one the day after check-out', () => {
    const placed = place([shot('during', { payDate: '2026-09-17' }), shot('ahead', { payDate: '2026-08-17' }), shot('after', { payDate: '2026-09-19' })], [september]);
    expect([...placed.assigned]).toEqual([['during', 'sep'], ['ahead', 'sep'], ['after', 'sep']]);
  });

  it('leaves a payment outside every window unplaced', () => {
    const placed = place([shot('early', { payDate: '2026-08-16' }), shot('late', { payDate: '2026-09-20' }), shot('undated', {})], [september]);
    expect(placed.unassigned).toEqual(['early', 'late', 'undated']);
  });

  it('takes the nearest of the stays it fits', () => {
    // Paid 2026-09-01: 20 days after August's check-out is out of its window; 15 days before September's is in it.
    // Paid 2026-08-13: one day after August, 34 days before September — only August.
    expect(place([shot('s', { payDate: '2026-08-13' })], [august, september]).assigned.get('s')).toBe('aug');
    const close = stay('close', '2026-09-20', '2026-09-21');
    expect(place([shot('s', { payDate: '2026-09-18' })], [september, close]).assigned.get('s')).toBe('sep');
  });

  it('breaks a tie by the payee naming the hotel, then by the amount fitting the invoice, and never rejects on the payee', () => {
    const left = stay('left', '2026-09-16', '2026-09-18', { hotelNames: ['示例某某酒店管理有限公司'], totalAmount: '100.00' });
    const right = stay('right', '2026-09-16', '2026-09-18', { hotelNames: ['另一家宾馆有限公司'], totalAmount: '900.00' });
    expect(place([shot('s', { payDate: '2026-09-17', payee: '示例某某酒店管理有限公司' })], [left, right]).assigned.get('s')).toBe('left');
    expect(place([shot('s', { payDate: '2026-09-17', payee: '高德酒店', amount: '500.00' })], [left, right]).assigned.get('s')).toBe('right');
    expect(place([shot('s', { payDate: '2026-09-17', payee: '高德酒店' })], [left]).assigned.get('s')).toBe('left');
  });

  it('leaves a tie nothing breaks to the filer', () => {
    const twin = { ...september, invoiceId: 'twin' };
    expect(place([shot('s', { payDate: '2026-09-17' })], [september, twin]).unassigned).toEqual(['s']);
  });

  it('without a folio, takes the invoice issue date for check-out', () => {
    const unpaired = stay('inv', null, null, { issueDate: '2026-09-18' });
    expect(place([shot('s', { payDate: '2026-09-01' })], [unpaired]).assigned.get('s')).toBe('inv');
  });

  it('a filer’s choice beats the derivation, unless it names no stay', () => {
    const shots = [shot('s', { payDate: '2026-09-17' })];
    expect(place(shots, [august, september], new Map([['s', 'aug']]))).toMatchObject({ assigned: new Map([['s', 'aug']]), chosen: new Set(['s']) });
    expect(place(shots, [august, september], new Map([['s', 'gone']]))).toMatchObject({ assigned: new Map([['s', 'sep']]), chosen: new Set() });
  });

  it('a later screenshot of the same payment is a duplicate and placed nowhere', () => {
    const byNumber = place([shot('a', { payDate: '2026-09-17', transactionNumber: 'T1' }), shot('b', { payDate: '2026-09-17', transactionNumber: 'T1' })], [september]);
    expect([...byNumber.duplicates]).toEqual([['b', { of: 'a', byNumber: true }]]);
    expect([...byNumber.assigned.keys()]).toEqual(['a']);
    const at = { payDate: '2026-09-17', payTime: '08:46:16' };
    expect([...place([shot('a', at), shot('b', at)], [september]).duplicates]).toEqual([['b', { of: 'a', byNumber: false }]]);
    // Different numbers are different payments, whatever the time; a time without seconds says too little.
    expect(place([shot('a', { ...at, transactionNumber: 'T1' }), shot('b', { ...at, transactionNumber: 'T2' })], [september]).duplicates.size).toBe(0);
    expect(place([shot('a', { payDate: '2026-09-17', payTime: '08:46' }), shot('b', { payDate: '2026-09-17', payTime: '08:46' })], [september]).duplicates.size).toBe(0);
  });
});

// Through the server: the 全季 invoice (m01, 价税合计 3640.00) and its folio (m02, 2026-08-09 to 2026-08-22), with
// screenshots the preset parser reads as `payment_screenshot/labelled`.
// The screenshots' outcomes are known only once a test has made them, so each test starts its own server.
let server: ScenarioServer | null = null;
let alice: TestClient;
let shots = paymentScreenshots();
beforeEach(() => {
  shots = paymentScreenshots();
});
afterEach(async () => {
  await server?.close();
  server = null;
});
const client = api(() => alice);
const screenshotUpload = (name: string, values: Record<string, string>) => shots.upload(name, values);

// `stage`: where the inventory leaves the task — `project` when nothing is left to answer.
async function inventory(uploads: Upload[], stage: 'pending' | 'project' = 'pending'): Promise<TaskSnapshot> {
  server = await scenarioServer({ parser: presetParser(shots.outcomes) });
  alice = await server.signIn('alice');
  return (await scenario(server, alice).at(stage, { materials: ['m01', 'm02', ...uploads] })).reached;
}

const item = (snapshot: TaskSnapshot, itemId: string) => snapshot.pendingItems.find((candidate) => candidate.itemId === itemId);
const answer = async (snapshot: TaskSnapshot, itemId: string, value: Record<string, string>) => client.accepted(await client.act(snapshot, 'answer-pending', { itemId, answer: value }));

describe('支付截图 at inventory', () => {
  it('two payments that cover the invoice complete the stay by themselves and show the overpayment', async () => {
    const start = await inventory([
      screenshotUpload('付款第1天.png', { amount: '1800.00', payDate: '2026-08-09', payTime: '13:01:12', payee: '高德酒店' }),
      screenshotUpload('付款第2天.png', { amount: '1900.00', payDate: '2026-08-15', payTime: '08:46:16' }),
    ], 'project');
    const invoice = byFileName(start, sample('m01').name);
    expect(item(start, `stay_screenshot_missing.${invoice.materialId}`)).toMatchObject({ status: 'resolved', answer: null });
    expect(invoice.checkText).toContain(PAYMENT_COPY.paidNote('3700.00', '3640.00'));
    expect(invoice.checkText).toContain('实付比发票多 60.00 元');
    for (const name of ['付款第1天.png', '付款第2天.png']) {
      const shotView = byFileName(start, name);
      expect(shotView).toMatchObject({ kind: 'payment_screenshot', role: 'reference', status: 'ok', linkedMaterialIds: [invoice.materialId], payment: { invoiceId: invoice.materialId, chosen: false } });
      expect(invoice.linkedMaterialIds).toContain(shotView.materialId);
    }
    expect(start.inventory.ungroupedMaterialIds).toEqual([]);
  });

  it('a shortfall waits for 「已传齐」', async () => {
    const start = await inventory([screenshotUpload('付款.png', { amount: '1000.00', payDate: '2026-08-10' })]);
    const invoice = byFileName(start, sample('m01').name);
    const itemId = `stay_screenshot_missing.${invoice.materialId}`;
    expect(item(start, itemId)).toMatchObject({ status: 'open', why: PAYMENT_COPY.shortfallWhy('1000.00', '3640.00', '2640.00') });
    const done = await answer(start, itemId, { choice: STAY_TRIO_CONFIRM_PAID });
    expect(item(done, itemId)).toMatchObject({ status: 'resolved' });
  });

  it('a screenshot paid outside the stay asks which stay it belongs to, and the answer places it', async () => {
    const start = await inventory([screenshotUpload('付款.png', { amount: '3640.00', payDate: '2026-01-01' })]);
    const invoice = byFileName(start, sample('m01').name);
    const shotView = byFileName(start, '付款.png');
    const itemId = `payment_unassigned.${shotView.materialId}`;
    expect(item(start, itemId)?.choices.map((choice) => choice.key)).toEqual([`stay:${invoice.materialId}`, 'exclude']);
    expect(shotView).toMatchObject({ status: 'pending', payment: { invoiceId: null } });
    const placed = await answer(start, itemId, { choice: `stay:${invoice.materialId}` });
    expect(byFileName(placed, '付款.png')).toMatchObject({ status: 'ok', payment: { invoiceId: invoice.materialId, chosen: true } });
    expect(item(placed, `stay_screenshot_missing.${invoice.materialId}`)).toMatchObject({ status: 'resolved' });
  });

  it('a second screenshot of one payment is raised as a duplicate and counted once', async () => {
    const values = { amount: '3640.00', payDate: '2026-08-10', transactionNumber: '4200000000202608100000000001' };
    const start = await inventory([screenshotUpload('付款.png', values), screenshotUpload('付款-重复.png', values)]);
    const duplicate = byFileName(start, '付款-重复.png');
    expect(item(start, `payment_duplicate.${duplicate.materialId}`)).toMatchObject({ status: 'open', choices: [{ key: 'exclude', label: '排除这份材料' }] });
    expect(byFileName(start, sample('m01').name).checkText).toContain(PAYMENT_COPY.paidNote('3640.00', '3640.00'));
  });

  it('改归属 is a field edit that only takes a stay of this claim', async () => {
    const start = await inventory([screenshotUpload('付款.png', { amount: '3640.00', payDate: '2026-08-10' })], 'project');
    const invoice = byFileName(start, sample('m01').name);
    const shotView = byFileName(start, '付款.png');
    const address = `edit.${shotView.materialId}.stay`;
    const refused = await client.act(start, 'answer-pending', { itemId: address, answer: { value: 'not-a-stay' } });
    expect(refused.status).toBe(400);
    const moved = await answer(start, address, { value: invoice.materialId });
    expect(byFileName(moved, '付款.png').payment).toMatchObject({ invoiceId: invoice.materialId, chosen: true });
  });
});

// ADR-0032: the 待确认项's upload is a batch placed with its invoice, and inventory runs again over it.
describe('支付截图 from the 待确认项', () => {
  it('adds a batch placed with the invoice, inventories again, and the stay settles by sum', async () => {
    const files = [
      screenshotUpload('付款第1天.png', { amount: '1800.00', payDate: '2026-08-09' }),
      screenshotUpload('付款第2天.png', { amount: '1840.00', payDate: '2026-08-30' }),
    ].map((upload) => new File([upload.bytes], upload.name, { type: 'image/png' }));
    server = await scenarioServer({ parser: presetParser(shots.outcomes) });
    alice = await server.signIn('alice');
    const scene = await scenario(server, alice).at('project', { materials: ['m01', 'm02'] });
    const invoice = byFileName(scene.reached, sample('m01').name);

    const started = await client.accepted(await postStayScreenshots(alice, scene.reached, invoice.materialId, files));
    expect(started.inventory.status).toBe('running');
    const done = await scene.settled();
    // 2026-08-30 is 8 days after check-out, outside every window: the second is placed only because the upload placed
    // both with this invoice, as the filer's choice.
    for (const name of ['付款第1天.png', '付款第2天.png']) expect(byFileName(done, name)).toMatchObject({ kind: 'payment_screenshot', status: 'ok', payment: { invoiceId: invoice.materialId, chosen: true } });
    expect(item(done, `stay_screenshot_missing.${invoice.materialId}`)).toMatchObject({ status: 'resolved', answer: null });
    expect(done.stage).toBe('project');

    // The same files again add nothing.
    const again = await postStayScreenshots(alice, done, invoice.materialId, files);
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('duplicate_content');
  });

  it('takes images only, and only for a 住宿 invoice', async () => {
    server = await scenarioServer();
    alice = await server.signIn('alice');
    const start = (await scenario(server, alice).at('project', { materials: ['m01', 'm02'] })).reached;
    const [invoice, folio] = [byFileName(start, sample('m01').name), byFileName(start, sample('m02').name)];
    const code = async (response: Response) => ((await response.json()) as { error: { code: string } }).error.code;
    expect(await code(await postStayScreenshots(alice, start, invoice.materialId, [new File([Buffer.from('%PDF-1.4')], '支付记录.pdf', { type: 'application/pdf' })]))).toBe('not_image');
    expect(await code(await postStayScreenshots(alice, start, folio.materialId, [new File([shots.upload('x.png', {}).bytes], 'x.png', { type: 'image/png' })]))).toBe('screenshot_not_applicable');
    expect((await client.current(start.task.taskId)).inventory.status).toBe('done');
  });
});
