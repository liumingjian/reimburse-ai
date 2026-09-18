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
  expect((await alice.post('/api/project-book/intake', { number: 'P-2307' })).status).toBe(200);
});
afterEach(() => server.close());
const client = api(() => alice);

// Hotel e-invoice + folio on P-2307, confirmed; the fake ERP knows the invoice by its bytes and face amounts.
async function confirmed(assumeReceiptLink: boolean): Promise<TaskSnapshot> {
  const invoice = sample('m01');
  const { task } = await client.createTask('杭州');
  const uploaded = await client.upload(task.taskId, [invoice, sample('m02')]);
  await client.accepted(await client.act(uploaded, 'start-inventory'));
  const done = await client.settled(task.taskId);
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
  const deadline = Date.now() + 20_000;
  for (;;) {
    const snapshot = await client.current(taskId);
    if (snapshot.erp.status !== 'running') return snapshot;
    if (Date.now() > deadline) throw new Error('ERP job still running');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('去报销 with the real executor on the fake ERP', () => {
  it('imports, fills and saves a draft that passes the strict read-back: done', async () => {
    const ready = await confirmed(true);
    await client.accepted(await client.act(ready, 'start-erp-write'));
    const done = await settledErp(ready.task.taskId);
    expect(done.erp.abortReason, JSON.stringify(done.erp)).toBeNull();
    expect(done).toMatchObject({ stage: 'done', erp: { status: 'done', erpAccount: ERP_ACCOUNT }, readback: { status: 'matched' } });
    expect(done.erp.draftNo).toEqual(expect.any(String));
    expect(done.readback.rows[0]!.fields.find((field) => field.label === '收票单号')?.erp).toBe(RECEIPT_NUMBER);
    expect(fake!.mutations.some((mutation) => mutation.kind === 'save')).toBe(true);
    const preview = await server.db.selectFrom('erp_approved_preview').select('preview').executeTakeFirstOrThrow();
    expect(JSON.parse(preview.preview)).toMatchObject({ taskId: ready.task.taskId, identity: { account: ERP_ACCOUNT.account, tenant: ERP_ACCOUNT.tenant } });
  });

  it('stops before save when ERP leaves 收票单号 empty on the detail rows (as research recorded): reconcile, saying why', async () => {
    const ready = await confirmed(false);
    await client.accepted(await client.act(ready, 'start-erp-write'));
    const stopped = await settledErp(ready.task.taskId);
    expect(stopped).toMatchObject({ stage: 'reconcile', erp: { status: 'aborted' } });
    expect(stopped.erp.abortReason).toContain(RECEIPT_LINK_NOTE);
    expect(fake!.mutations.some((mutation) => mutation.kind === 'save')).toBe(false);
  });
});
