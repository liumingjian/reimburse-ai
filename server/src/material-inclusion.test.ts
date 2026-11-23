import { afterEach, beforeEach, expect, it } from 'vitest';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

let server: ScenarioServer;
beforeEach(async () => { server = await scenarioServer(); });
afterEach(() => server.close());

it('restores the same invoice and recomputes its expense lines', async () => {
  const scene = await scenario(server).at('review');
  const original = scene.reached;
  const invoice = original.lines[0]!.voucherMaterialId;
  const excluded = await scene.accept('exclude-material', { materialId: invoice });
  expect(excluded.materials.find(m => m.materialId === invoice)?.status).toBe('excluded');
  expect(excluded.lines).toEqual([]);
  const restored = await scene.accept('restore-material', { materialId: invoice });
  expect(restored.materials.find(m => m.materialId === invoice)?.status).not.toBe('excluded');
  expect(restored.lines.map(line => line.grossAmount)).toEqual(original.lines.map(line => line.grossAmount));
  expect(restored.inventory.versionId).toBe(original.inventory.versionId);
  expect((await scene.accept('exclude-material', { materialId: invoice })).lines).toEqual([]);
  expect((await scene.accept('restore-material', { materialId: invoice })).lines).toEqual(restored.lines);
});

it('requires reopening a confirmed task before either inclusion change', async () => {
  const scene = await scenario(server).at('actions');
  const materialId = scene.reached.lines[0]!.voucherMaterialId;
  expect(await scene.refused('exclude-material', { materialId })).toMatchObject({ code: 'inclusion_locked' });
  expect(await scene.refused('restore-material', { materialId })).toMatchObject({ code: 'inclusion_locked' });
  await scene.accept('generate-print-sheet');
  expect((await scene.accept('reopen-upload')).printSheet.status).toBe('stale');
  await scene.accept('exclude-material', { materialId });
  const restored = await scene.accept('restore-material', { materialId });
  expect(restored.confirmation.status).not.toBe('confirmed');
});

it('restores every line of a multi-line invoice', async () => {
  const scene = await scenario(server).at('review', { materials: ['m03', 'm04'] });
  const original = scene.reached;
  expect(original.lines.length).toBeGreaterThan(1);
  const materialId = original.lines[0]!.voucherMaterialId;
  expect((await scene.accept('exclude-material', { materialId })).lines).toEqual([]);
  const restored = await scene.accept('restore-material', { materialId });
  expect(restored.lines).toEqual(original.lines);
});

it('refuses exclusion and restoration after the first ERP attempt', async () => {
  const scene = await scenario(server).at('done');
  const materialId = scene.reached.materials[0]!.materialId;
  expect((await scene.refused('exclude-material', { materialId })).status).toBe(400);
  expect((await scene.refused('restore-material', { materialId })).status).toBe(400);
});

it('reopens the missing-material check answered by exclusion', async () => {
  const scene = await scenario(server).at('pending', { materials: ['m11'] });
  const item = scene.reached.pendingItems.find(item => item.status === 'open')!;
  await scene.accept('answer-pending', { itemId: item.itemId, answer: { choice: 'exclude' } });
  const restored = await scene.accept('restore-material', { materialId: item.materialId });
  expect(restored.pendingItems).toContainEqual(expect.objectContaining({ itemId: item.itemId, status: 'open' }));
});
