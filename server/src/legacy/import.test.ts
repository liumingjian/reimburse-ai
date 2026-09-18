import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_BAOX_DIR } from '@baox/fixtures';
import { ActionFailureSchema, LegacyImportSchema, OCCUPANCY_COPY, TaskSnapshotSchema, type TaskList } from '@baox/contract';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { readBook } from '../books';
import { api, byFileName, sample } from '../test/api';
import { createTestServer, type TestClient, type TestServer } from '../test/harness';

// The one-time legacy `~/.baox` import on first-admin creation (#195, ADR-0015/0018), on the synthetic tree in
// @baox/fixtures (`LEGACY_BAOX_DIR`): Alice (tenant-a) is bound; a1 `saved`, b1 `upload_dispatched`, d1 `erp-fill`
// touched ERP; c1 never did.

let server: TestServer;
const scratch: string[] = [];
afterEach(async () => {
  await server.close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const start = async (legacyHome: string) => {
  server = await createTestServer({ legacyHome });
};

// A writable copy of the fixture tree, for the tests that corrupt it.
function copyTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'baox-legacy-'));
  scratch.push(dir);
  cpSync(LEGACY_BAOX_DIR, dir, { recursive: true });
  return dir;
}

// Every file path and its bytes, sorted: equal digests mean a byte-identical tree.
function treeDigest(root: string): string {
  const hash = createHash('sha256');
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      hash.update(`${entry.isDirectory() ? 'd' : 'f'}:${path}\0`);
      if (entry.isDirectory()) walk(path);
      else hash.update(readFileSync(join(root, path)));
    }
  };
  walk('');
  return hash.digest('hex');
}

const importOf = async (client: TestClient) => LegacyImportSchema.parse(await (await client.request('/api/legacy-import')).json());
const tasksOf = async (client: TestClient) => (await (await client.request('/api/tasks')).json()) as TaskList;
const legacyTaskId = async (client: TestClient, name: string) => {
  const found = (await tasksOf(client)).tasks.find((task) => task.name === name);
  if (!found) throw new Error(`no task ${name}`);
  return found.taskId;
};

// Every value stored anywhere in the database, as one string.
async function everything(): Promise<string> {
  const tables = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`.execute(server.db);
  const dump: unknown[] = [];
  for (const { name } of tables.rows) dump.push(name, (await sql`SELECT * FROM ${sql.table(name)}`.execute(server.db)).rows);
  return JSON.stringify(dump);
}

const counts = async () => ({
  runs: (await server.db.selectFrom('import_run').select('run_id').execute()).length,
  tasks: (await server.db.selectFrom('task').select('task_id').execute()).length,
  claims: (await server.db.selectFrom('legacy_claim').select('claim_id').execute()).length,
  books: (await server.db.selectFrom('project_book_event').select('event_id').execute()).length,
  homeCities: (await server.db.selectFrom('home_city_setting').select('setting_id').execute()).length,
});
const NOTHING = { tasks: 0, claims: 0, books: 0, homeCities: 0 };

describe('first-admin creation imports the legacy tree', () => {
  it('lands the home city, the personal book and the ERP-touched tasks with their occupancy; nothing else', async () => {
    const before = treeDigest(LEGACY_BAOX_DIR);
    await start(LEGACY_BAOX_DIR);
    const admin = await server.signIn('admin');

    expect(await importOf(admin)).toMatchObject({
      status: 'imported',
      canRetry: false,
      report: { homeCity: '杭州', projects: 2, handedOver: 1, handedOff: 2, invoices: 3, notMigrated: ['六月未提交'], problems: [] },
    });

    const list = await tasksOf(admin);
    expect(list.homeCity).toEqual({ value: '杭州', source: 'remembered' });
    expect(await server.db.selectFrom('home_city_setting').select(['account_id', 'home_city', 'source', 'created_at']).execute()).toEqual([
      { account_id: admin.account.accountId, home_city: '杭州', source: 'legacy_import', created_at: '2026-02-01T09:05:00Z' },
    ]);

    const book = await readBook(server.db, { scope: 'personal', ownerAccountId: admin.account.accountId });
    expect(book.map(({ number, name, expiresOn }) => ({ number, name, expiresOn }))).toEqual([
      { number: 'P-2307', name: '华东客户交付', expiresOn: '2026-12-31' },
      { number: 'P-3312', name: '产品调研', expiresOn: null },
    ]);
    expect(await readBook(server.db, { scope: 'public' })).toEqual([]);

    const legacy = list.tasks.map(({ name, stage, erpOutcome, erpDraftNo, abandonable }) => ({ name, stage, erpOutcome, erpDraftNo, abandonable }));
    expect(legacy.sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      [
        { name: '旧版任务 四月出差', stage: 'done', erpOutcome: 'none', erpDraftNo: 'BX-2026-0401', abandonable: false },
        { name: '旧版任务 五月打车', stage: 'reconcile', erpOutcome: 'handed_off', erpDraftNo: null, abandonable: false },
        { name: '旧版任务 三月填过一半', stage: 'reconcile', erpOutcome: 'handed_off', erpDraftNo: null, abandonable: false },
      ].sort((a, b) => a.name.localeCompare(b.name)),
    );
    const claims = await server.db.selectFrom('legacy_claim').select('invoice_key').orderBy('invoice_key').execute();
    expect(claims.map((claim) => claim.invoice_key)).toEqual(['einvoice-20:26312000000000000011', 'einvoice-20:26312000000098127734', 'vat-legacy:131002325021:04213377']);

    // No identity binding, and nothing of the untouched task c1, is stored anywhere.
    const stored = await everything();
    for (const absent of ['tenant-a', 'Alice', 'tenant-b', 'B-0001', '北京', '26312000000101557402', 'c1b2c3d4e5']) expect(stored).not.toContain(absent);

    expect(treeDigest(LEGACY_BAOX_DIR)).toBe(before);
  });

  it('legacy tasks are read-only terminals: snapshot only, no void, no action', async () => {
    await start(LEGACY_BAOX_DIR);
    const admin = await server.signIn('admin');
    const saved = TaskSnapshotSchema.parse(await (await admin.request(`/api/tasks/${await legacyTaskId(admin, '旧版任务 四月出差')}`)).json());
    expect(saved).toMatchObject({ stage: 'done', step: { kind: 'none' }, materials: [], erp: { status: 'done', draftNo: 'BX-2026-0401' }, reconcile: { status: 'none' } });
    const handedOff = TaskSnapshotSchema.parse(await (await admin.request(`/api/tasks/${await legacyTaskId(admin, '旧版任务 五月打车')}`)).json());
    expect(handedOff).toMatchObject({ stage: 'reconcile', step: { kind: 'none' }, reconcile: { status: 'handed_off', humanReview: true, allowedActions: [] } });

    const voided = await admin.post(`/api/tasks/${saved.task.taskId}/abandon`, {});
    expect(voided.status).toBe(400);
    expect(ActionFailureSchema.parse(await voided.json()).error.code).toBe('not_abandonable');
    const acted = await api(() => admin).act(handedOff, 'start-inventory');
    expect(acted.status).toBe(400);
    expect(ActionFailureSchema.parse(await acted.json()).error.code).toBe('task_closed');
    // Terminal: the admin may still create a task of their own.
    expect((await admin.post('/api/tasks', { homeCity: '杭州' })).status).toBe(200);
  });

  it('imported occupancy holds the invoices of ERP-touched legacy tasks against every account; untouched ones are free', async () => {
    await start(LEGACY_BAOX_DIR);
    const admin = await server.signIn('admin');
    const client = api(() => admin);
    const { task } = await client.createTask();
    const uploaded = await client.upload(task.taskId, [sample('m01'), sample('m03')]);
    await client.accepted(await client.act(uploaded, 'start-inventory'));
    const mine = await client.settled(task.taskId);
    const m01 = byFileName(mine, sample('m01').name);
    expect(mine.blockers).toEqual([
      expect.objectContaining({ kind: 'duplicate_across_tasks', materialId: m01.materialId, tasks: [expect.objectContaining({ name: '旧版任务 四月出差' })] }),
    ]);

    const bob = await server.signIn('bob');
    const bobs = api(() => bob);
    const other = await bobs.createTask();
    const bobUpload = await bobs.upload(other.task.taskId, [sample('m01')]);
    await bobs.accepted(await bobs.act(bobUpload, 'start-inventory'));
    const blocked = await bobs.settled(other.task.taskId);
    expect(blocked.blockers).toEqual([expect.objectContaining({ kind: 'duplicate_across_tasks', reason: OCCUPANCY_COPY.otherAccount, tasks: [] })]);
  });

  it('an imported vat-legacy holding blocks a new taxi receipt photo with the same 发票代码 + 发票号码 (#186)', async () => {
    await start(LEGACY_BAOX_DIR);
    const admin = await server.signIn('admin');
    const bob = await server.signIn('bob');
    // m09 reads 131002325021 / 04213377, the key imported from the legacy task 五月打车.
    for (const [client, expected] of [
      [admin, { tasks: [expect.objectContaining({ name: '旧版任务 五月打车' })] }],
      [bob, { reason: OCCUPANCY_COPY.otherAccount, tasks: [] }],
    ] as const) {
      const calls = api(() => client);
      const { task } = await calls.createTask();
      const uploaded = await calls.upload(task.taskId, [sample('m09')]);
      await calls.accepted(await calls.act(uploaded, 'start-inventory'));
      const settled = await calls.settled(task.taskId, 120_000);
      const m09 = byFileName(settled, sample('m09').name);
      expect(m09).toMatchObject({ kind: 'taxi_receipt' });
      expect(settled.blockers).toEqual([expect.objectContaining({ kind: 'duplicate_across_tasks', materialId: m09.materialId, ...expected })]);
    }
  }, 180_000);

  it('deactivating the importing account keeps its legacy tasks terminal and their occupancy held (#194)', async () => {
    await start(LEGACY_BAOX_DIR);
    const admin = await server.signIn('admin');
    const bob = await server.signIn('bob');
    expect((await admin.post(`/api/admin/accounts/${bob.account.accountId}`, { role: 'admin' })).status).toBe(200);
    expect((await bob.post(`/api/admin/accounts/${admin.account.accountId}`, { active: false })).status).toBe(200);

    const legacy = await server.db.selectFrom('task').select(['origin', 'lifecycle', 'account_id']).where('origin', '=', 'legacy').execute();
    expect(legacy).toEqual(Array(3).fill({ origin: 'legacy', lifecycle: 'handed_off', account_id: admin.account.accountId }));
    expect((await counts()).claims).toBe(3);

    const bobs = api(() => bob);
    const { task } = await bobs.createTask();
    const uploaded = await bobs.upload(task.taskId, [sample('m01')]);
    await bobs.accepted(await bobs.act(uploaded, 'start-inventory'));
    expect((await bobs.settled(task.taskId)).blockers).toEqual([expect.objectContaining({ kind: 'duplicate_across_tasks', reason: OCCUPANCY_COPY.otherAccount, tasks: [] })]);
  });

  it('fires on first-admin creation only; re-running is a no-op', async () => {
    await start(LEGACY_BAOX_DIR);
    const admin = await server.signIn('admin');
    const once = await counts();
    const bob = await server.signIn('bob');
    expect(await importOf(bob)).toEqual({ status: 'none', at: null, report: null, canRetry: false });
    expect((await tasksOf(bob)).tasks).toEqual([]);

    for (const client of [admin, bob]) {
      for (const path of ['/api/legacy-import/retry', '/api/legacy-import/skip']) {
        const response = await client.post(path, {});
        expect(response.status).toBe(400);
        expect(ActionFailureSchema.parse(await response.json()).error.code).toBe('import_not_pending');
      }
    }
    expect(await counts()).toEqual(once);
    expect(once.runs).toBe(1);
  });

  it('without a legacy tree records an absent run and imports nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'baox-no-legacy-'));
    scratch.push(home);
    await start(join(home, 'missing'));
    const admin = await server.signIn('admin');
    expect(await importOf(admin)).toMatchObject({ status: 'absent', canRetry: false });
    expect(await counts()).toEqual({ runs: 1, ...NOTHING });
  });
});

describe('a corrupt legacy tree', () => {
  const BROKEN = 'tasks/2026-05-10-b1b2c3d4e5/invoices.json';

  it('imports nothing and reports the problem; retry after fixing imports once', async () => {
    const home = copyTree();
    writeFileSync(join(home, ...BROKEN.split('/')), '{"invoices": [');
    const before = treeDigest(home);
    await start(home);
    const admin = await server.signIn('admin');

    expect(await importOf(admin)).toMatchObject({ status: 'failed', canRetry: true, report: { problems: [{ file: BROKEN, reason: expect.any(String) }] } });
    expect(await counts()).toEqual({ runs: 1, ...NOTHING });
    expect(treeDigest(home)).toBe(before);

    cpSync(join(LEGACY_BAOX_DIR, ...BROKEN.split('/')), join(home, ...BROKEN.split('/')));
    const retried = await admin.post('/api/legacy-import/retry', {});
    expect(retried.status).toBe(200);
    expect(LegacyImportSchema.parse(await retried.json())).toMatchObject({ status: 'imported', canRetry: false, report: { invoices: 3 } });
    expect(await counts()).toMatchObject({ runs: 2, tasks: 3, claims: 3, books: 2, homeCities: 1 });
    expect((await admin.post('/api/legacy-import/retry', {})).status).toBe(400);
  });

  it('explicit skip is recorded and ends the import', async () => {
    const home = copyTree();
    writeFileSync(join(home, 'home-cities.json'), '{not-json');
    await start(home);
    const admin = await server.signIn('admin');
    expect(await importOf(admin)).toMatchObject({ status: 'failed', report: { problems: [{ file: 'home-cities.json' }] } });

    const skipped = await admin.post('/api/legacy-import/skip', {});
    expect(skipped.status).toBe(200);
    expect(LegacyImportSchema.parse(await skipped.json())).toMatchObject({ status: 'skipped', canRetry: false });
    expect((await admin.post('/api/legacy-import/retry', {})).status).toBe(400);
    expect(await counts()).toEqual({ runs: 2, ...NOTHING });
  });

  it('an unexpected schema version or a foreign book is a problem too', async () => {
    const home = copyTree();
    writeFileSync(join(home, 'schema.json'), '{"schemaVersion": 2}');
    const book = join(home, 'projects', 'edf43860cf315becf548f9d9296bfc709227da2bc180b76b51fc7dc575c5c54b.json');
    writeFileSync(book, readFileSync(book, 'utf8').replace('"account": "alice"', '"account": "mallory"'));
    await start(home);
    const admin = await server.signIn('admin');
    const view = await importOf(admin);
    expect(view.status).toBe('failed');
    expect(view.report?.problems.map((problem) => problem.file)).toEqual(['schema.json', 'projects/edf43860cf315becf548f9d9296bfc709227da2bc180b76b51fc7dc575c5c54b.json']);
    expect(await counts()).toEqual({ runs: 1, ...NOTHING });
  });
});
