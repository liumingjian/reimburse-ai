import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildFillJob } from './erp/fill-plan';
import { DEFAULT_ERP_CONFIG } from './erp/config';
import { planPages } from './print/layout';
import { paymentScreenshots } from './test/payment-screenshots';
import { presetParser } from './test/parse-presets';
import { api, sample } from './test/api';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';
let server: ScenarioServer;
beforeEach(async () => { server = await scenarioServer(); });
afterEach(() => server.close());
it('requires actual stay dates after confirming no folio and accepts same-day stays without screenshots', async () => {
  const scene = await scenario(server).at('pending', { materials: ['m01'] });
  const item = scene.reached.pendingItems.find((item) => item.itemId.startsWith('stay_folio_missing.'))!;
  const absent = await scene.accept('answer-pending', { itemId: item.itemId, answer: { choice: 'confirm_none' } });
  expect(absent.stage).toBe('pending');
  expect(absent.pendingItems.find((entry) => entry.itemId === item.itemId)).toMatchObject({ status: 'open', answer: { choice: 'confirm_none' } });
  expect(await scene.refused('answer-pending', { itemId: item.itemId, answer: { choice: 'manual_fill', checkIn: '2026-08-13', checkOut: '2026-08-12' } })).toMatchObject({ code: 'check_failed' });
  const done = await scene.accept('answer-pending', { itemId: item.itemId, answer: { choice: 'manual_fill', checkIn: '2026-08-12', checkOut: '2026-08-12' } });
  expect(done.stage).toBe('project');
  expect(done.lines[0]).toMatchObject({ date: '2026-08-12', endDate: '2026-08-12', grossAmount: '3640.00', referenceMaterialIds: [] });
  expect(done.pendingItems.some(entry => entry.itemId.startsWith('stay_screenshot_missing.'))).toBe(false);
  expect(done.materials[0]!.fields).toEqual(scene.reached.materials[0]!.fields);
});

for (const resolution of ['adopt_folio', 'exclude']) {
  it(`resolves late conflicting folio dates explicitly with ${resolution}`, async () => {
    const scene = await scenario(server).at('pending', { materials: ['m01'] });
    const item = scene.reached.pendingItems.find((item) => item.itemId.startsWith('stay_folio_missing.'))!;
    await scene.accept('answer-pending', { itemId: item.itemId, answer: { choice: 'manual_fill', checkIn: '2026-08-10', checkOut: '2026-08-20' } });
    await scene.accept('reopen-upload');
    await api(() => scene.client).upload(scene.task.taskId, [sample('m02')]);
    const late = await scene.run('start-inventory');
    const conflict = late.pendingItems.find((item) => item.itemId.startsWith('stay_dates_conflict.'))!;
    expect(conflict.why).toContain('2026-08-10 至 2026-08-20');
    expect(conflict.why).toContain('2026-08-09 至 2026-08-22');
    expect(late.lines[0]).toMatchObject({ date: '2026-08-10', endDate: '2026-08-20' });
    const done = await scene.accept('answer-pending', { itemId: conflict.itemId, answer: { choice: resolution } });
    expect(done.stage).toBe('project');
    expect(done.pendingItems.find(entry => entry.itemId === item.itemId)).toMatchObject({ status: 'resolved', expenseDetails: expect.any(Array) });
    expect(done.lines[0]).toMatchObject(resolution === 'adopt_folio' ? { date: '2026-08-09', endDate: '2026-08-22' } : { date: '2026-08-10', endDate: '2026-08-20', referenceMaterialIds: [] });
  });
}

it('prints and sends adopted dates to ERP with only the actual invoice original', async () => {
  const scene = await scenario(server).at('pending', { materials: ['m01'] });
  const item = scene.reached.pendingItems.find((item) => item.itemId.startsWith('stay_folio_missing.'))!;
  await scene.accept('answer-pending', { itemId: item.itemId, answer: { choice: 'manual_fill', checkIn: '2026-08-10', checkOut: '2026-08-20' } });
  const assigned = await scene.accept('submit-project-assignment', { purpose: '住宿日期验证', projects: { [scene.reached.lines[0]!.lineId]: 'P-2307' } });
  const confirmed = await scene.accept('confirm-review', { digest: assigned.confirmation.digest });
  expect(planPages(confirmed.lines, confirmed.materials)[0]).toMatchObject({ date: '2026-08-10', bottomMaterialId: null, droppedMaterialIds: [] });
  const printed = await scene.accept('generate-print-sheet', {});
  expect(printed.printSheet.pages[0]).toMatchObject({ bottom: null });
  expect(printed.printSheet.notices).toEqual([]);
  const invoice = confirmed.materials[0]!;
  const job = buildFillJob({ taskId: scene.task.taskId, jobId: 'lodging-test', versionId: 'v1', homeCity: '杭州', purpose: '住宿日期验证', lines: confirmed.lines,
    materials: [{ materialId: invoice.materialId, kind: invoice.kind, fileName: invoice.fileName, sha256: 'a'.repeat(64), mime: 'application/pdf' }],
    claims: [{ key: 'einvoice-20:26312000000098127734', materialId: invoice.materialId, fileName: invoice.fileName, at: '', seq: 1 }], config: DEFAULT_ERP_CONFIG });
  expect(job.ok).toBe(true);
  if (job.ok) expect(job.job.judge.lines[0]).toMatchObject({ date: '2026-08-10', endDate: '2026-08-20', referenceMaterialIds: [] });
});

it('assigns supplied screenshots against the adopted manual stay interval', async () => {
  await server.close();
  const shots = paymentScreenshots();
  const payment = shots.upload('实际住宿支付.png', { amount: '3640.00', payDate: '2026-09-15' });
  server = await scenarioServer({ parser: presetParser(shots.outcomes) });
  const scene = await scenario(server).at('pending', { materials: ['m01'] });
  const item = scene.reached.pendingItems.find((item) => item.itemId.startsWith('stay_folio_missing.'))!;
  await scene.accept('answer-pending', { itemId: item.itemId, answer: { choice: 'manual_fill', checkIn: '2026-09-15', checkOut: '2026-09-20' } });
  await scene.accept('reopen-upload');
  await api(() => scene.client).upload(scene.task.taskId, [payment]);
  const done = await scene.run('start-inventory');
  expect(done.stage).toBe('project');
  expect(done.materials.find((material) => material.fileName === payment.name)?.payment).toMatchObject({ invoiceId: item.materialId, chosen: false });
});

it('editing manual dates after folio adoption requires a fresh source decision', async () => {
  const scene = await scenario(server).at('pending', { materials: ['m01'] });
  const item = scene.reached.pendingItems[0]!;
  await scene.accept('answer-pending', { itemId: item.itemId, answer: { choice: 'manual_fill', checkIn: '2026-08-10', checkOut: '2026-08-20' } });
  await scene.accept('reopen-upload');
  await api(() => scene.client).upload(scene.task.taskId, [sample('m02')]);
  const late = await scene.run('start-inventory');
  const conflict = late.pendingItems.find(entry => entry.itemId.startsWith('stay_dates_conflict.'))!;
  await scene.accept('answer-pending', { itemId: conflict.itemId, answer: { choice: 'adopt_folio' } });
  const edited = await scene.accept('answer-pending', { itemId: item.itemId, answer: { choice: 'manual_fill', checkIn: '2026-08-11', checkOut: '2026-08-21' } });
  expect(edited.lines[0]).toMatchObject({ date: '2026-08-11', endDate: '2026-08-21' });
  expect(edited.pendingItems.find(entry => entry.itemId.startsWith('stay_dates_conflict.'))).toMatchObject({ status: 'open', answer: null });
});
