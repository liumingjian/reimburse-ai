import { afterEach, beforeEach, expect, it } from 'vitest';
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
    expect(done.lines[0]).toMatchObject(resolution === 'adopt_folio' ? { date: '2026-08-09', endDate: '2026-08-22' } : { date: '2026-08-10', endDate: '2026-08-20', referenceMaterialIds: [] });
  });
}
