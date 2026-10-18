import { randomBytes } from 'node:crypto';
import { ERP_CREDENTIAL_ERRORS, ERP_CREDENTIALS_MISSING_CODE, PAIRING_PATH, CLIENT_VERSION, ErpCredentialsViewSchema, PairingViewSchema, PairingTokenSchema, type PairingHolderKind } from '@baox/contract';
import { abortedResult } from '@baox/erp-executor/protocol';
import { COMPATIBILITY, ERP_ORIGIN } from '@baox/erp-executor/testing/scenario';
import { EXECUTOR_METHODS, SIGN_IN_REFUSED_CODE, type TrySignInAnswer, type TrySignInRequest } from '@baox/erp-executor/wire';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drafted, handedOver, uncertainDraft, uncertainSave } from './erp/testing/fake-executor';
import { draftMarkOf } from './erp/remote-executor';
import { fakeExtension, type FakeExtension, type FillRunner } from './erp/testing/fake-extension';
import type { TestClient } from './test/harness';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

// ERP 凭据 hosted for the baox 本地执行器 (ADR-0033, erp-headless-v1.md line 2 item 1): saved write-only, sealed with
// the server's key, tried on the employee's PC through the paired 本地执行器, deleted the moment ERP refuses them, and
// sent down with each job to a 本地执行器 only.

const EXTENSION_ORIGIN = 'chrome-extension://kmbhfnaoapecjdgphfnbkejnnojfeeih';
const PASSWORD = 'erp-Pa55-秘密';

let server: ScenarioServer;
let alice: TestClient;

async function start(key: Buffer | null = randomBytes(32)) {
  server = await scenarioServer({ erpExecutor: 'extension', erpConfig: { origin: ERP_ORIGIN, compatibility: COMPATIBILITY }, erpCredentialKey: key });
  alice = await server.signIn('alice');
}
beforeEach(() => start());
afterEach(() => server.close());

async function pair(owner: TestClient, holder?: PairingHolderKind): Promise<string> {
  const issued = PairingViewSchema.parse(await (await owner.post('/api/extension/pairing/code', {})).json());
  const redeemed = await server.app.request(PAIRING_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
    body: JSON.stringify({ code: issued.code, browser: 'baox 本地执行器（darwin）', version: CLIENT_VERSION, ...(holder ? { holder } : {}) }),
  });
  return PairingTokenSchema.parse(await redeemed.json()).token;
}

const trials: TrySignInRequest[] = [];
beforeEach(() => { trials.length = 0; });
async function executor(answer: TrySignInAnswer = { ok: true }, fill?: FillRunner, holder: PairingHolderKind = 'local_executor'): Promise<FakeExtension> {
  const extension = fakeExtension(server.app.extensionChannel, await pair(alice, holder), {
    trySignIn: async (request) => { trials.push(request); return answer; },
    ...(fill ? { fill } : {}),
  });
  await extension.connect();
  return extension;
}

const view = async (response: Response) => ErpCredentialsViewSchema.parse(await response.json());
const save = (password = PASSWORD) => alice.post('/api/erp-credentials', { account: 'zhangsan', password });

describe('ERP 凭据 on the settings page', () => {
  it('saves them write-only, tries them on the PC, and never answers or stores the password in the clear', async () => {
    await executor();
    const saved = await save();

    expect(saved.status).toBe(200);
    expect(await view(saved)).toMatchObject({ available: true, status: 'authorised', erpAccount: 'zhangsan', message: null, checkedAt: expect.any(String) });
    expect(trials).toEqual([{ erpOrigin: ERP_ORIGIN, credentials: { account: 'zhangsan', password: PASSWORD } }]);
    const read = await (await alice.request('/api/erp-credentials')).text();
    expect(read).not.toContain(PASSWORD);
    const row = await server.db.selectFrom('erp_credential').selectAll().executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
  });

  it('deletes the password at once when ERP refuses it, and has nothing left to try', async () => {
    await executor({ ok: false, code: SIGN_IN_REFUSED_CODE, message: 'ERP 拒绝了这组账号密码：密码错误。' });
    expect(await view(await save())).toMatchObject({ status: 'refused', erpAccount: 'zhangsan', message: 'ERP 拒绝了这组账号密码：密码错误。' });
    expect((await server.db.selectFrom('erp_credential').select('password_sealed').executeTakeFirstOrThrow()).password_sealed).toBeNull();

    const again = await alice.post('/api/erp-credentials/test', {});
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: { code: 'erp_credentials_none' } });
    expect(trials).toHaveLength(1);
  });

  it('keeps them untested, with the reason, when the 试登录 fails for any other reason', async () => {
    await executor({ ok: false, code: 'erp_sign_in_second_factor', message: '要短信验证码。' });
    expect(await view(await save())).toMatchObject({ status: 'untested', message: '要短信验证码。' });
  });

  it.each<[string, () => Promise<void>, string]>([
    ['nothing is paired', async () => undefined, ERP_CREDENTIAL_ERRORS.notPaired],
    ['no 本地执行器 is connected', async () => { await pair(alice, 'local_executor'); }, ERP_CREDENTIAL_ERRORS.noExecutor],
    ['the pairing is a 浏览器扩展', async () => { await executor({ ok: true }, undefined, 'extension'); }, ERP_CREDENTIAL_ERRORS.notLocalExecutor],
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
    const extension = await executor({ ok: true }, (plan, channel) => uncertainSave(plan, channel));
    await save();
    const scene = await sceneOnFakeErp();

    await scene.run('start-erp-write');

    const fill = extension.asked().find((asked) => asked.method === EXECUTOR_METHODS.fill)!;
    expect(fill.payload).toMatchObject({ credentials: { account: 'zhangsan', password: PASSWORD } });
    const stored = await server.db.selectFrom('erp_job').select('plan').where('task_id', '=', scene.task.taskId).executeTakeFirstOrThrow();
    expect(stored.plan).not.toContain(PASSWORD);
  });

  it('never sends them to a 浏览器扩展', async () => {
    const extension = await executor({ ok: true }, (plan, channel) => uncertainSave(plan, channel), 'extension');
    await server.db.insertInto('erp_credential').values({ account_id: alice.account.accountId, erp_account: 'zhangsan', password_sealed: 'v1.x.y.z', status: 'authorised', message: null, saved_at: new Date().toISOString(), checked_at: null }).execute();
    const scene = await sceneOnFakeErp();

    await scene.run('start-erp-write');

    expect(extension.asked().find((asked) => asked.method === EXECUTOR_METHODS.fill)!.payload).not.toHaveProperty('credentials');
    expect(extension.asked().find((asked) => asked.method === EXECUTOR_METHODS.fill)!.payload).not.toHaveProperty(['plan', 'draft']);
  });

  // ADR-0029: the 本地执行器 runs unattended, so it 暂存s the bill under the job's ownership marker.
  it('asks the 本地执行器 to 暂存 under the job\'s marker, and ends at ERP 草稿已交接', async () => {
    const extension = await executor({ ok: true }, drafted);
    await save();
    const scene = await sceneOnFakeErp();

    const done = await scene.run('start-erp-write');

    const fill = extension.asked().find((asked) => asked.method === EXECUTOR_METHODS.fill)!;
    const jobId = (fill.payload as { plan: { jobId: string } }).plan.jobId;
    expect(fill.payload).toMatchObject({ plan: { draft: { mark: draftMarkOf(jobId) } } });
    expect(draftMarkOf(jobId)).toMatch(/^baox-[a-z0-9]{10}$/);
    expect(done).toMatchObject({ stage: 'done', erp: { status: 'done', outcome: 'drafted', draftNo: null } });
  });

  it('offers 对账 by the marker and 转人工, never 重新去报销, when 暂存 was pressed and its result is unknown', async () => {
    await executor({ ok: true }, uncertainDraft);
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
    await executor({ ok: true }, async () => abortedResult(SIGN_IN_REFUSED_CODE, 'ERP 拒绝了这组账号密码：密码已过期。'));
    await save();
    const scene = await sceneOnFakeErp();

    await scene.run('start-erp-write');

    expect(await view(await alice.request('/api/erp-credentials'))).toMatchObject({ status: 'refused', message: 'ERP 拒绝了这组账号密码：密码已过期。' });
    expect((await server.db.selectFrom('erp_credential').select('password_sealed').executeTakeFirstOrThrow()).password_sealed).toBeNull();
  });
});

// 按路线的步骤文案 (#423, spec #412 part B): a job records the route it ran on, the pairing holder when it started, and
// its step list follows that route for good. Switching methods later rewrites no past job.
describe('the 去报销 step list follows the route the job ran on', () => {
  const titles = (snapshot: { erp: { steps: Array<{ title: string }> } }) => snapshot.erp.steps.map((step) => step.title);
  const LOCAL = ['启动后台浏览器', '登录', '报销信息核对', '打开空白报销单', '导入发票', '收票回读', '填写明细', '暂存到报销系统'];
  const EXTENSION = ['打开报销系统标签页', '登录', '报销信息核对', '打开空白报销单', '导入发票', '收票回读', '填写明细', '交接单据'];

  it('keeps a 本地执行器 job on the 本地执行器 list after the account switches to the 浏览器扩展', async () => {
    await executor({ ok: true }, drafted);
    await save();
    const scene = await scenario(server, alice).at('actions');

    const done = await scene.run('start-erp-write');
    expect(titles(done)).toEqual(LOCAL);
    expect(done.erp.steps.at(-1)).toMatchObject({ description: '你检查后自己提交', status: 'done' });
    expect(done.erp.progress).toEqual({ label: '核对暂存单', percent: 100 });
    expect(await server.db.selectFrom('erp_job').select('route').where('task_id', '=', scene.task.taskId).execute()).toEqual([{ route: 'local_executor' }]);

    await executor({ ok: true }, undefined, 'extension');
    expect(titles(await scene.snapshot())).toEqual(LOCAL);
  });

  // A job from before routes were recorded (migration 0023, route null) that 暂存'd can only have run on a 本地执行器:
  // only it gets the draft mark and the 凭据. Its list does not follow the holder the account has now.
  it('keeps a 暂存 job from before routes were recorded on the 本地执行器 list after the switch', async () => {
    await executor({ ok: true }, drafted);
    await save();
    const scene = await scenario(server, alice).at('actions');
    await scene.run('start-erp-write');
    // erp_job is append-only; lift the guard just long enough to make the row look pre-0023.
    await sql`DROP TRIGGER erp_job_no_update`.execute(server.db);
    await server.db.updateTable('erp_job').set({ route: null }).where('task_id', '=', scene.task.taskId).execute();

    await executor({ ok: true }, undefined, 'extension');

    expect(titles(await scene.snapshot())).toEqual(LOCAL);
  });

  it('gives a 浏览器扩展 job the list it always had, ending in 交接单据', async () => {
    await executor({ ok: true }, handedOver(), 'extension');
    const scene = await scenario(server, alice).at('actions');

    const done = await scene.run('start-erp-write');

    expect(titles(done)).toEqual(EXTENSION);
    expect(done.erp.progress).toEqual({ label: '交接单据', percent: 100 });
    expect(await server.db.selectFrom('erp_job').select('route').where('task_id', '=', scene.task.taskId).execute()).toEqual([{ route: 'extension' }]);
  });
});
