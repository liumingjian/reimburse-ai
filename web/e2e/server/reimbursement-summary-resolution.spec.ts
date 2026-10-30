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
test.use({ serverEnv: { BAOX_ERP_CREDENTIAL_KEY_FILE: key, BAOX_PARSE_FIXTURE: 'summary-inputs' } });
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));

test('分别确认跨类别凭证张数和同日住宿天数后预览下载', async ({ page, baseURL }, testInfo) => {
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
    let snapshot = TaskSnapshotSchema.parse(await (await page.request.post('/api/tasks', { data: { homeCity: '上海' } })).json());
    const taskId = snapshot.task.taskId;
    for (const prefix of ['m01','m02','m03','m04']) {
      const sample = SAMPLE_MATERIALS.find(material => material.file.startsWith(prefix))!;
      expect((await page.request.post(`/api/tasks/${taskId}/batches`, { multipart: { files: { name: sample.file, mimeType: 'application/pdf', buffer: readFileSync(join(GENERATED_DIR, sample.file)) } } })).ok()).toBe(true);
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
    await act('confirm-review', { digest: snapshot.confirmation.digest });
    await page.goto(`/#/task/${taskId}/review`);
    const section = page.getByRole('region', { name: '报销汇总表', exact: true });
    await expect(section.getByLabel(/张数归属/)).toBeVisible();
    await expect(section.getByLabel(/同日住宿天数/)).toBeVisible();
    await section.getByLabel(/张数归属/).selectOption('外地市内交通');
    await section.getByRole('button', { name: '确认张数归属', exact: true }).click();
    await expect(section.getByLabel(/张数归属/)).toHaveCount(0);
    await expect(section.getByLabel(/同日住宿天数/)).toBeVisible();
    await page.reload();
    await expect(section.getByLabel(/张数归属/)).toHaveCount(0);
    await section.getByLabel(/同日住宿天数/).fill('1');
    await section.getByRole('button', { name: '确认住宿天数', exact: true }).click();
    await page.getByRole('button', { name: '生成报销汇总表', exact: true }).click();
    const preview = page.getByRole('img', { name: /报销汇总表预览/ });
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
