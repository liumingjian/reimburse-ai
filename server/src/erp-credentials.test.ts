import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ERP_CREDENTIAL_ERRORS, ERP_CREDENTIALS_MISSING_CODE, PAIRING_PATH, EXECUTOR_VERSION, ErpCredentialsViewSchema, PairingViewSchema, PairingTokenSchema } from '@baox/contract';
import { abortedResult } from '@baox/erp-executor/protocol';
import { COMPATIBILITY, ERP_ORIGIN } from '@baox/erp-executor/testing/scenario';
import { EXECUTOR_METHODS, SIGN_IN_REFUSED_CODE, type TrySignInAnswer, type TrySignInRequest } from '@baox/erp-executor/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ErpCredentials } from '@baox/erp-executor/sign-in';
import { drafted, uncertainDraft, uncertainSave } from './erp/testing/fake-executor';
import type { FillExecutor } from './erp/fill-jobs';
import { draftMarkOf } from './erp/fill-plan';
import { fakeLocalExecutor, type FakeLocalExecutor, type FillRunner } from './erp/testing/fake-local-executor';
import type { TestClient } from './test/harness';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

// ERP 凭据 hosted for the baox 本地执行器 (ADR-0033, erp-headless-v1.md line 2 item 1): saved write-only, sealed with
// the server's key, tried on the employee's PC through the paired 本地执行器, deleted the moment ERP refuses them, and
// sent down with each job.

const PASSWORD = 'erp-Pa55-秘密';

let server: ScenarioServer;
let alice: TestClient;

async function start(key: Buffer | null = randomBytes(32)) {
  server = await scenarioServer({ erpExecutor: 'paired', erpConfig: { origin: ERP_ORIGIN, compatibility: COMPATIBILITY }, erpCredentialKey: key });
  alice = await server.signIn('alice');
}
beforeEach(() => start());
afterEach(() => server.close());

async function pair(owner: TestClient): Promise<string> {
  const issued = PairingViewSchema.parse(await (await owner.post('/api/pairing/code', {})).json());
  const redeemed = await server.app.request(PAIRING_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: issued.code, browser: 'baox 本地执行器（darwin）', version: EXECUTOR_VERSION }),
  });
  return PairingTokenSchema.parse(await redeemed.json()).token;
}

const trials: TrySignInRequest[] = [];
beforeEach(() => { trials.length = 0; });
async function executor(answer: TrySignInAnswer = { ok: true, employeeProfile: { status: 'failed', message: '员工信息读取失败，请重试。' } }, fill?: FillRunner): Promise<FakeLocalExecutor> {
  const localExecutor = fakeLocalExecutor(server.app.executorHub, await pair(alice), {
    trySignIn: async (request) => { trials.push(request); return answer; },
    ...(fill ? { fill } : {}),
  });
  await localExecutor.connect();
  return localExecutor;
}

const view = async (response: Response) => ErpCredentialsViewSchema.parse(await response.json());
const save = (password = PASSWORD) => alice.post('/api/erp-credentials', { account: 'zhangsan', password });

describe('ERP 凭据 on the settings page', () => {
  it('saves them write-only, tries them on the PC, and never answers or stores the password in the clear', async () => {
    await executor();
    const saved = await save();

    expect(saved.status).toBe(200);
    expect(await view(saved)).toMatchObject({ available: true, status: 'authorised', erpAccount: 'zhangsan', message: null, checkedAt: expect.any(String) });
    expect(trials).toEqual([{ erpOrigin: ERP_ORIGIN, browserMode: 'headless', credentials: { account: 'zhangsan', password: PASSWORD } }]);
    const read = await (await alice.request('/api/erp-credentials')).text();
    expect(read).not.toContain(PASSWORD);
    const row = await server.db.selectFrom('erp_credential').selectAll().executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
  });

  it('uses the saved mode for each trial and preserves it when credentials are cleared', async () => {
    await executor();
    await save();
    const before = await server.db.selectFrom('erp_credential').selectAll().executeTakeFirstOrThrow();
    await alice.post('/api/erp-browser-settings', { browserMode: 'headed' });
    expect(await server.db.selectFrom('erp_credential').selectAll().executeTakeFirstOrThrow()).toEqual(before);
    await alice.post('/api/erp-credentials/test', {});
    expect(trials.map((trial) => trial.browserMode)).toEqual(['headless', 'headed']);
    await alice.post('/api/erp-credentials/clear', {});
    expect(await (await alice.request('/api/erp-browser-settings')).json()).toEqual({ browserMode: 'headed' });
    await save();
    expect(trials.at(-1)?.browserMode).toBe('headed');
  });

  it('deletes the password at once when ERP refuses it, and has nothing left to try', async () => {
    await executor({ ok: false, code: SIGN_IN_REFUSED_CODE, message: 'ERP 拒绝了这组账号密码：密码错误。' });
    await alice.post('/api/erp-browser-settings', { browserMode: 'headed' });
    expect(await view(await save())).toMatchObject({ status: 'refused', erpAccount: 'zhangsan', message: 'ERP 拒绝了这组账号密码：密码错误。' });
    expect((await server.db.selectFrom('erp_credential').select('password_sealed').executeTakeFirstOrThrow()).password_sealed).toBeNull();

    const again = await alice.post('/api/erp-credentials/test', {});
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: { code: 'erp_credentials_none' } });
    expect(trials).toHaveLength(1);
    expect(await (await alice.request('/api/erp-browser-settings')).json()).toEqual({ browserMode: 'headed' });
  });

  it('keeps them untested, with the reason, when the 试登录 fails for any other reason', async () => {
    await executor({ ok: false, code: 'erp_sign_in_second_factor', message: '要短信验证码。' });
    expect(await view(await save())).toMatchObject({ status: 'untested', message: '要短信验证码。' });
  });

  it.each<[string, () => Promise<void>, string]>([
    ['nothing is paired', async () => undefined, ERP_CREDENTIAL_ERRORS.notPaired],
    ['no 本地执行器 is connected', async () => { await pair(alice); }, ERP_CREDENTIAL_ERRORS.noExecutor],
  ])('saves them untested, and asks nothing, when %s', async (_case, setUp, message) => {
    await setUp();
    expect(await view(await save())).toMatchObject({ status: 'untested', erpAccount: 'zhangsan', message });
    expect(trials).toEqual([]);
  });

  it('clears them', async () => {
    await executor();
    await save();
    expect(await view(await alice.post('/api/erp-credentials/clear', {}))).toMatchObject({ status: 'none', erpAccount: null });
    expect(await server.db.selectFrom('erp_credential').selectAll().execute()).toEqual([]);
  });

  it('shows another account nothing of them', async () => {
    await executor();
    await save();
    const bob = await server.signIn('bob');
    expect(await view(await bob.request('/api/erp-credentials'))).toMatchObject({ status: 'none', erpAccount: null });
  });

  it('cannot save without the server\'s key', async () => {
    await server.close();
    await start(null);
    expect(await view(await alice.request('/api/erp-credentials'))).toMatchObject({ available: false, status: 'none' });
    const refused = await save();
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: { code: 'erp_credentials_unavailable' } });
  });
});

describe('去报销 through a baox 本地执行器', () => {
  const sceneOnFakeErp = () => scenario(server, alice).at('actions');

  it('sends the authorised 凭据 down with the job, next to the plan and not in it', async () => {
    const localExecutor = await executor({ ok: true, employeeProfile: { status: 'failed', message: '员工信息读取失败，请重试。' } }, (plan, channel) => uncertainSave(plan, channel));
    await save();
    const scene = await sceneOnFakeErp();

    await scene.run('start-erp-write');

    const fill = localExecutor.asked().find((asked) => asked.method === EXECUTOR_METHODS.fill)!;
    expect(fill.payload).toMatchObject({ credentials: { account: 'zhangsan', password: PASSWORD } });
    const stored = await server.db.selectFrom('erp_job').select('plan').where('task_id', '=', scene.task.taskId).executeTakeFirstOrThrow();
    expect(stored.plan).not.toContain(PASSWORD);
  });

  // ADR-0029: the 本地执行器 runs unattended, so it 暂存s the bill under the job's ownership marker.
  it('asks the 本地执行器 to 暂存 under the job\'s marker, and ends at ERP 草稿已交接', async () => {
    const localExecutor = await executor({ ok: true, employeeProfile: { status: 'failed', message: '员工信息读取失败，请重试。' } }, drafted);
    await save();
    const scene = await sceneOnFakeErp();

    const done = await scene.run('start-erp-write');

    const fill = localExecutor.asked().find((asked) => asked.method === EXECUTOR_METHODS.fill)!;
    const jobId = (fill.payload as { plan: { jobId: string } }).plan.jobId;
    expect(fill.payload).toMatchObject({ plan: { draft: { mark: draftMarkOf(jobId) } } });
    expect(draftMarkOf(jobId)).toMatch(/^baox-[a-z0-9]{10}$/);
    expect(done).toMatchObject({ stage: 'done', erp: { status: 'done', outcome: 'drafted', draftNo: null } });
  });

  it('offers 对账 by the marker and 转人工, never 重新去报销, when 暂存 was pressed and its result is unknown', async () => {
    await executor({ ok: true, employeeProfile: { status: 'failed', message: '员工信息读取失败，请重试。' } }, uncertainDraft);
    await save();
    const scene = await sceneOnFakeErp();

    const stopped = await scene.run('start-erp-write');

    expect(stopped).toMatchObject({ stage: 'reconcile', reconcile: { allowedActions: ['wait', 'hand_off'] } });
  });

  it('refuses before any job exists without authorised 凭据, and points at the settings page', async () => {
    await executor({ ok: false, code: 'erp_sign_in_timeout', message: '登录超时。' });
    await save();
    const scene = await sceneOnFakeErp();

    const refused = await scene.act('start-erp-write');

    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: ERP_CREDENTIALS_MISSING_CODE, message: ERP_CREDENTIAL_ERRORS.missing } });
    expect(ERP_CREDENTIAL_ERRORS.missing).toContain('设置页');
    expect(await server.db.selectFrom('erp_job').select('job_id').where('task_id', '=', scene.task.taskId).execute()).toEqual([]);
  });

  it('deletes the password when ERP refuses it inside a job', async () => {
    await executor({ ok: true, employeeProfile: { status: 'failed', message: '员工信息读取失败，请重试。' } }, async () => abortedResult(SIGN_IN_REFUSED_CODE, 'ERP 拒绝了这组账号密码：密码已过期。'));
    await save();
    const scene = await sceneOnFakeErp();

    await scene.run('start-erp-write');

    expect(await view(await alice.request('/api/erp-credentials'))).toMatchObject({ status: 'refused', message: 'ERP 拒绝了这组账号密码：密码已过期。' });
    expect((await server.db.selectFrom('erp_credential').select('password_sealed').executeTakeFirstOrThrow()).password_sealed).toBeNull();
  });
});

// ADR-0037: one step list, the 本地执行器's, for every job.
describe('the 去报销 step list', () => {
  const titles = (snapshot: { erp: { steps: Array<{ title: string }> } }) => snapshot.erp.steps.map((step) => step.title);
  const LOCAL = ['启动后台浏览器', '登录', '报销信息核对', '打开空白报销单', '导入发票', '收票回读', '填写明细', '暂存到报销系统'];

  it('words a job with the 本地执行器 list, ending in 暂存到报销系统', async () => {
    await executor({ ok: true, employeeProfile: { status: 'failed', message: '员工信息读取失败，请重试。' } }, drafted);
    await save();
    const scene = await scenario(server, alice).at('actions');

    const done = await scene.run('start-erp-write');

    expect(titles(done)).toEqual(LOCAL);
    expect(done.erp.steps.at(-1)).toMatchObject({ description: '你检查后自己提交', status: 'done' });
    expect(done.erp.progress).toEqual({ label: '核对暂存单', percent: 100 });
  });
});

// ADR-0037: development and e2e run the production path. The server's own executor (the CDP one in development) signs
// in with the 凭据 saved on the 设置页 as a 本地执行器 does, though with no 本地执行器 paired nothing could try them first.
describe('ERP 凭据 for the server\'s own executor (development, e2e)', () => {
  let own: ScenarioServer;
  let seen: Array<ErpCredentials | null>;
  let answer: 'drafted' | 'refused';
  const ownExecutor: FillExecutor = async (plan, channel, { credentials }) => {
    seen.push(credentials);
    if (answer === 'drafted') return drafted(plan, channel);
    const refusedLogin = abortedResult(SIGN_IN_REFUSED_CODE, 'ERP 拒绝了这组账号密码：密码错误。');
    await channel.emit(refusedLogin);
    return refusedLogin;
  };
  beforeEach(async () => {
    seen = [];
    answer = 'drafted';
    own = await scenarioServer({ erpExecutor: ownExecutor, erpConfig: { origin: ERP_ORIGIN, compatibility: COMPATIBILITY }, erpCredentialKey: randomBytes(32) });
  });
  afterEach(() => own.close());

  it('signs in with the 凭据 saved on the 设置页, untried, and 暂存s', async () => {
    const scene = await scenario(own).at('actions');
    expect(await view(await scene.client.post('/api/erp-credentials', { account: 'zhangsan', password: PASSWORD }))).toMatchObject({ status: 'untested' });

    expect(await scene.run('start-erp-write')).toMatchObject({ stage: 'done', erp: { outcome: 'drafted' } });
    expect(seen).toEqual([{ account: 'zhangsan', password: PASSWORD }]);
  });

  it('goes without 凭据 when none are saved, and never again with ones ERP refused', async () => {
    const scene = await scenario(own).at('actions');
    answer = 'refused';
    await scene.client.post('/api/erp-credentials', { account: 'zhangsan', password: PASSWORD });
    const stopped = await scene.run('start-erp-write');
    expect(stopped).toMatchObject({ stage: 'actions', erp: { status: 'idle' } });
    expect((await view(await scene.client.request('/api/erp-credentials'))).status).toBe('refused');

    answer = 'drafted';
    expect(await scene.run('start-erp-write')).toMatchObject({ stage: 'done' });
    expect(seen).toEqual([{ account: 'zhangsan', password: PASSWORD }, null]);
  });
});


describe('personal template information through the paired executor', () => {
  it('retrieves the owning employee on save and reuses it without another login', async () => {
    await executor({ ok: true, employeeProfile: { status: 'ready', erpAccount: 'zhangsan', tenant: 'tenant-a', name: '测试员工', department: '末条任职部门' } });
    expect(await view(await save())).toMatchObject({ status: 'authorised', employeeProfile: { status: 'ready', name: '测试员工', department: '末条任职部门', tenant: 'tenant-a' } });
    expect(await view(await alice.request('/api/erp-credentials'))).toMatchObject({ employeeProfile: { status: 'ready', name: '测试员工' } });
    expect(trials).toHaveLength(1);
    const bob = await server.signIn('bob');
    expect(await view(await bob.request('/api/erp-credentials'))).toMatchObject({ employeeProfile: { status: 'missing' } });
    const bobExecutor = fakeLocalExecutor(server.app.executorHub, await pair(bob), { trySignIn: async () => ({ ok: true, employeeProfile: { status: 'ready', erpAccount: 'zhangsan', tenant: 'tenant-a', name: '另一应用账号员工', department: '另一部门' } }) });
    await bobExecutor.connect();
    expect(await view(await bob.post('/api/erp-credentials', { account: 'zhangsan', password: PASSWORD }))).toMatchObject({ employeeProfile: { status: 'ready', name: '另一应用账号员工' } });
    expect(await view(await alice.request('/api/erp-credentials'))).toMatchObject({ employeeProfile: { status: 'ready', name: '测试员工', department: '末条任职部门' } });
  });
});

describe('employee identity refresh', () => {
  it('replaces tenant identity on verification and never falls back after a failed refresh', async () => {
    let answer: TrySignInAnswer = { ok: true, employeeProfile: { status: 'ready', erpAccount: 'zhangsan', tenant: 'first', name: '甲', department: '旧部门' } };
    const local = fakeLocalExecutor(server.app.executorHub, await pair(alice), { trySignIn: async () => answer });
    await local.connect();
    await save();
    answer = { ok: true, employeeProfile: { status: 'ready', erpAccount: 'zhangsan', tenant: 'second', name: '乙', department: '新部门' } };
    expect(await view(await alice.post('/api/erp-credentials/test', {}))).toMatchObject({ employeeProfile: { status: 'ready', tenant: 'second', name: '乙' } });
    answer = { ok: true, employeeProfile: { status: 'failed', message: '员工信息读取失败，请重试。' } };
    const failed = await view(await alice.post('/api/erp-credentials/test', {}));
    expect(failed).toMatchObject({ status: 'authorised', employeeProfile: { status: 'failed', message: expect.stringContaining('重试') } });
    expect(JSON.stringify(failed.employeeProfile)).not.toContain('乙');
    answer = { ok: true, employeeProfile: { status: 'ready', erpAccount: 'other', tenant: 'second', name: '丙', department: '另一部门' } };
    expect(await view(await alice.post('/api/erp-credentials', { account: 'other', password: PASSWORD }))).toMatchObject({ employeeProfile: { status: 'ready', erpAccount: 'other', name: '丙' } });
  });

  it('rejects blank employee fields and a mismatched observed ERP account', async () => {
    let answer: TrySignInAnswer = { ok: true, employeeProfile: { status: 'ready', erpAccount: 'other', tenant: 'first', name: '甲', department: '部门' } };
    const local = fakeLocalExecutor(server.app.executorHub, await pair(alice), { trySignIn: async () => answer });
    await local.connect();
    expect(await view(await save())).toMatchObject({ employeeProfile: { status: 'failed' } });
    answer = { ok: true, employeeProfile: { status: 'ready', erpAccount: 'zhangsan', tenant: 'first', name: '', department: '' } };
    expect(await view(await alice.post('/api/erp-credentials/test', {}))).toMatchObject({ status: 'authorised', employeeProfile: { status: 'failed' } });
  });
});


it('persists personal template information across a server restart without another ERP login', async () => {
  await server.close();
  const directory = mkdtempSync(join(tmpdir(), 'baox-profile-'));
  const database = join(directory, 'profile.sqlite');
  const key = randomBytes(32);
  server = await scenarioServer({ database, erpExecutor: 'paired', erpCredentialKey: key, erpConfig: { origin: ERP_ORIGIN, compatibility: COMPATIBILITY } });
  alice = await server.signIn('alice');
  const local = await executor({ ok: true, employeeProfile: { status: 'ready', erpAccount: 'zhangsan', tenant: 'tenant', name: '测试员工', department: '测试部门' } });
  await save();
  const cookie = alice.cookie;
  local.disconnect();
  await server.close();
  server = await scenarioServer({ database, erpExecutor: 'paired', erpCredentialKey: key, erpConfig: { origin: ERP_ORIGIN, compatibility: COMPATIBILITY } });
  try {
    const response = await server.app.request('/api/erp-credentials', { headers: { cookie } });
    expect(await view(response)).toMatchObject({ employeeProfile: { status: 'ready', name: '测试员工', department: '测试部门' } });
    expect(trials).toHaveLength(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
