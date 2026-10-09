import { afterEach, beforeEach, expect, it } from 'vitest';
import { byFileName, sample } from './test/api';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

let server: ScenarioServer;
beforeEach(async () => { server = await scenarioServer(); });
afterEach(() => server.close());

it('pairs a dining invoice with its photographed slip using the amount actually paid', async () => {
  const scene = await scenario(server).at('project', { materials: ['m11', 'm16'] });
  const snapshot = scene.reached;
  const invoice = byFileName(snapshot, sample('m11').name);
  const photo = byFileName(snapshot, sample('m16').name);
  expect(photo).toMatchObject({ kind: 'dining_receipt', role: 'reference', status: 'ok', linkedMaterialIds: [invoice.materialId] });
  expect(invoice).toMatchObject({ status: 'ok', linkedMaterialIds: [photo.materialId] });
  expect(snapshot.lines).toEqual([expect.objectContaining({ category: { code: 'hospitality', label: '招待费' }, grossAmount: '240.00', referenceMaterialIds: [photo.materialId] })]);
  expect(snapshot.pendingItems.filter((item) => item.status === 'open')).toEqual([]);
});
