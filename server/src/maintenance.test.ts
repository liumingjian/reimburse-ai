import { lstatSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { PAIRING_CODE_TTL_MS, PAIRING_PATH, EXECUTOR_VERSION } from '@baox/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_TTL_MS } from './accounts/accounts';
import { databasePath } from './data-dir';
import type { FillExecutor } from './erp/fill-jobs';
import { TEST_ERP_ACCOUNT } from './erp/testing/fake-executor';
import { MAINTENANCE_GATE_VERSION } from './maintenance';
import { maintenanceSocketPath, startMaintenanceControl, type MaintenanceControl } from './maintenance-control';
import { inlineExecutor, type ParseExecutor } from './parse/executor';
import { startServer } from './server';
import { api, sample } from './test/api';
import { createTestServer, tempDataDir, type TestServer } from './test/harness';
import { scenario, scenarioServer } from './test/scenario';
import { openDatabase } from './db/database';

const TOKEN = 'test_maintenance_gate_token_0123456789';

type Command = 'status' | 'admit' | 'reopen';
type ControlResponse = {
  version: number;
  state: string;
  barrier: boolean;
  activeWrites: number | 'unknown';
  activeErpAttempt: boolean | 'unknown';
  reason?: string;
};

let server: TestServer | null = null;
let control: MaintenanceControl | null = null;

afterEach(async () => {
  await control?.close();
  control = null;
  await server?.close();
  server = null;
});

function operator(path: string, command: Command, token = TOKEN): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = '';
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    socket.setTimeout(5_000, () => settle(() => reject(new Error(`maintenance ${command} timed out`))));
    socket.once('error', (error) => settle(() => reject(error)));
    socket.once('connect', () => socket.write(`${JSON.stringify({ version: MAINTENANCE_GATE_VERSION, command, token })}\n`));
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as ControlResponse;
        socket.end();
        settle(() => resolve(response));
      } catch (error) {
        settle(() => reject(error));
      }
    });
    socket.once('end', () => settle(() => reject(new Error(`maintenance ${command} closed without a response`))));
  });
}

async function eventually<T>(read: () => Promise<T>, matches: (value: T) => boolean, description: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = await read();
    if (matches(value)) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function gatedParser(): { executor: ParseExecutor; entered: Promise<void>; release: () => void } {
  let release!: () => void;
  let markEntered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const inner = inlineExecutor();
  return {
    entered,
    release,
    executor: {
      async parse(input) {
        markEntered();
        await blocked;
        return inner.parse(input);
      },
      close: async () => release(),
    },
  };
}

describe('maintenance admission', () => {
  it('refuses an active ERP action attempt without cancelling its reimbursement task', async () => {
    let release = () => {};
    let markAttempt!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempted = new Promise<void>((resolve) => {
      markAttempt = resolve;
    });
    const executor: FillExecutor = async (plan, channel) => {
      await channel.emit({
        type: 'attempt_started',
        attemptId: `${plan.jobId}.import`,
        action: 'import',
        preconditions: {
          targetId: 'erp-page-1',
          url: `${plan.erpOrigin}/k3cloud/html5/index.aspx`,
          formInstanceId: 'form-1',
          formMode: 'new',
          billNo: null,
          receiptRowCount: 0,
          detailRowCount: 1,
        },
        expectedPostconditions: {},
        compatibility: plan.compatibility,
        erpAccount: TEST_ERP_ACCOUNT,
      });
      markAttempt();
      await held;
      const result = { type: 'result' as const, status: 'aborted' as const, code: 'maintenance_test_complete', message: null, billNo: null, capture: null };
      await channel.emit(result);
      return result;
    };

    try {
      const scenarios = await scenarioServer({ erpExecutor: executor });
      server = scenarios;
      const alice = await server.signIn('alice');
      control = await startMaintenanceControl({ gate: server.app.maintenance, path: maintenanceSocketPath(server.dataDir), token: TOKEN });
      const scene = await scenario(scenarios, alice).at('actions');

      await scene.accept('start-erp-write');
      await attempted;
      expect(await operator(control.path, 'admit')).toMatchObject({
        version: MAINTENANCE_GATE_VERSION,
        state: 'refused',
        barrier: false,
        activeWrites: 1,
        activeErpAttempt: true,
        reason: 'active_erp_attempt',
      });
      expect((await scene.snapshot()).erp.status).toBe('running');
      expect((await alice.request('/api/tasks')).status).toBe(200);

      release();
      await scene.settled();
      expect(await operator(control.path, 'status')).toMatchObject({ state: 'open', barrier: false, activeWrites: 0, activeErpAttempt: false });
    } finally {
      release();
    }
  });

  it('closes new HTTP writes while an in-flight parser write drains, then needs explicit reopening', async () => {
    const parser = gatedParser();
    server = await createTestServer({ parser: parser.executor });
    const alice = await server.signIn('alice');
    control = await startMaintenanceControl({ gate: server.app.maintenance, path: maintenanceSocketPath(server.dataDir), token: TOKEN });
    const client = api(() => alice);
    const { task } = await client.createTask('杭州');
    const uploaded = await client.upload(task.taskId, [sample('m07')]);
    await client.accepted(await client.act(uploaded, 'start-inventory'));
    await parser.entered;

    expect(await operator(control.path, 'admit')).toMatchObject({ state: 'admitting', barrier: true, activeWrites: 1, activeErpAttempt: false });
    const refused = await alice.post('/api/tasks', { homeCity: '上海' });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: { code: 'maintenance_in_progress', message: '系统正在维护，暂时不能修改数据。' } });

    parser.release();
    await client.settled(task.taskId);
    await eventually(() => operator(control!.path, 'status'), (status) => status.state === 'admitted' && status.activeWrites === 0, 'maintenance drain');
    expect((await alice.post('/api/tasks', { homeCity: '上海' })).status).toBe(503);
    expect(await operator(control.path, 'reopen')).toMatchObject({ state: 'open', barrier: false, activeWrites: 0, activeErpAttempt: false });
    expect((await alice.post('/api/project-book/intake', { number: 'GATE-OPEN', name: 'Maintenance reopened' })).status).toBe(200);
  });

  it('leaves side-effecting session reads read-only while admitted', async () => {
    server = await createTestServer();
    const alice = await server.signIn('alice');
    control = await startMaintenanceControl({ gate: server.app.maintenance, path: maintenanceSocketPath(server.dataDir), token: TOKEN });
    const before = await server.db.selectFrom('session').select(['token_sha256', 'expires_at']).executeTakeFirstOrThrow();

    // This makes the next lookup renew the sliding session under normal operation.
    server.clock.advance(24 * 60 * 60 * 1000 + 1);
    expect(await operator(control.path, 'admit')).toMatchObject({ state: 'admitted', barrier: true, activeWrites: 0 });
    const renewed = await alice.request('/api/tasks');
    expect(renewed.status).toBe(200);
    expect(renewed.headers.get('set-cookie')).toBeNull();
    expect(await server.db.selectFrom('session').select('expires_at').where('token_sha256', '=', before.token_sha256).executeTakeFirstOrThrow()).toEqual({ expires_at: before.expires_at });

    // The same gate also prevents a read from deleting an expired session. Authentication still refuses it.
    server.clock.advance(SESSION_TTL_MS);
    expect((await alice.request('/api/tasks')).status).toBe(401);
    expect(await server.db.selectFrom('session').select('token_sha256').where('token_sha256', '=', before.token_sha256).executeTakeFirst()).toEqual({ token_sha256: before.token_sha256 });
  });

  it('keeps pairing GET and WebSocket liveness writes outside an admitted window', async () => {
    server = await createTestServer();
    const alice = await server.signIn('alice');
    control = await startMaintenanceControl({ gate: server.app.maintenance, path: maintenanceSocketPath(server.dataDir), token: TOKEN });

    // An expired pairing code normally deletes its row when the settings GET renders it.
    await alice.post('/api/pairing/code', {});
    server.clock.advance(PAIRING_CODE_TTL_MS + 1);
    expect(await operator(control.path, 'admit')).toMatchObject({ state: 'admitted', barrier: true });
    expect((await (await alice.request('/api/pairing')).json()) as { status: string }).toMatchObject({ status: 'none' });
    expect(await server.db.selectFrom('pairing').select('account_id').where('account_id', '=', alice.account.accountId).executeTakeFirst()).toEqual({ account_id: alice.account.accountId });

    // Reopen only to make a pairing, then close again before its real channel hello would update liveness/version.
    expect(await operator(control.path, 'reopen')).toMatchObject({ state: 'open', barrier: false });
    const issued = (await (await alice.post('/api/pairing/code', {})).json()) as { code: string };
    const redeemed = await server.app.request(PAIRING_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: issued.code, version: EXECUTOR_VERSION }),
    });
    expect(redeemed.status).toBe(200);
    const { token } = (await redeemed.json()) as { token: string };
    const before = await server.db.selectFrom('pairing').select(['last_connected_at', 'version']).where('account_id', '=', alice.account.accountId).executeTakeFirstOrThrow();
    server.clock.advance(60_000);
    expect(await operator(control.path, 'admit')).toMatchObject({ state: 'admitted', barrier: true, activeWrites: 0 });

    const heard: unknown[] = [];
    const session = server.app.executorHub.open({
      send: (message) => heard.push(JSON.parse(message) as unknown),
      close: () => undefined,
    });
    await session.message(JSON.stringify({ type: 'hello', token, version: EXECUTOR_VERSION }));
    expect(heard).toContainEqual(expect.objectContaining({ type: 'ready', accountId: alice.account.accountId }));
    expect(await server.db.selectFrom('pairing').select(['last_connected_at', 'version']).where('account_id', '=', alice.account.accountId).executeTakeFirstOrThrow()).toEqual(before);
    expect(await operator(control.path, 'status')).toMatchObject({ state: 'admitted', activeWrites: 0 });
    session.closed();
  });
});

describe('the local controller', () => {
  it('persists an admitted barrier across a real server restart and has no browser-facing control route', async () => {
    const dataDir = tempDataDir();
    let running: Awaited<ReturnType<typeof startServer>> | null = null;
    try {
      running = await startServer({ dataDir, port: 0, maintenanceToken: TOKEN });
      const socket = running.maintenanceSocketPath;
      expect(socket).toBe(maintenanceSocketPath(dataDir));
      expect(lstatSync(socket ?? '').mode & 0o777).toBe(0o600);
      expect(await operator(socket ?? '', 'status')).toMatchObject({ state: 'open', barrier: false, activeWrites: 0, activeErpAttempt: false });
      expect(await operator(socket ?? '', 'status', 'wrong_maintenance_gate_token_0123456789')).toMatchObject({ state: 'unknown', barrier: true, reason: 'unauthorized' });
      expect((await fetch(`${running.url}/maintenance-gate`)).status).toBe(404);

      expect(await operator(socket ?? '', 'admit')).toMatchObject({ state: 'admitted', barrier: true, activeWrites: 0, activeErpAttempt: false });
      const blocked = await fetch(`${running.url}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'test-password' }) });
      expect(blocked.status).toBe(503);
      await running.close();
      running = null;

      running = await startServer({ dataDir, port: 0, maintenanceToken: TOKEN });
      expect(await operator(running.maintenanceSocketPath ?? '', 'status')).toMatchObject({ state: 'admitted', barrier: true, activeWrites: 0, activeErpAttempt: false });
      const stillBlocked = await fetch(`${running.url}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'test-password' }) });
      expect(stillBlocked.status).toBe(503);
      expect(await operator(running.maintenanceSocketPath ?? '', 'reopen')).toMatchObject({ state: 'open', barrier: false });
      expect((await fetch(`${running.url}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'test-password' }) })).status).toBe(200);
    } finally {
      await running?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.each(['missing', 'corrupt'] as const)('fails closed when the durable barrier row is %s', async (condition) => {
    const dataDir = tempDataDir();
    let running: Awaited<ReturnType<typeof startServer>> | null = null;
    try {
      running = await startServer({ dataDir, port: 0, maintenanceToken: TOKEN });
      await running.close();
      running = null;
      const db = await openDatabase(databasePath(dataDir));
      if (condition === 'missing') await db.deleteFrom('maintenance_gate').where('gate_id', '=', 'main').execute();
      else await db.updateTable('maintenance_gate').set({ state: 'corrupt' }).where('gate_id', '=', 'main').execute();
      await db.destroy();

      running = await startServer({ dataDir, port: 0, maintenanceToken: TOKEN });
      const socket = running.maintenanceSocketPath ?? '';
      expect(await operator(socket, 'status')).toEqual({
        version: MAINTENANCE_GATE_VERSION,
        state: 'unknown',
        barrier: true,
        activeWrites: 'unknown',
        activeErpAttempt: 'unknown',
        reason: 'unknown_write_state',
      });
      expect(await operator(socket, 'admit')).toMatchObject({ state: 'unknown', barrier: true });
      expect(await operator(socket, 'reopen')).toMatchObject({ state: 'unknown', barrier: true });
      expect((await fetch(`${running.url}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'test-password' }) })).status).toBe(503);
    } finally {
      await running?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('marks recovery unknown rather than settling an unfinished job behind an admitted barrier', async () => {
    const dataDir = tempDataDir();
    let first: TestServer | null = null;
    let running: Awaited<ReturnType<typeof startServer>> | null = null;
    try {
      first = await createTestServer({ database: databasePath(dataDir), dataDir });
      const alice = await first.signIn('alice');
      const { task } = await api(() => alice).createTask('杭州');
      const at = new Date().toISOString();
      await first.db.insertInto('erp_job').values({
        job_id: 'recovery-behind-maintenance',
        task_id: task.taskId,
        account_id: alice.account.accountId,
        kind: 'fill',
        trigger: 'start',
        confirmation_digest: 'recovery-test',
        plan: '{}',
        revision: 1,
        started_at: at,
      }).execute();
      await first.db.updateTable('maintenance_gate').set({ state: 'closed', updated_at: at }).where('gate_id', '=', 'main').execute();
      await first.app.close();
      await first.db.destroy();
      first = null;

      running = await startServer({ dataDir, port: 0, maintenanceToken: TOKEN });
      const socket = running.maintenanceSocketPath ?? '';
      expect(await operator(socket, 'status')).toMatchObject({ state: 'unknown', barrier: true, reason: 'unknown_write_state' });
      expect(await operator(socket, 'reopen')).toMatchObject({ state: 'unknown', barrier: true });
      await running.close();
      running = null;

      const db = await openDatabase(databasePath(dataDir));
      try {
        expect(await db.selectFrom('maintenance_gate').select('state').where('gate_id', '=', 'main').executeTakeFirstOrThrow()).toEqual({ state: 'unknown' });
        expect(await db.selectFrom('erp_job_event').select('event_id').where('job_id', '=', 'recovery-behind-maintenance').execute()).toEqual([]);
      } finally {
        await db.destroy();
      }
    } finally {
      await running?.close();
      if (first) {
        await first.app.close();
        await first.db.destroy();
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
