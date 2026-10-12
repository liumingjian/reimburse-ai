import { randomBytes } from 'node:crypto';
import { ERP_CREDENTIAL_ERRORS, ERP_CREDENTIALS_MISSING_CODE, EXTENSION_PAIR_PATH, EXTENSION_VERSION, ErpCredentialsViewSchema, ExtensionPairingSchema, ExtensionTokenSchema, type ExtensionHolder } from '@baox/contract';
import { abortedResult } from '@baox/erp-executor/protocol';
import { COMPATIBILITY, ERP_ORIGIN } from '@baox/erp-executor/testing/scenario';
import { EXECUTOR_METHODS, SIGN_IN_REFUSED_CODE, type TrySignInAnswer, type TrySignInRequest } from '@baox/erp-executor/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uncertainSave } from './erp/testing/fake-executor';
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

async function pair(owner: TestClient, holder?: ExtensionHolder): Promise<string> {
  const issued = ExtensionPairingSchema.parse(await (await owner.post('/api/extension/pairing/code', {})).json());
  const redeemed = await server.app.request(EXTENSION_PAIR_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
    body: JSON.stringify({ code: issued.code, browser: 'baox 本地执行器（darwin）', version: EXTENSION_VERSION, ...(holder ? { holder } : {}) }),
  });
  return ExtensionTokenSchema.parse(await redeemed.json()).token;
}

const trials: TrySignInRequest[] = [];
beforeEach(() => { trials.length = 0; });
async function executor(answer: TrySignInAnswer = { ok: true }, fill?: FillRunner, holder: ExtensionHolder = 'local_executor'): Promise<FakeExtension> {
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

  it.each([
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
