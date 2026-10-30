import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANNEL_PATH, ChannelMessageSchema, EXECUTOR_VERSION, PAIRING_PATH, PairingTokenSchema, PairingViewSchema } from '@baox/contract';
import { expect, signIn, test } from './fixture';

const directory = mkdtempSync(join(tmpdir(), 'baox-profile-e2e-'));
const key = join(directory, 'key');
writeFileSync(key, randomBytes(32).toString('hex'));
test.use({ serverEnv: { BAOX_ERP_CREDENTIAL_KEY_FILE: key } });
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));

test('保存账号后展示员工信息，刷新页面复用，读取失败可重试', async ({ page, baseURL }, testInfo) => {
  await signIn(page);
  const issued = PairingViewSchema.parse(await (await page.request.post('/api/pairing/code', { data: {} })).json());
  const paired = PairingTokenSchema.parse(await (await page.request.post(PAIRING_PATH, { data: { code: issued.code, browser: 'scripted profile executor', version: EXECUTOR_VERSION } })).json());
  const socket = new WebSocket(new URL(CHANNEL_PATH, baseURL).toString().replace(/^http/, 'ws'));
  let fail = false;
  let requests = 0;
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('error', reject);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'hello', token: paired.token, version: EXECUTOR_VERSION })));
    socket.addEventListener('message', (event) => {
      const message = ChannelMessageSchema.parse(JSON.parse(String(event.data)));
      if (message.type === 'ready') resolve();
      if (message.type === 'request') {
        requests += 1;
        socket.send(JSON.stringify({ type: 'response', id: message.id, ok: true, payload: { ok: true, employeeProfile: fail ? { status: 'failed', message: '员工信息读取失败，请重新试登录。' } : { status: 'ready', erpAccount: 'tester', tenant: '测试账套', name: '测试员工', department: '末条任职部门' } } }));
      }
    });
  });
  try {
    await page.goto('/#/settings');
    await page.getByLabel('报销系统账号', { exact: true }).fill('tester');
    await page.getByLabel('报销系统密码', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: '保存并试登录', exact: true }).click();
    await expect(page.getByText('报销汇总表员工信息：测试员工；部门：末条任职部门')).toBeVisible();
    await page.reload();
    await expect(page.getByText('报销汇总表员工信息：测试员工；部门：末条任职部门')).toBeVisible();
    expect(requests).toBe(1);
    fail = true;
    await page.getByRole('button', { name: '再试登录一次', exact: true }).click();
    await expect(page.getByText('员工信息读取失败，请重新试登录。')).toBeVisible();
    await expect(page.getByText('试登录成功，可以去报销')).toBeVisible();
    await expect(page.getByText(/报销汇总表员工信息：测试员工/)).toHaveCount(0);
    fail = false;
    await page.getByRole('button', { name: '再试登录一次', exact: true }).click();
    await expect(page.getByText('报销汇总表员工信息：测试员工；部门：末条任职部门')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('employee-profile.png'), fullPage: true });
  } finally { socket.close(); }
});
