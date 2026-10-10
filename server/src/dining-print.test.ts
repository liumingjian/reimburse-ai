import { PDFDocument } from '@cantoo/pdf-lib';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { api, sample } from './test/api';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';
import type { TestClient } from './test/harness';

let server: ScenarioServer;
let alice: TestClient;
beforeEach(async () => {
  server = await scenarioServer();
  alice = await server.signIn('alice');
});
afterEach(() => server.close());
const client = api(() => alice);

it('prints a paired dining invoice and receipt on the two halves of one A4 page', async () => {
  const task = (await scenario(server, alice).at('actions', { materials: ['m11', 'm13'] })).reached;
  expect(task.lines).toHaveLength(1);
  expect(task.lines[0]?.category).toMatchObject({ code: 'hospitality', label: '招待费' });
  const generated = await client.accepted(await alice.post(`/api/tasks/${task.task.taskId}/actions/generate-print-sheet`, {}));
  expect(generated.printSheet.pages).toHaveLength(1);
  expect(generated.printSheet.pages[0]).toMatchObject({ kind: 'voucher', categoryLabel: '招待费', grossAmount: '240.00', top: { fileName: sample('m11').name }, bottom: { fileName: sample('m13').name }, screenshotIds: [] });
  expect(generated.printSheet.notices).toEqual([]);
  expect(generated.confirmation).toEqual(task.confirmation);
  const response = await alice.request(generated.printSheet.url ?? '');
  expect(response.status).toBe(200);
  const pdf = await PDFDocument.load(new Uint8Array(await response.arrayBuffer()));
  expect(pdf.getPageCount()).toBe(1);
  expect(pdf.getPage(0).getWidth()).toBeCloseTo(595.28, 1);
  expect(pdf.getPage(0).getHeight()).toBeCloseTo(841.89, 1);
}, 120_000);
