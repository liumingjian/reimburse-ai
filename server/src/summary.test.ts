import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tempDataDir, testClient } from './test/harness';
import { sample } from './test/api';
import { writeFileSync } from 'node:fs';
import { presetParser } from './test/parse-presets';
import ExcelJS from 'exceljs';
import { PairingViewSchema, PairingTokenSchema, PAIRING_PATH, EXECUTOR_VERSION } from '@baox/contract';
import { fakeLocalExecutor } from './erp/testing/fake-local-executor';
import type { TestClient } from './test/harness';
async function pair(client: TestClient) {
  const issued = PairingViewSchema.parse(await (await client.post('/api/pairing/code', {})).json());
  const redeemed = await server.app.request(PAIRING_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: issued.code, browser: 'test', version: EXECUTOR_VERSION }) });
  return PairingTokenSchema.parse(await redeemed.json()).token;
}
import { afterEach, expect, it } from 'vitest';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';
let server: ScenarioServer;
afterEach(() => server?.close());
it('requires confirmed details before creating the independent summary', async () => {
  server = await scenarioServer();
  const scene = await scenario(server).at('review');
  expect(await scene.refused('generate-reimbursement-summary')).toEqual({ status: 400, code: 'not_confirmed' });
});

it('generates a printable independent workbook from the standing confirmation and revokes historical downloads', async () => {
  server = await scenarioServer({ erpExecutor: 'paired' });
  const scene = await scenario(server).at('actions');
  const token = await pair(scene.client);
  const local = fakeLocalExecutor(server.app.executorHub, token, { trySignIn: async () => ({ ok: true, employeeProfile: { status: 'ready', erpAccount: 'synthetic', tenant: 'test', name: '测试员工', department: '测试部门' } }) });
  await local.connect();
  await server.authoriseErpCredentials(scene.client.account.accountId, { account: 'synthetic', password: 'test-password' });
  const generated = await scene.accept('generate-reimbursement-summary');
  expect(generated.confirmation).toEqual(scene.reached.confirmation);
  expect(generated.printSheet).toEqual(scene.reached.printSheet);
  const summary = generated.reimbursementSummary;
  expect(summary?.status).toBe('generated');
  if (summary?.status !== 'generated') throw new Error('summary missing');
  expect(summary.data).toMatchObject({ name: '测试员工', department: '测试部门', total: '3640.00', totalVouchers: 1 });
  const preview = await scene.client.request(summary.previewUrl);
  expect(preview.status).toBe(200);
  expect(await preview.text()).toContain('测试员工');
  const response = await scene.client.request(summary.url);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await response.arrayBuffer());
  expect(workbook.worksheets).toHaveLength(1);
  const sheet = workbook.worksheets[0]!;
  expect(sheet.getCell('C4').value).toBe('测试员工');
  expect(sheet.getCell('F4').value).toBe('测试部门');
  expect(sheet.getCell('F6').value).toBe(3640);
  expect(sheet.getCell('D6').value).toBe(1);
  expect(sheet.getCell('E6').value).toBe(13);
  expect(sheet.pageSetup).toMatchObject({ paperSize: 9, orientation: 'portrait', horizontalCentered: true });
  expect(sheet.getCell('B18').formula).toContain('角');
  expect(sheet.getCell('D17').formula).toContain('SUM');
  expect(sheet.getCell('F10').value).toBeNull();
  expect((await scene.accept('generate-reimbursement-summary')).reimbursementSummary).toEqual(summary);
  expect(local.asked().filter(request => request.method === 'erp.trySignIn')).toHaveLength(1);
  const bob = await server.signIn('bob');
  expect((await bob.request(summary.url)).status).toBe(404);
  await scene.accept('reopen-upload');
  expect((await scene.client.request(summary.url)).status).toBe(404);
  expect((await scene.client.request(summary.previewUrl)).status).toBe(404);
  await local.disconnect();
});

it('uses five confirmed category amounts across projects and counts repeated voucher lines once', async () => {
  const preset = presetParser();
  server = await scenarioServer({ erpExecutor: 'paired', parser: {
    async parse(input) {
      const secondStay = input.fileName.startsWith('second-');
      const result = await preset.parse(secondStay ? { ...input, bytes: sample(input.fileName.includes('invoice') ? 'm01' : 'm02').bytes } : input);
      if (result.outcome !== 'recognised') return result;
      const amount = secondStay ? '23.45' : input.fileName.includes('全季') ? '100.00' : input.fileName.includes('高德') ? '10.20' : input.fileName.endsWith('.jpg') ? '20.30' : input.fileName.includes('铁路') ? '40.40' : '50.50';
      for (const candidate of result.candidates) {
        if (secondStay && candidate.key === 'invoiceNumber') candidate.value = '26312000000098127735';
        if (candidate.key === 'checkIn') candidate.value = secondStay ? '2026-09-10' : '2026-08-30';
        if (candidate.key === 'checkOut') candidate.value = secondStay ? '2026-09-13' : '2026-09-01';
        if (['totalAmount', 'folioTotal', 'paidAmount', 'itineraryTotal', 'originalTotal', 'netAmount'].includes(candidate.key)) candidate.value = amount;
        if (candidate.key === 'taxAmount') candidate.value = '0.00';
        if (/segments\[\d\].amount/.test(candidate.key)) candidate.value = '3.40';
        if (input.fileName.endsWith('.jpg') && candidate.key === 'city') candidate.value = '杭州';
      }
      return result;
    }, close: async () => {},
  } });
  const scene = await scenario(server).at('actions', { materials: ['m01','m02','m03','m04','m07','m09','m11','m13', ...(['m01', 'm02'].map((prefix, index) => ({ name: index ? 'second-folio.pdf' : 'second-invoice.pdf', bytes: Buffer.concat([sample(prefix).bytes, Buffer.from('\n% second stay')]) })))], homeCity: '上海', projects: line => line.category.label === '住宿' ? 'P-2307' : 'P-3312' });
  const local = fakeLocalExecutor(server.app.executorHub, await pair(scene.client), { trySignIn: async () => ({ ok: true, employeeProfile: { status: 'ready', erpAccount: 'synthetic', tenant: 'test', name: '测试员工', department: '测试部门' } }) });
  await local.connect();
  await scene.client.post('/api/erp-credentials', { account: 'synthetic', password: 'test-password' });
  const generated = await scene.accept('generate-reimbursement-summary');
  const summary = generated.reimbursementSummary;
  if (summary.status !== 'generated') throw new Error('missing summary');
  expect(summary.data.total).toBe('244.85');
  expect(summary.data.rows[0]?.days).toBe(5);
  expect(generated.lines.filter(line => line.category.label === '住宿').map(line => [line.date, line.endDate])).toEqual([['2026-08-30', '2026-09-01'], ['2026-09-10', '2026-09-13']]);
  expect(summary.data.rows.map(row => [row.amount, row.voucherCount])).toEqual([['123.45', 2], ['10.20', 1], ['20.30', 1], ['40.40', 1], ['50.50', 1]]);
  const response = await scene.client.request(summary.url);
  const bytes = Buffer.from(await response.arrayBuffer());
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const sheet = workbook.worksheets[0]!;
  expect(['F6','F7','F8','K6','F9'].map(cell => sheet.getCell(cell).value)).toEqual([123.45,10.2,20.3,40.4,50.5]);
  expect(['D6','D7','D8','I6','D9'].map(cell => sheet.getCell(cell).value)).toEqual([2,1,1,1,1]);
  expect(sheet.getCell('E6').value).toBe(5);
  expect(summary.data.totalVouchers).toBe(6);
  if (process.env['BAOX_SUMMARY_EVIDENCE']) writeFileSync(process.env['BAOX_SUMMARY_EVIDENCE'], bytes);
  local.disconnect();
});

it.each(['cross-category', 'same-day'] as const)('reports unresolved %s summary inputs instead of inventing counts', async kind => {
  const preset = presetParser();
  server = await scenarioServer({ parser: {
    async parse(input) {
      const result = await preset.parse(input);
      if (result.outcome === 'recognised') for (const candidate of result.candidates) {
        if (kind === 'cross-category' && candidate.key === 'segments[1].city') candidate.value = '杭州';
        if (kind === 'same-day' && candidate.key === 'checkOut') candidate.value = '2026-08-09';
      }
      return result;
    }, close: async () => {},
  } });
  const scene = await scenario(server).at('actions', { materials: kind === 'cross-category' ? ['m03','m04'] : ['m01','m02'], homeCity: '上海' });
  expect(scene.reached.reimbursementSummary.status).toBe('unavailable');
  expect(await scene.refused('generate-reimbursement-summary')).toEqual({ status: 400, code: 'summary_inputs_unresolved' });
});

it('refuses failed identity retrieval, retries, and persists the current summary over a restart without an executor', async () => {
  const dataDir = tempDataDir();
  const options = { dataDir, database: join(dataDir, 'summary.sqlite'), erpExecutor: 'paired' as const, erpCredentialKey: randomBytes(32) };
  server = await scenarioServer(options);
  const scene = await scenario(server).at('actions');
  await server.authoriseErpCredentials(scene.client.account.accountId, { account: 'synthetic', password: 'test-password' });
  let fail = true;
  const local = fakeLocalExecutor(server.app.executorHub, await pair(scene.client), { trySignIn: async () => ({ ok: true, employeeProfile: fail ? { status: 'failed', message: '员工信息读取失败，请重试。' } : { status: 'ready', erpAccount: 'synthetic', tenant: 'test', name: '测试员工', department: '测试部门' } }) });
  await local.connect();
  expect(await scene.refused('generate-reimbursement-summary')).toEqual({ status: 400, code: 'employee_profile_unavailable' });
  expect((await scene.snapshot()).reimbursementSummary.status).toBe('ready');
  fail = false;
  const generated = (await scene.accept('generate-reimbursement-summary')).reimbursementSummary;
  if (generated.status !== 'generated') throw new Error('missing summary');
  const original = await (await scene.client.request(generated.url)).arrayBuffer();
  local.disconnect();
  await server.app.close();
  await server.db.destroy();
  server = await scenarioServer(options);
  const client = testClient(server.app, scene.client.account, scene.client.cookie);
  const restored = await scenario(server, client).of(scene.task.taskId);
  expect((await restored.snapshot()).reimbursementSummary).toEqual(generated);
  expect((await restored.accept('generate-reimbursement-summary')).reimbursementSummary).toEqual(generated);
  expect(await (await client.request(generated.url)).arrayBuffer()).toEqual(original);
});
