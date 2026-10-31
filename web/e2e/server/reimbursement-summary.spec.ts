import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANNEL_PATH, ChannelMessageSchema, EXECUTOR_VERSION, PAIRING_PATH, PairingTokenSchema, PairingViewSchema, TaskSnapshotSchema } from '@baox/contract';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { answerStayGaps, expect, signIn, test } from './fixture';
const directory = mkdtempSync(join(tmpdir(), 'baox-summary-e2e-'));
const key = join(directory, 'key');
writeFileSync(key, randomBytes(32).toString('hex'));
test.use({ serverEnv: { BAOX_ERP_CREDENTIAL_KEY_FILE: key } });
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));

test('生成、预览、下载独立汇总表，原有打印稿仍单独下载', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  await signIn(page);
  const issued = PairingViewSchema.parse(await (await page.request.post('/api/pairing/code', { data: {} })).json());
  const paired = PairingTokenSchema.parse(await (await page.request.post(PAIRING_PATH, { data: { code: issued.code, browser: 'summary executor', version: EXECUTOR_VERSION } })).json());
  const socket = new WebSocket(new URL(CHANNEL_PATH, baseURL).toString().replace(/^http/, 'ws'));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('error', reject);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'hello', token: paired.token, version: EXECUTOR_VERSION })));
    socket.addEventListener('message', event => {
      const message = ChannelMessageSchema.parse(JSON.parse(String(event.data)));
      if (message.type === 'ready') resolve();
      if (message.type === 'request') socket.send(JSON.stringify({ type: 'response', id: message.id, ok: true, payload: { ok: true, employeeProfile: { status: 'ready', erpAccount: 'tester', tenant: '测试账套', name: '测试员工', department: '末条任职部门' } } }));
    });
  });
  try {
    expect((await page.request.post('/api/erp-credentials', { data: { account: 'tester', password: 'test-password' } })).ok()).toBe(true);
    let snapshot = TaskSnapshotSchema.parse(await (await page.request.post('/api/tasks', { data: { homeCity: '杭州' } })).json());
    const taskId = snapshot.task.taskId;
    for (const prefix of ['m01','m02']) {
      const sample = SAMPLE_MATERIALS.find(material => material.file.startsWith(prefix))!;
      expect((await page.request.post(`/api/tasks/${taskId}/batches`, { multipart: { files: { name: sample.fileName, mimeType: 'application/pdf', buffer: readFileSync(join(GENERATED_DIR, sample.file)) } } })).ok()).toBe(true);
    }
    const current = async () => TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
    const act = async (name: string, body = {}) => {
      snapshot = await current();
      const response = await page.request.post(`/api/tasks/${taskId}/actions/${name}`, { data: { ...body, stepToken: snapshot.step.stepToken } });
      expect(response.ok()).toBe(true);
      return TaskSnapshotSchema.parse(await response.json());
    };
    await act('start-inventory');
    await answerStayGaps(page, taskId);
    await page.request.post('/api/project-book/intake', { data: { number: 'P-2307', name: '测试项目' } });
    snapshot = await current();
    snapshot = await act('submit-project-assignment', { purpose: '出差', projects: Object.fromEntries(snapshot.lines.map(line => [line.lineId, 'P-2307'])) });
    const confirmed = await act('confirm-review', { digest: snapshot.confirmation.digest });
    await page.goto(`/#/task/${taskId}/review`);
    await page.getByRole('button', { name: '生成报销汇总表', exact: true }).click();
    const preview = page.getByRole('img', { name: /报销汇总表预览/ });
    await expect(preview).toBeVisible();
    await page.getByLabel('报销日期', { exact: true }).fill('2026-09-18');
    await page.getByLabel('出差单号（选填）', { exact: true }).fill('CC-463');
    await page.getByLabel('报销单号（选填）', { exact: true }).fill('BX-463');
    await page.getByLabel('打印姓名', { exact: true }).fill('本次打印姓名');
    await expect(page.getByRole('link', { name: '下载报销汇总表 Excel' })).toHaveCount(0);
    await page.getByRole('button', { name: '保存打印信息', exact: true }).click();
    await expect(page.getByRole('img', { name: /报销日期 2026-09-18，报销单号 BX-463，出差单号 CC-463/ })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('报销日期', { exact: true })).toHaveValue('2026-09-18');
    await expect(page.getByLabel('出差单号（选填）', { exact: true })).toHaveValue('CC-463');
    await expect(page.getByLabel('报销单号（选填）', { exact: true })).toHaveValue('BX-463');
    await expect(page.getByLabel('打印姓名', { exact: true })).toHaveValue('本次打印姓名');
    await page.getByLabel('打印姓名', { exact: true }).fill('本次打印姓名 ');
    await page.getByRole('button', { name: '保存打印信息', exact: true }).click();
    await expect(page.getByRole('link', { name: '下载报销汇总表 Excel' })).toBeVisible();
    await expect(page.getByLabel('打印姓名', { exact: true })).toHaveValue('本次打印姓名');
    expect((await current()).confirmation).toEqual(confirmed.confirmation);
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await preview.screenshot({ path: testInfo.outputPath('summary-preview.png') });
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: '下载报销汇总表 Excel' }).click()]);
    expect(download.suggestedFilename()).toBe('报销汇总表.xlsx');
    await download.saveAs(testInfo.outputPath('summary.xlsx'));
    await page.getByRole('link', { name: '去打印', exact: true }).click();
    await expect(page.getByRole('link', { name: /下载.*PDF|下载打印稿/ })).toBeVisible();
    expect((await current()).confirmation.status).toBe('confirmed');
  } finally { socket.close(); }
});
