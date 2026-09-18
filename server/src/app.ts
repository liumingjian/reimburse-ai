import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { ADMIN_ERRORS, AssignProjectLinesInputSchema, CreateTaskInputSchema, CropInputSchema, PlacementSlotSchema, FORBIDDEN_CODE, ERP_IN_USE_CODE, PendingAnswerSchema, ProjectAssignmentInputSchema, ProjectBookIntakeInputSchema, SetHomeCityInputSchema, SNAPSHOT_EVENT, STALE_STEP_CODE, STALE_STEP_HTTP_STATUS, STALE_STEP_NOTICE, UPLOAD_MAX_FILE_BYTES, UPLOAD_REJECT_MESSAGES, type ProjectBookResult, type TaskSnapshot } from '@baox/contract';
import { z } from 'zod';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { AuthRefusal, createAccountService, type Clock } from './accounts/accounts';
import { getCookie } from 'hono/cookie';
import { accountOf, mountAccountRoutes, mountAuthRoutes, requireAccount, SESSION_COOKIE, type AppEnv } from './accounts/http';
import type { Db } from './db/database';
import { createInMemoryErpLease, type ErpLease } from './erp-lease';
import { DEFAULT_ERP_CONFIG, type ErpConfig } from './erp/config';
import { createFillJobs, unavailableExecutor, type FillExecutor, type RecordFacts } from './erp/fill-jobs';
import type { ReconcileExecutor } from './erp/reconcile-job';
import { createReconcileJobs, unavailableReconcileExecutor } from './erp/reconcile-jobs';
import { recoverErpJobs } from './erp/recovery';
import { workerExecutor, type ParseExecutor } from './parse/executor';
import { createParseJobs, type ParseJobs } from './parse/jobs';
import { createBookService, type BookService } from './books';
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
  // The global ERP control lease (ADR-0016): the fill job holds it while it runs. Tests pass theirs to observe it.
  erpLease?: ErpLease;
  // Where 去报销 jobs run: `cdpFillExecutor` on the dedicated Chromium in production, a fake in tests. Without one,
  // every job stops before touching anything.
  erpExecutor?: FillExecutor;
  // Where the read-only 对账 (reconcile) jobs run: `cdpReconcileExecutor` in production, a fake in tests. Without one,
  // every reconcile stops at once with nothing read.
  reconcileExecutor?: ReconcileExecutor;
  // The ERP to write to and the build it may write to (`erp/config.ts`).
  erpConfig?: ErpConfig;
  // Where the parser job parses; the server's one worker_thread by default. Tests inject inline or gated executors.
  parser?: ParseExecutor;
  // Kept as the test seam for ERP pre-import validation. Local project-book intake no longer queries this catalog.
  projectCatalog?: ProjectCatalog;
  // The legacy `~/.baox` read once when the first admin is created (ADR-0018). null (default) imports nothing;
  // `main.ts` passes `$BAOX_HOME` or `~/.baox`.
  legacyHome?: string | null;
};

// `close` stops the background jobs (after the material in flight) and releases the parse worker; call it before
// closing the database.
export type App = Hono<AppEnv> & { close: () => Promise<void> };

type SnapshotListener = (snapshot: TaskSnapshot) => void;

const failure = (c: Context, status: 400 | 401 | 403 | 404 | 409, code: string, message: string) => c.json({ error: { code, message } }, status);

export function createApp({ db, dataDir, webDist = null, now = () => new Date(), erpLease = createInMemoryErpLease(), erpExecutor = unavailableExecutor, reconcileExecutor = unavailableReconcileExecutor, erpConfig = DEFAULT_ERP_CONFIG, parser, projectCatalog = unavailableCatalog(), legacyHome = null }: AppOptions): App {
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
  // The 去报销 jobs write their facts through the owner's task service (one revision per executor event).
  const record: RecordFacts = (accountId, taskId, write) => serviceFor(accountId).erpRecord(taskId, write);
  const fillJobs = createFillJobs({ db, lease: erpLease, execute: erpExecutor, record });
  const reconcileJobs = createReconcileJobs({ db, lease: erpLease, execute: reconcileExecutor, record });
  // Every task service is scoped to one account; the parser job gets the owner's service for each task it drives.
  const serviceFor = (accountId: string) =>
    createTaskService(db, dataDir, accountId, { onChange: (snapshot) => publish(snapshot, accountId), erp: { lease: erpLease, config: erpConfig, run: (job) => fillJobs.run(job), reconcile: (job) => reconcileJobs.run(job) } });
  // A restart ends every ERP job the old process ran: each gets its result before any request is served (a fill with
  // a durable attempt -> reconcile; never a replay). Until this succeeds those jobs still read as `running`, so every
  // mutation of their tasks would get 409 for ever: a failure is retried on the next request and, if it fails again,
  // answered as an error rather than served on top of stuck jobs.
  let recovery: Promise<unknown> | null = recoverErpJobs(db, record);
  // The middleware reports the failure; this only keeps node from seeing an unhandled rejection.
  recovery.catch(() => undefined);
  const settled = () => (recovery ?? Promise.resolve()).catch(() => undefined);
  async function ensureRecovered(): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      recovery ??= recoverErpJobs(db, record);
      try {
        await recovery;
        return null;
      } catch (error) {
        console.error('ERP job recovery failed', error);
        // Dropped so the next attempt runs it again; it only ever closes jobs that still have no result.
        recovery = null;
        if (attempt === 1) return error;
      }
    }
    return null;
  }
  const tasksOf = (c: Context<AppEnv>) => serviceFor(accountOf(c).accountId);
  const parseJobs = createParseJobs(serviceFor, () => parseBacklogOfAllAccounts(db, dataDir), parser ?? workerExecutor());
  jobs = parseJobs;
  // A restart mid-job picks up every account's backlog again: what is left is derived from the facts.
  parseJobs.resumeAll();

  const app = new Hono<AppEnv>();

  // An 上传批次 may carry several files; one 支付截图 is a single image. Both leave room for multipart framing.
  const tooLarge = (c: Context) => failure(c, 400, 'too_large', UPLOAD_REJECT_MESSAGES.too_large);
  const batchLimit = bodyLimit({ maxSize: UPLOAD_MAX_FILE_BYTES * UPLOAD_BATCH_MAX_FILES, onError: tooLarge });
  const screenshotLimit = bodyLimit({ maxSize: UPLOAD_MAX_FILE_BYTES * 2, onError: tooLarge });

  // Only this machine may talk to the app (story 82). Binding to 127.0.0.1 is not enough on its own: a page on the
  // attacker's domain can point that domain at 127.0.0.1 (DNS rebinding) and then drive these routes from the
  // victim's browser, cookies attached, reaching /api/auth/setup on a fresh install or register at any time. The
  // rebound request still carries the attacker's name in Host, and a cross-origin write still carries its Origin.
  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    if (!isLocalHost(host)) return c.json({ error: { code: FORBIDDEN_HOST_CODE, message: NOT_LOCAL } }, 403);
    const origin = c.req.header('origin');
    // `null` is a sandboxed/opaque origin, never this app's own page.
    if (WRITE_METHODS.has(c.req.method) && origin !== undefined && !isLocalOrigin(origin)) {
      return c.json({ error: { code: FORBIDDEN_HOST_CODE, message: NOT_LOCAL } }, 403);
    }
    await next();
  });

  app.use('/api/*', async (c, next) => {
    if (await ensureRecovered()) return c.json({ error: { code: INTERNAL_CODE, message: RECOVERY_FAILED } }, 500);
    await next();
  });

  app.onError((error, c) => {
    if (error instanceof TaskNotFoundError) return failure(c, 404, 'task_not_found', '没有这个报销任务。');
    if (error instanceof AuthRefusal) return failure(c, error.status, error.code, error.message);
    if (error instanceof LegacyImportRefusal) return failure(c, 400, error.code, error.message);
    if (error instanceof StaleStepError) return c.json({ error: { code: STALE_STEP_CODE, message: STALE_STEP_NOTICE }, snapshot: error.snapshot }, STALE_STEP_HTTP_STATUS);
    if (error instanceof ActionRefusedError) {
      const body = { error: error.error, ...(error.snapshot ? { snapshot: error.snapshot } : {}), ...(error.taskList ? { taskList: error.taskList } : {}) };
      // `erp_in_use` is the one 409 refusal: the web adapter special-cases it; every other task-action 409 is stale_step.
      return c.json(body, error.error.code === 'task_not_found' ? 404 : error.error.code === ERP_IN_USE_CODE ? 409 : 400);
    }
    // Anything unforeseen still answers in the wire format every client parses (contract/src/http.ts), never Hono's
    // plain-text 500.
    console.error('unhandled server error', error);
    return c.json({ error: { code: INTERNAL_CODE, message: INTERNAL_MESSAGE } }, 500);
  });

  // Creating the first admin runs the one-time legacy import into that account (ADR-0018), in the same transaction
  // that creates the account: both land or neither does.
  mountAuthRoutes(app, {
    ...accounts,
    setup: (credentials) => accounts.setup(credentials, (tx, accountId) => legacy.onFirstAdmin(accountId, tx)),
  });
  app.use('/api/*', requireAccount(accounts));
  mountAccountRoutes(app, accounts);

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

  // 个人项目簿 (personal book) belongs to the signed-in account. Every account can read the shared 公共项目簿 (public
  // book); admins alone can add an entry. Intake is offline and a changed book pushes fresh snapshots of open tasks.
  type BookOf = (c: Context<AppEnv>) => BookService;
  const personalBookOf: BookOf = (c) => createBookService(db, { scope: 'personal', ownerAccountId: accountOf(c).accountId }, accountOf(c).accountId, now);
  const publicBookOf: BookOf = (c) => createBookService(db, { scope: 'public' }, accountOf(c).accountId, now);
  const everyOpenTaskChanged = async () => {
    const owners = await db.selectFrom('task').select('account_id').distinct().where('lifecycle', '=', 'open').execute();
    for (const { account_id } of owners) await serviceFor(account_id).bookChanged();
  };
  const CHANGED: ReadonlySet<ProjectBookResult['status']> = new Set(['admitted']);
  const intakeBookAction =
    (bookOf: BookOf, { adminOnly }: { adminOnly: boolean }) =>
    async (c: Context<AppEnv>) => {
      if (adminOnly && accountOf(c).role !== 'admin') return c.json({ error: { code: FORBIDDEN_CODE, message: ADMIN_ERRORS.forbidden }, book: await bookOf(c).view() }, 403);
      const input = ProjectBookIntakeInputSchema.safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ error: { code: 'invalid_input', message: '请求无效。' }, book: await bookOf(c).view() }, 400);
      const result = await bookOf(c).intake(input.data);
      if (CHANGED.has(result.status)) await (adminOnly ? everyOpenTaskChanged() : tasksOf(c).bookChanged());
      return c.json(result);
    };
  const personal = { adminOnly: false };
  app.get('/api/project-book', async (c) => c.json(await personalBookOf(c).view()));
  app.post('/api/project-book/intake', intakeBookAction(personalBookOf, personal));
  const adminOnly = { adminOnly: true };
  app.get('/api/public-project-book', async (c) => c.json(await publicBookOf(c).view()));
  app.post('/api/public-project-book/intake', intakeBookAction(publicBookOf, adminOnly));

  app.get('/api/tasks/:id', async (c) => c.json(await tasksOf(c).snapshot(c.req.param('id'))));

  // The whole multipart body is buffered to judge each file, so it is capped before a byte of it is read: without
  // this an unbounded upload is held in memory first and refused afterwards.
  app.post('/api/tasks/:id/batches', batchLimit, async (c) => {
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

  // 补充支付截图 (multipart `voucherMaterialId`, `file`): print-only, no stepToken.
  app.post('/api/tasks/:id/payment-screenshots', screenshotLimit, async (c) => {
    const body = await c.req.parseBody();
    const file = body['file'];
    const voucherMaterialId = body['voucherMaterialId'];
    if (!(file instanceof File) || typeof voucherMaterialId !== 'string' || voucherMaterialId === '') return failure(c, 400, 'invalid_input', '请求无效。');
    const uploaded: UploadedFile = { fileName: file.name, mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()) };
    return c.json(await tasksOf(c).addPaymentScreenshot(c.req.param('id'), voucherMaterialId, uploaded));
  });

  // A content-addressed file of the task: originals (the corner editor's photo), payment screenshots, the merged print
  // PDF and its page images. Immutable by construction, so the browser may cache it for good.
  app.get('/api/tasks/:id/files/:sha256', async (c) => {
    const sha256 = c.req.param('sha256');
    const found = /^[0-9a-f]{64}$/.test(sha256) ? await tasksOf(c).file(c.req.param('id'), sha256) : null;
    if (!found || !existsSync(found.path)) return failure(c, 404, 'not_found', '没有这个文件。');
    return c.body(readFileSync(found.path), 200, { 'Content-Type': servedType(found.mime), 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': NOSNIFF });
  });

  // The cropped screenshot of ERP's error dialog when the write stopped (`reconcile.capture.screenshotUrl`).
  app.get('/api/tasks/:id/erp-capture', async (c) => {
    const png = await tasksOf(c).erpCapture(c.req.param('id'));
    if (!png) return failure(c, 404, 'not_found', '没有报销系统截图。');
    return new Response(Buffer.from(png), { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': NOSNIFF } });
  });

  app.post('/api/tasks/:id/abandon', async (c) => c.json(await tasksOf(c).voidTask(c.req.param('id'))));

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
    const tasks = tasksOf(c);
    // Another account's task (or none) is a 404 before any stream opens.
    await tasks.snapshot(taskId);
    const token = getCookie(c, SESSION_COOKIE);
    c.header('Cache-Control', 'no-cache');
    return streamSSE(c, async (stream) => {
      let stop!: () => void;
      const finished = new Promise<void>((resolve) => {
        stop = resolve;
      });
      stream.onAbort(stop);
      // Every write goes through one chain, in the order it was queued. The first snapshot is queued *after*
      // subscribing but read inside the chain, so it can only observe state at least as new as the subscription, and
      // a change accepted in between is pushed rather than lost -- without letting that push overtake the first
      // snapshot and walk the page backwards.
      let queue: Promise<void> = Promise.resolve();
      const enqueue = (of: () => TaskSnapshot | Promise<TaskSnapshot>) => {
        queue = queue.then(async () => {
          // A session revoked meanwhile (logout, or an admin deactivating the account) must not keep receiving this
          // account's task: the stream ends and the browser's reconnect meets the gate.
          if (token && !(await accounts.lookup(token))) {
            stop();
            return;
          }
          await stream.writeSSE({ event: SNAPSHOT_EVENT, data: JSON.stringify(await of()) });
        });
        return queue.catch(() => undefined);
      };

      const listener: SnapshotListener = (snapshot) => void enqueue(() => snapshot);
      const set = listeners.get(taskId) ?? new Set();
      set.add(listener);
      listeners.set(taskId, set);
      try {
        await enqueue(() => tasks.snapshot(taskId));
        await finished;
      } finally {
        set.delete(listener);
        // An empty set would otherwise hold its task id in the map for the life of the process.
        if (set.size === 0) listeners.delete(taskId);
      }
    });
  });

  app.all('/api/*', (c) => failure(c, 404, 'not_found', '没有这个接口。'));

  if (webDist) app.get('*', (c) => serveWebFile(c, webDist));

  return Object.assign(app, { close: async () => { await settled(); await parseJobs.close(); await fillJobs.close(); await reconcileJobs.close(); } });
}

// How many max-size files one 上传批次 may hold before the request itself is refused unread.
const UPLOAD_BATCH_MAX_FILES = 20;

// Only the loopback names reach the app; anything else is another host's name pointed at this machine.
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);
const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const FORBIDDEN_HOST_CODE = 'forbidden_host';
const NOT_LOCAL = '这个应用只能从本机访问。';

const hostnameOf = (value: string): string | null => {
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
};
const isLocalHost = (host: string): boolean => {
  const hostname = hostnameOf(host);
  return hostname !== null && LOCAL_HOSTS.has(hostname);
};
const isLocalOrigin = (origin: string): boolean => {
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
};

// Originals are content-addressed and shared between accounts, so what they are served as must never be whatever the
// uploading browser claimed. Only the three kinds uploads accept are served as themselves; anything else downloads as
// bytes, and `nosniff` stops the browser guessing past that.
const SERVED_TYPES: ReadonlySet<string> = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const NOSNIFF = 'nosniff';
const servedType = (mime: string): string => (SERVED_TYPES.has(mime) ? mime : 'application/octet-stream');

// Unforeseen failures: the wire format still holds, so the page shows a message instead of a parse error.
const INTERNAL_CODE = 'internal';
const INTERNAL_MESSAGE = '应用内部出错了。请重试；如果一直这样，请把这次操作告诉维护者。';
const RECOVERY_FAILED = '应用启动时没能收尾上次没跑完的报销系统任务，现在不能安全地继续。请重启应用；如果一直这样，请把这次操作告诉维护者。';

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
  'confirm-review': taskAction(withToken({ digest: z.string().min(1) }), (tasks, id, { digest, stepToken }) => tasks.confirmReview(id, digest, stepToken)),
  'exclude-material': taskAction(withToken({ materialId: z.string().min(1) }), (tasks, id, { materialId, stepToken }) => tasks.excludeMaterial(id, materialId, stepToken)),
  // 去报销 and its login pause. While another task holds the ERP lease: 409 `erp_in_use`, naming no account or task.
  'start-erp-write': taskAction(withToken({}), (tasks, id, { stepToken }) => tasks.startErpWrite(id, stepToken)),
  'confirm-login': taskAction(withToken({}), (tasks, id, { stepToken }) => tasks.confirmLogin(id, stepToken)),
  'cancel-erp-write': taskAction(withToken({}), (tasks, id, { stepToken }) => tasks.cancelErpWrite(id, stepToken)),
  // 去打印 (#190): print settings only, without a stepToken (contract); see `printChange` in tasks.ts.
  'generate-print-sheet': taskAction(z.object({}), (tasks, id) => tasks.generatePrintSheet(id)),
  'rotate-placement': taskAction(z.object({ pageId: z.string().min(1), slot: PlacementSlotSchema, rotate: z.boolean() }), (tasks, id, { pageId, slot, rotate }) => tasks.rotatePlacement(id, pageId, slot, rotate)),
  'crop-placement': taskAction(CropInputSchema, (tasks, id, { pageId, slot, corners }) => tasks.cropPlacement(id, pageId, slot, corners)),
  'remove-payment-screenshot': taskAction(z.object({ screenshotId: z.string().min(1) }), (tasks, id, { screenshotId }) => tasks.removePaymentScreenshot(id, screenshotId)),
  // 对账 (read-only, 409 `erp_in_use` while another task holds the lease) and 转人工 (terminal).
  reconcile: taskAction(withToken({}), (tasks, id, { stepToken }) => tasks.reconcile(id, stepToken)),
  'hand-off': taskAction(withToken({}), (tasks, id, { stepToken }) => tasks.handOff(id, stepToken)),
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
  let relative: string;
  try {
    relative = decodeURIComponent(c.req.path === '/' ? '/index.html' : c.req.path);
  } catch {
    // A malformed percent-escape is simply not a file we have, not a server fault.
    return c.notFound();
  }
  const file = resolve(join(root, relative));
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) return c.notFound();
  return c.body(readFileSync(file), 200, { 'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options': NOSNIFF });
}
