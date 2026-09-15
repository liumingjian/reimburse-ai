import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { AssignProjectLinesInputSchema, CreateTaskInputSchema, ERP_ACTION_ERRORS, PendingAnswerSchema, ProjectAssignmentInputSchema, SetHomeCityInputSchema, type ProjectBookResult, SNAPSHOT_EVENT, STALE_STEP_CODE, STALE_STEP_HTTP_STATUS, STALE_STEP_NOTICE, type TaskSnapshot } from '@baox/contract';
import { z } from 'zod';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { AuthRefusal, createAccountService, type Clock } from './accounts/accounts';
import { accountOf, mountAuthRoutes, requireAccount, type AppEnv } from './accounts/http';
import type { Db } from './db/database';
import { createInMemoryErpLease, type ErpLease } from './erp-lease';
import { workerExecutor, type ParseExecutor } from './parse/executor';
import { createParseJobs, type ParseJobs } from './parse/jobs';
import { createBookService } from './books';
import { createLegacyImport, LegacyImportRefusal } from './legacy/import';
import { unavailableCatalog, type ProjectCatalog } from './catalog/project-catalog';
import { ActionRefusedError, createTaskService, parseBacklogOfAllAccounts, StaleStepError, TaskNotFoundError, type TaskService, type UploadedFile } from './tasks';

// The HTTP app. Wire rules (contract/src/http.ts): success is 200 with the whole new snapshot; failure is
// `{ error: { code, message } }`; a stale stepToken is 409 `{ error, snapshot }` with the fresh snapshot; SSE pushes
// whole snapshots as `event: snapshot`. The task service publishes every accepted change, so routes never do.
// Every `/api/*` route other than `/api/session` and `/api/auth/*` needs a session (401 otherwise) and acts only on
// the signed-in account's data: a task of another account is 404, admins included (ADR-0018).
// Tests drive it through `app.request()`; `startServer` puts it on 127.0.0.1.

export type AppOptions = {
  db: Db;
  dataDir: string;
  // The built frontend (`web/dist`), served same-origin in production. Absent in tests and under `pnpm dev`.
  webDist?: string | null;
  // Session expiry reads this clock; tests move it.
  now?: Clock;
  // The global ERP control lease (ADR-0016). #191 passes the one its ERP job acquires.
  erpLease?: ErpLease;
  // Where the parser job parses; the server's one worker_thread by default. Tests inject inline or gated executors.
  parser?: ParseExecutor;
  // The read-only project catalog behind 个人项目簿 intake and recheck (ADR-0008). Unavailable until #191 wires the
  // live ERP query adapter; tests and e2e pass a fixture-backed fake.
  projectCatalog?: ProjectCatalog;
  // The legacy `~/.baox` read once when the first admin is created (ADR-0018). null (default) imports nothing;
  // `main.ts` passes `$BAOX_HOME` or `~/.baox`.
  legacyHome?: string | null;
};

// `close` stops the background jobs (after the material in flight) and releases the parse worker; call it before
// closing the database.
export type App = Hono<AppEnv> & { close: () => Promise<void> };

type SnapshotListener = (snapshot: TaskSnapshot) => void;

const failure = (c: Context, status: 400 | 401 | 404 | 409, code: string, message: string) => c.json({ error: { code, message } }, status);

export function createApp({ db, dataDir, webDist = null, now = () => new Date(), erpLease = createInMemoryErpLease(), parser, projectCatalog = unavailableCatalog(), legacyHome = null }: AppOptions): App {
  const accounts = createAccountService(db, now);
  const legacy = createLegacyImport(db, legacyHome, now);
  // Keyed by task id; a task's stream only ever opens for its owner.
  const listeners = new Map<string, Set<SnapshotListener>>();
  let jobs: ParseJobs | null = null;
  const publish = (snapshot: TaskSnapshot, accountId: string) => {
    for (const listener of listeners.get(snapshot.task.taskId) ?? []) listener(snapshot);
    // A run with materials still waiting (just started, or mid-way) needs its parser job.
    if (snapshot.inventory.status === 'running') jobs?.ensure(accountId, snapshot.task.taskId);
  };
  // Every task service is scoped to one account; the parser job gets the owner's service for each task it drives.
  const serviceFor = (accountId: string) => createTaskService(db, dataDir, accountId, { onChange: (snapshot) => publish(snapshot, accountId) });
  const tasksOf = (c: Context<AppEnv>) => serviceFor(accountOf(c).accountId);
  const parseJobs = createParseJobs(serviceFor, () => parseBacklogOfAllAccounts(db, dataDir), parser ?? workerExecutor());
  jobs = parseJobs;
  // A restart mid-job picks up every account's backlog again: what is left is derived from the facts.
  parseJobs.resumeAll();

  const app = new Hono<AppEnv>();

  app.onError((error, c) => {
    if (error instanceof TaskNotFoundError) return failure(c, 404, 'task_not_found', '没有这个报销任务。');
    if (error instanceof AuthRefusal) return failure(c, error.status, error.code, error.message);
    if (error instanceof LegacyImportRefusal) return failure(c, 400, error.code, error.message);
    if (error instanceof StaleStepError) return c.json({ error: { code: STALE_STEP_CODE, message: STALE_STEP_NOTICE }, snapshot: error.snapshot }, STALE_STEP_HTTP_STATUS);
    if (error instanceof ActionRefusedError) {
      const body = { error: error.error, ...(error.snapshot ? { snapshot: error.snapshot } : {}), ...(error.taskList ? { taskList: error.taskList } : {}) };
      return c.json(body, error.error.code === 'task_not_found' ? 404 : 400);
    }
    throw error;
  });

  // Creating the first admin runs the one-time legacy import into that account (ADR-0018).
  mountAuthRoutes(app, {
    ...accounts,
    async setup(credentials) {
      const signedIn = await accounts.setup(credentials);
      await legacy.onFirstAdmin(signedIn.account.accountId);
      return signedIn;
    },
  });
  app.use('/api/*', requireAccount(accounts));

  // 旧数据导入 (legacy import) as the signed-in account sees it; only the owner of a failed run may retry or skip.
  app.get('/api/legacy-import', async (c) => c.json(await legacy.view(accountOf(c).accountId)));
  app.post('/api/legacy-import/retry', async (c) => {
    const view = await legacy.retry(accountOf(c).accountId);
    await tasksOf(c).bookChanged();
    return c.json(view);
  });
  app.post('/api/legacy-import/skip', async (c) => c.json(await legacy.skip(accountOf(c).accountId)));

  app.get('/api/tasks', async (c) => c.json(await tasksOf(c).list()));

  app.post('/api/tasks', async (c) => {
    const input = CreateTaskInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return failure(c, 400, 'invalid_input', input.error.issues[0]?.message ?? '请求无效。');
    return c.json(await tasksOf(c).create(input.data.homeCity));
  });

  // 完全重置 (reset), per account: voids the signed-in account's own tasks; other accounts, accounts themselves and
  // sessions are untouched. Answers the new task list.
  app.post('/api/reset', async (c) => c.json(await tasksOf(c).resetAll()));

  // 个人项目簿 (personal book) of the signed-in account. A processed maintenance request is 200 with a
  // ProjectBookResult, including the not-done statuses; a change pushes fresh snapshots of the account's open tasks.
  const bookOf = (c: Context<AppEnv>) => createBookService(db, { scope: 'personal', ownerAccountId: accountOf(c).accountId }, accountOf(c).accountId, projectCatalog, now);
  const CHANGED: ReadonlySet<ProjectBookResult['status']> = new Set(['admitted', 'removed', 'purged', 'done']);
  const bookAction = (run: (c: Context<AppEnv>, number: string) => Promise<ProjectBookResult>, needsNumber: boolean) => async (c: Context<AppEnv>) => {
    const body = (await c.req.json().catch(() => ({}))) as { number?: unknown };
    if (needsNumber && (typeof body.number !== 'string' || body.number.trim() === '')) return c.json({ error: { code: 'invalid_input', message: '请填写项目号。' }, book: await bookOf(c).view() }, 400);
    const result = await run(c, typeof body.number === 'string' ? body.number : '');
    if (CHANGED.has(result.status)) await tasksOf(c).bookChanged();
    return c.json(result);
  };
  app.get('/api/project-book', async (c) => c.json(await bookOf(c).view()));
  app.post('/api/project-book/intake', bookAction((c, number) => bookOf(c).intake(number), true));
  app.post('/api/project-book/remove', bookAction((c, number) => bookOf(c).remove(number), true));
  app.post('/api/project-book/purge', bookAction((c) => bookOf(c).purge(), false));
  app.post('/api/project-book/recheck', bookAction((c) => bookOf(c).recheck(), false));

  app.get('/api/tasks/:id', async (c) => c.json(await tasksOf(c).snapshot(c.req.param('id'))));

  app.post('/api/tasks/:id/batches', async (c) => {
    const body = await c.req.parseBody({ all: true });
    const entries = ([] as unknown[]).concat(body['files'] ?? []);
    const files: UploadedFile[] = [];
    for (const entry of entries) {
      if (!(entry instanceof File)) continue;
      files.push({ fileName: entry.name, mime: entry.type || 'application/octet-stream', bytes: new Uint8Array(await entry.arrayBuffer()) });
    }
    if (files.length === 0) return failure(c, 400, 'no_files', '没有收到文件。');
    return c.json(await tasksOf(c).upload(c.req.param('id'), files));
  });

  app.post('/api/tasks/:id/abandon', async (c) => c.json(await tasksOf(c).voidTask(c.req.param('id'))));

  // 去报销. Only the lease guard exists so far: while another task holds the ERP lease the answer is 409 with a
  // wording that names no account or task (ADR-0018). #191 replaces the not-ready tail with the real start.
  // Registered before the generic action route, which would otherwise answer it.
  app.post('/api/tasks/:id/actions/start-erp-write', async (c) => {
    const taskId = c.req.param('id');
    const snapshot = await tasksOf(c).snapshot(taskId);
    const holder = erpLease.holder();
    if (holder && holder.taskId !== taskId) return c.json({ error: { code: 'erp_in_use', message: ERP_ACTION_ERRORS.inUse }, snapshot }, 409);
    return failure(c, 400, 'not_ready', ERP_ACTION_ERRORS.notReady);
  });

  app.post('/api/tasks/:id/actions/:name', async (c) => {
    const action = TASK_ACTIONS[c.req.param('name')];
    if (!action) return failure(c, 404, 'not_found', '没有这个接口。');
    const input = action.input.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return failure(c, 400, 'invalid_input', input.error.issues[0]?.message ?? '请求无效。');
    return c.json(await action.run(tasksOf(c), c.req.param('id'), input.data));
  });

  // SSE: the current snapshot on connect, then every new one. Nothing buffers it (the Vite proxy passes it through).
  app.get('/api/tasks/:id/events', async (c) => {
    const taskId = c.req.param('id');
    const first = await tasksOf(c).snapshot(taskId);
    c.header('Cache-Control', 'no-cache');
    return streamSSE(c, async (stream) => {
      const send = (snapshot: TaskSnapshot) => stream.writeSSE({ event: SNAPSHOT_EVENT, data: JSON.stringify(snapshot) });
      await send(first);
      const listener: SnapshotListener = (snapshot) => void send(snapshot);
      const set = listeners.get(taskId) ?? new Set();
      set.add(listener);
      listeners.set(taskId, set);
      await new Promise<void>((done) => stream.onAbort(done));
      set.delete(listener);
    });
  });

  app.all('/api/*', (c) => failure(c, 404, 'not_found', '没有这个接口。'));

  if (webDist) app.get('*', (c) => serveWebFile(c, webDist));

  return Object.assign(app, { close: () => parseJobs.close() });
}

// Task actions (`POST /api/tasks/:id/actions/<name>`), each with its JSON input. Later slices add their entries here.
type TaskAction = { input: z.ZodType; run: (tasks: TaskService, taskId: string, input: unknown) => Promise<TaskSnapshot> };
const withToken = <T extends z.ZodRawShape>(shape: T) => z.object({ stepToken: z.string().min(1), ...shape });
// `run` only ever receives what `input` parsed.
const taskAction = <S extends z.ZodType>(input: S, run: (tasks: TaskService, taskId: string, input: z.infer<S>) => Promise<TaskSnapshot>): TaskAction => ({
  input,
  run: (tasks, taskId, parsed) => run(tasks, taskId, parsed as z.infer<S>),
});

const TASK_ACTIONS: Readonly<Record<string, TaskAction>> = {
  'start-inventory': taskAction(withToken({}), (tasks, id, { stepToken }) => tasks.startInventory(id, stepToken)),
  'reopen-upload': taskAction(withToken({}), (tasks, id, { stepToken }) => tasks.reopenUpload(id, stepToken)),
  'assign-project-lines': taskAction(withToken(AssignProjectLinesInputSchema.shape), (tasks, id, { stepToken, ...input }) => tasks.assignProjectLines(id, input, stepToken)),
  'submit-project-assignment': taskAction(withToken(ProjectAssignmentInputSchema.shape), (tasks, id, { stepToken, ...input }) => tasks.submitProjectAssignment(id, input, stepToken)),
  'set-home-city': taskAction(withToken(SetHomeCityInputSchema.shape), (tasks, id, { stepToken, homeCity }) => tasks.setHomeCity(id, homeCity, stepToken)),
  // A 待确认项 answer, or a field edit addressed `edit.<materialId>.<field>` with the answer `{ value }`.
  'answer-pending': taskAction(withToken({ itemId: z.string().min(1), answer: PendingAnswerSchema }), (tasks, id, { itemId, answer, stepToken }) => tasks.answerPending(id, itemId, answer, stepToken)),
  'exclude-material': taskAction(withToken({ materialId: z.string().min(1) }), (tasks, id, { materialId, stepToken }) => tasks.excludeMaterial(id, materialId, stepToken)),
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// Same-origin static serving of the built frontend. Routing is hash-based, so `/` is the only page.
function serveWebFile(c: Context, webDist: string): Response | Promise<Response> {
  const root = resolve(webDist);
  const relative = decodeURIComponent(c.req.path === '/' ? '/index.html' : c.req.path);
  const file = resolve(join(root, relative));
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) return c.notFound();
  return c.body(readFileSync(file), 200, { 'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' });
}
