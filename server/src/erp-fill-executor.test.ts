import type { TaskSnapshot } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureCatalog } from './catalog/project-catalog';
import { dataDirBlobs } from './erp/cdp-executor';
import { runFillJob } from './erp/executor/job';
import { createFakeErp, type FakeErp, type FakeErpOptions } from './erp/executor/testing/fake-erp';
import type { FillExecutor } from './erp/fill-jobs';
import { RECEIPT_LINK_NOTE } from './erp/fill-plan';
import { COMPATIBILITY, ERP_ACCOUNT, ERP_ORIGIN, FAST_PACE, fakeErpOptions } from './erp/testing/scenario';
import { api, sample } from './test/api';
import { BACKSTOP_MS } from './test/deadlines';
import { createTestServer, type TestClient, type TestServer } from './test/harness';

// The real executor (`runFillJob`) on the fake ERP, with the fill plan and the judge built from the task's confirmed
// facts (#191): the preview identity is the probed ERP account, the invoices travel by content from the data directory.

const CATALOG = fixtureCatalog([{ number: 'P-2307', name: '华东客户交付', audited: true, forbidden: false }]);
const RECEIPT_NUMBER = 'SPD202609150001';

let server: TestServer;
let alice: TestClient;
let fakeOptions: FakeErpOptions;
let fake: FakeErp | null = null;
const executor: FillExecutor = async (plan, channel) => {
  fake = await createFakeErp(fakeOptions);
  return runFillJob(plan, { browser: fake.browser, blobs: dataDirBlobs(server.dataDir), channel, pace: FAST_PACE, probeWaitMs: 0 });
};

beforeEach(async () => {
  fake = null;
  server = await createTestServer({ projectCatalog: CATALOG, erpExecutor: executor, erpConfig: { origin: ERP_ORIGIN, compatibility: COMPATIBILITY } });
  alice = await server.signIn('alice');
  expect((await alice.post('/api/project-book/intake', { number: 'P-2307', name: '华东客户交付' })).status).toBe(200);
});
afterEach(() => server.close());
const client = api(() => alice);

// Hotel e-invoice + folio on P-2307, confirmed; the fake ERP knows the invoice by its bytes and face amounts.
async function confirmed(assumeReceiptLink: boolean): Promise<TaskSnapshot> {
  const invoice = sample('m01');
  const { task } = await client.createTask('杭州');
  const uploaded = await client.upload(task.taskId, [invoice, sample('m02')]);
  await client.accepted(await client.act(uploaded, 'start-inventory'));
  const done = await client.withoutStayGaps(await client.settled(task.taskId));
  const review = await client.accepted(await client.act(done, 'submit-project-assignment', { purpose: '上海产品评审出差', projects: Object.fromEntries(done.lines.map((line) => [line.lineId, 'P-2307'])) }));
  const ready = await client.accepted(await client.act(review, 'confirm-review', { digest: review.confirmation.digest }));
  const [line] = ready.lines;
  if (!line) throw new Error('expected one line');
  const face = Object.fromEntries(ready.materials.find((m) => m.materialId === line.voucherMaterialId)!.fields.map((field) => [field.key, field.value]));
  fakeOptions = fakeErpOptions({
    invoices: [{ bytes: new Uint8Array(invoice.bytes), invoiceNumber: face['invoiceNumber']!, receiptNumber: RECEIPT_NUMBER, seller: face['sellerName'] ?? '全季酒店', issueDate: face['issueDate'] ?? line.date, net: line.netAmount, tax: line.taxAmount, gross: line.grossAmount, category: '全电普通发票' }],
    projects: [{ code: 'P-2307', name: '华东客户交付' }],
    expenseItems: [{ code: 'FY010001', name: '住宿' }],
    assumeReceiptLink,
  });
  return ready;
}

async function settledErp(taskId: string): Promise<TaskSnapshot> {
  const deadline = Date.now() + BACKSTOP_MS;
  for (;;) {
    const snapshot = await client.current(taskId);
    if (snapshot.erp.status !== 'running') return snapshot;
    if (Date.now() > deadline) throw new Error('ERP job still running');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('去报销 with the real executor on the fake ERP', () => {
  it('imports and fills a form that passes the strict read-back, then hands it over unsaved: done', async () => {
    const ready = await confirmed(true);
    await client.accepted(await client.act(ready, 'start-erp-write'));
    const done = await settledErp(ready.task.taskId);
    expect(done.erp.abortReason, JSON.stringify(done.erp)).toBeNull();
    expect(done).toMatchObject({ stage: 'done', erp: { status: 'done', erpAccount: ERP_ACCOUNT }, readback: { status: 'matched' } });
    // Nothing was saved, so there is no 单据编号 (bill number) — the strict read-back rows are the evidence instead.
    expect(done.erp.draftNo).toBeNull();
    expect(done.readback.rows).toHaveLength(done.lines.length);
    expect(done.readback.rows[0]!.fields.find((field) => field.label === '收票单号')?.erp).toBe(RECEIPT_NUMBER);
    expect(fake!.mutations.some((mutation) => mutation.kind === 'save')).toBe(false);
    const preview = await server.db.selectFrom('erp_approved_preview').select('preview').executeTakeFirstOrThrow();
    expect(JSON.parse(preview.preview)).toMatchObject({ taskId: ready.task.taskId, identity: { account: ERP_ACCOUNT.account, tenant: ERP_ACCOUNT.tenant } });
  });

  it('starts no 保存 动作尝试 and records no save mutation: baox cannot commit the 费用报销单 (ADR-0028)', async () => {
    const ready = await confirmed(true);
    await client.accepted(await client.act(ready, 'start-erp-write'));
    expect((await settledErp(ready.task.taskId)).stage).toBe('done');

    const attempts = await server.db.selectFrom('erp_attempt').select('action').where('task_id', '=', ready.task.taskId).execute();
    expect(attempts.map((attempt) => attempt.action).sort()).toEqual(['fill', 'import']);
    expect(fake!.mutations.some((mutation) => mutation.kind === 'save')).toBe(false);
    // ERP still shows the 新增 (new) tab: the 费用报销单 never reached the ERP's database.
    expect(fake!.document.querySelector('.form-tab')!.textContent).toBe('费用报销单-新增');
  });

  // V-54, all the way out to what the employee reads. A 处理结果 window that will not close leaves the import
  // complete and the fill unable to start; `unknown` is the honest protocol answer, because a durable attempt
  // exists and the 费用报销单 is not finished. What must NOT happen is the employee being told 「结果不确定」 about
  // ten invoices that are demonstrably bound.
  it('tells the employee the invoices are bound and a window is in the way, not that the result is uncertain', async () => {
    const ready = await confirmed(true);
    fakeOptions = { ...fakeOptions, importReportStaysOpen: true };
    await client.accepted(await client.act(ready, 'start-erp-write'));
    const stopped = await settledErp(ready.task.taskId);
    expect(stopped.erp.status).toBe('aborted');
    expect(stopped.erp.abortReason).toContain('发票已经全部导入并绑定');
    expect(stopped.erp.abortReason).toContain('处理结果');
    expect(stopped.erp.abortReason).not.toContain('结果不确定');
    // The fill never started, so there is one attempt, not two, and the form was never written to.
    const attempts = await server.db.selectFrom('erp_attempt').select('action').where('task_id', '=', ready.task.taskId).execute();
    expect(attempts.map((attempt) => attempt.action)).toEqual(['import']);
    expect(fake!.mutations.map((mutation) => mutation.kind)).toEqual(['import']);
  });

  it('stops before the hand-over when ERP leaves 收票单号 empty on the detail rows (as research recorded): reconcile, saying why', async () => {
    const ready = await confirmed(false);
    await client.accepted(await client.act(ready, 'start-erp-write'));
    const stopped = await settledErp(ready.task.taskId);
    expect(stopped).toMatchObject({ stage: 'reconcile', erp: { status: 'aborted' } });
    expect(stopped.erp.abortReason).toContain(RECEIPT_LINK_NOTE);
    expect(fake!.mutations.some((mutation) => mutation.kind === 'save')).toBe(false);
  });
});
