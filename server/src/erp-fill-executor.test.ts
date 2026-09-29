import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataDirBlobs } from './erp/cdp-executor';
import { runFillJob } from '@baox/erp-executor/job';
import { createFakeErp, type FakeErp, type FakeErpOptions } from '@baox/erp-executor/testing/fake-erp';
import type { FillExecutor } from './erp/fill-jobs';
import { COMPATIBILITY, ERP_ACCOUNT, ERP_ORIGIN, FAST_PACE } from '@baox/erp-executor/testing/scenario';
import type { TestClient } from './test/harness';
import { scenario, scenarioServer, type Scene, type ScenarioServer } from './test/scenario';
import { fakeErpFor, SCENE_RECEIPT_NUMBER } from './test/scene-erp';
import { attemptedActions } from './test/erp-records';

// The real executor (`runFillJob`) on the fake ERP, with the fill plan and the judge built from the task's confirmed
// facts (#191): the preview identity is the probed ERP account, the invoices travel by content from the data directory.
// The approved preview and the ERP action attempts (动作尝试) are read from the database: the snapshot shows neither.


let server: ScenarioServer;
let alice: TestClient;
let fakeOptions: FakeErpOptions;
let fake: FakeErp | null = null;
const executor: FillExecutor = async (plan, channel) => {
  fake = await createFakeErp(fakeOptions);
  return runFillJob(plan, { browser: fake.browser, blobs: dataDirBlobs(server.dataDir), channel, pace: FAST_PACE, probeWaitMs: 0 });
};

beforeEach(async () => {
  fake = null;
  server = await scenarioServer({ erpExecutor: executor, erpConfig: { origin: ERP_ORIGIN, compatibility: COMPATIBILITY } });
  alice = await server.signIn('alice');
});
afterEach(() => server.close());

// The default scene at 去报销 (hotel e-invoice + folio on P-2307, confirmed), on a fake ERP that knows its invoice.
async function actionsOnFakeErp(assumeReceiptLink: boolean): Promise<Scene> {
  const scene = await scenario(server, alice).at('actions');
  fakeOptions = fakeErpFor(scene.reached, { assumeReceiptLink });
  return scene;
}

describe('去报销 with the real executor on the fake ERP', () => {
  it('imports and fills a form that passes the strict read-back, then hands it over unsaved: done', async () => {
    const scene = await actionsOnFakeErp(true);
    const done = await scene.run('start-erp-write');
    expect(done.erp.abortReason, JSON.stringify(done.erp)).toBeNull();
    expect(done).toMatchObject({ stage: 'done', erp: { status: 'done', erpAccount: ERP_ACCOUNT }, readback: { status: 'matched' } });
    // Nothing was saved, so there is no 单据编号 (bill number) — the strict read-back rows are the evidence instead.
    expect(done.erp.draftNo).toBeNull();
    expect(done.readback.rows).toHaveLength(done.lines.length);
    expect(done.readback.rows[0]!.fields.find((field) => field.label === '收票单号')?.erp).toBe(SCENE_RECEIPT_NUMBER);
    expect(fake!.mutations.some((mutation) => mutation.kind === 'save')).toBe(false);
    const preview = await server.db.selectFrom('erp_approved_preview').select('preview').executeTakeFirstOrThrow();
    expect(JSON.parse(preview.preview)).toMatchObject({ taskId: scene.task.taskId, identity: { account: ERP_ACCOUNT.account, tenant: ERP_ACCOUNT.tenant } });
  });

  it('starts no 保存 动作尝试 and records no save mutation: baox cannot commit the 费用报销单 (ADR-0028)', async () => {
    const scene = await actionsOnFakeErp(true);
    expect((await scene.run('start-erp-write')).stage).toBe('done');

    expect((await attemptedActions(server.db, scene.task.taskId)).sort()).toEqual(['fill', 'import']);
    expect(fake!.mutations.some((mutation) => mutation.kind === 'save')).toBe(false);
    // ERP still shows the 新增 (new) tab: the 费用报销单 never reached the ERP's database.
    expect(fake!.document.querySelector('.form-tab')!.textContent).toBe('费用报销单-新增');
  });

  // V-54, all the way out to what the employee reads. A 处理结果 window that will not close leaves the import
  // complete and the fill unable to start; `unknown` is the honest protocol answer, because a durable attempt
  // exists and the 费用报销单 is not finished. What must NOT happen is the employee being told 「结果不确定」 about
  // ten invoices that are demonstrably bound.
  it('tells the employee the invoices are bound and a window is in the way, not that the result is uncertain', async () => {
    const scene = await actionsOnFakeErp(true);
    fakeOptions = { ...fakeOptions, importReportStaysOpen: true };
    const stopped = await scene.run('start-erp-write');
    expect(stopped.erp.status).toBe('aborted');
    expect(stopped.erp.abortReason).toContain('发票已经全部导入并绑定');
    expect(stopped.erp.abortReason).toContain('处理结果');
    expect(stopped.erp.abortReason).not.toContain('结果不确定');
    // The fill never started, so there is one attempt, not two, and the form was never written to.
    expect(await attemptedActions(server.db, scene.task.taskId)).toEqual(['import']);
    expect(fake!.mutations.map((mutation) => mutation.kind)).toEqual(['import']);
  });

  // In 「不生成费用明细」 mode ERP leaves 收票单号 empty on every 费用明细行 (research, and reproduced live on 13
  // rows). That link was once required, and a wholly correct form ended as 结果不确定 because of it. Since the
  // owner's 2026-09-20 decision the read-back compares the form's totals, so the same form is handed over.
  it('hands over a form whose 收票单号 ERP left empty on the detail rows, because the totals agree', async () => {
    const scene = await actionsOnFakeErp(false);
    const done = await scene.run('start-erp-write');
    expect(done.erp.abortReason, JSON.stringify(done.erp)).toBeNull();
    expect(done).toMatchObject({ stage: 'done', erp: { status: 'done' }, readback: { status: 'matched' } });
    expect(fake!.mutations.some((mutation) => mutation.kind === 'save')).toBe(false);
  });
});
