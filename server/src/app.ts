import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { ADMIN_ERRORS, AssignProjectLinesInputSchema, ConfirmReviewInputSchema, CreateTaskInputSchema, CropInputSchema, PlacementSlotSchema, EXTENSION_BLOB_PATH, EXTENSION_PAIR_PATH, EXTENSION_PAIRING_ERRORS, FORBIDDEN_CODE, ERP_ACTION_ERRORS, ERP_CREDENTIAL_ERRORS, ERP_CREDENTIALS_MISSING_CODE, ERP_IN_USE_CODE, PendingAnswerSchema, ProjectAssignmentInputSchema, ProjectBookEditInputSchema, ProjectBookIntakeInputSchema, ProjectBookLifecycleInputSchema, PublicProjectConversionInputSchema, SetHomeCityInputSchema, SNAPSHOT_EVENT, STALE_STEP_CODE, STALE_STEP_HTTP_STATUS, STALE_STEP_NOTICE, UPLOAD_MAX_FILE_BYTES, UPLOAD_REJECT_MESSAGES, type ProjectBookResult, type TaskSnapshot } from '@baox/contract';
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
import { createFillJobs, type FillExecutor, type RecordFacts } from './erp/fill-jobs';
import type { ReconcileExecutor } from './erp/reconcile-job';
import { createReconcileJobs } from './erp/reconcile-jobs';
import { createCredentialVault } from './erp/credential-vault';
import { createErpCredentialService, erpCredentialsReady } from './erp/hosted-sign-in';
import { mountErpCredentialRoutes } from './erp/hosted-sign-in-http';
import { createRemoteExecutor } from './erp/remote-executor';
import { hasUnfinishedErpJobs, recoverErpJobs } from './erp/recovery';
import { workerExecutor, type ParseExecutor } from './parse/executor';
import { createParseJobs, type ParseJobs } from './parse/jobs';
import { createBookService, type BookService } from './books';
import { createExtensionChannel, EXTENSION_NOT_PAIRED_CODE, EXTENSION_OFFLINE_CODE, realTimer, type ExtensionChannel, type Schedule } from './extension/channel';
import { mountExtensionDownloadRoute } from './extension/download';
import { mountLocalExecutorDownloadRoute, mountLocalExecutorReleaseRoutes } from './local-executor/http';
import type { LocalExecutorDist } from './local-executor/package';
import { bearer, mountExtensionPairRoutes, mountPairingRoutes } from './extension/http';
import { createPairingService, hasPairing } from './extension/pairing';
import { createLegacyImport, LegacyImportRefusal } from './legacy/import';
import { unavailableCatalog, type ProjectCatalog } from './catalog/project-catalog';
import { admitsHost, admitsOrigin, type PublicOrigin } from './public-origin';
import { createMaintenanceGate, MAINTENANCE_WRITE_CODE, MAINTENANCE_WRITE_MESSAGE, type MaintenanceGate } from './maintenance';
import { RECEIPT_INVOICE_NO } from '@baox/erp-executor/occupancy';
import { ActionRefusedError, createTaskService, parseBacklogOfAllAccounts, StaleStepError, TaskNotFoundError, type ErpServiceOptions, type TaskService, type UploadedFile } from './tasks';

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
  // The ERP control lease, one partition per 应用账号 (ADR-0016, ADR-0019): the fill job holds its account's while
  // it runs. Tests pass theirs to observe it.
  erpLease?: ErpLease;
  // Where 去报销 jobs run. Without one (production), in the task owner's paired 浏览器扩展 over its channel
  // (`erp/remote-executor.ts`); `cdpFillExecutor` on the dedicated Chromium only from the development and e2e entries
  // and `pnpm test:erp-live`; a fake in tests.
  erpExecutor?: FillExecutor;
  // Where the read-only 对账 (reconcile) jobs run, chosen the same way as `erpExecutor`.
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
  // The address colleagues reach the app at (`public-origin.ts`). null (default) admits only 127.0.0.1.
  publicOrigin?: PublicOrigin | null;
  // The built extension template (`extension/dist`) the settings page's download is assembled from
  // (`extension/download.ts`). null (default) answers every download with 503.
  extensionTemplate?: string | null;
  // The built 本地执行器 program and the Node runtimes fetched at deploy (`local-executor/package.ts`, ADR-0035). null
  // (default) answers its downloads and its executors' update checks with 503.
  localExecutor?: LocalExecutorDist | null;
  // The extension channel's timers: its hello deadline and a job's reconnection window (ADR-0020). Tests fire them by
  // hand.
  schedule?: Schedule;
  // The key the hosted ERP 凭据 are sealed with (`erp/credential-vault.ts`). null (default) disables them: nothing can
  // be saved, and no 本地执行器 is sent any.
  erpCredentialKey?: Buffer | null;
  // 自动重新去报销 (ADR-0034). On while the executor knows how to ask ERP whether a bill holds an invoice
  // (`erp-executor/src/occupancy.ts`): without that every re-run would sign in again only to stop before uploading.
  autoRerun?: boolean;
};

// `close` stops the background jobs (after the material in flight) and releases the parse worker; call it before
// closing the database. `extensionChannel` is what `server.ts` hands an upgraded socket to; the app itself never
// opens one.
export type App = Hono<AppEnv> & { close: () => Promise<void>; extensionChannel: ExtensionChannel; maintenance: MaintenanceGate; ready: Promise<void> };

type SnapshotListener = (snapshot: TaskSnapshot) => void;

const failure = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 503, code: string, message: string) => c.json({ error: { code, message } }, status);

export function createApp({ db, dataDir, webDist = null, now = () => new Date(), erpLease = createInMemoryErpLease(), erpExecutor, reconcileExecutor, erpConfig = DEFAULT_ERP_CONFIG, parser, projectCatalog = unavailableCatalog(), legacyHome = null, publicOrigin = null, extensionTemplate = null, localExecutor = null, schedule = realTimer, erpCredentialKey = null, autoRerun = RECEIPT_INVOICE_NO !== null }: AppOptions): App {
  const maintenance = createMaintenanceGate(db);
  // Session lookups usually write a sliding expiry or remove an expired row. Give those narrow housekeeping writes
  // their own admission so a read route cannot cross an admitted maintenance boundary.
  const accounts = createAccountService(db, now, () => maintenance.enter('background'));
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
  // The extension's executor answers through the channel built further down, so it reaches the channel through the
  // binding rather than the value.
  const remote = createRemoteExecutor({
    db, schedule,
    extension: { request: (accountId, method, payload) => extensionChannel.request(accountId, method, payload) },
    credentials: { forJob: (accountId) => erpCredentials.forJob(accountId), refusedInJob: (accountId, used, message) => erpCredentials.refusedInJob(accountId, used, message) },
  });
  // ERP 凭据 (ADR-0033) for a baox 本地执行器: the 试登录 goes to the account's executor over the same channel, and is
  // held back while a job of the account drives ERP, whose session it would knock off.
  const erpCredentials = createErpCredentialService({
    db, clock: now, vault: erpCredentialKey ? createCredentialVault(erpCredentialKey) : null, erpOrigin: erpConfig.origin,
    request: (accountId, method, payload) => extensionChannel.request(accountId, method, payload),
    erpBusy: (accountId) => erpLease.holder(accountId) !== null,
    acquireWrite: () => maintenance.enter('background'),
  });
  // A settled 去报销 may start an 自动重新去报销 (ADR-0034); the owner's task service decides.
  const fillJobs = createFillJobs({ db, lease: erpLease, execute: erpExecutor ?? remote.fill, record, schedule, onSettled: (run, outcome) => serviceFor(run.accountId).autoRerun(run.taskId, run.jobId, outcome) });
  const reconcileJobs = createReconcileJobs({ db, lease: erpLease, execute: reconcileExecutor ?? remote.reconcile, record, schedule });
  // Story 13: a 去报销 bound for the owner's 浏览器扩展 is refused before any job exists when there is no extension to
  // run it, saying which is missing. An injected executor (development, e2e, tests) needs no extension. The in-job
  // `extension_offline` abort stays as the backstop for a socket lost between this check and the dispatch.
  // A baox 本地执行器 signs in itself, so it also needs authorised ERP 凭据 before anything starts.
  const extensionReady = async (tx: Db, accountId: string) => {
    if (extensionChannel.connected(accountId)) return (await erpCredentialsReady(tx, accountId, !!erpCredentialKey)) ? null : { code: ERP_CREDENTIALS_MISSING_CODE, message: ERP_CREDENTIAL_ERRORS.missing };
    return (await hasPairing(tx, accountId))
      ? { code: EXTENSION_OFFLINE_CODE, message: ERP_ACTION_ERRORS.extensionOffline }
      : { code: EXTENSION_NOT_PAIRED_CODE, message: ERP_ACTION_ERRORS.extensionNotPaired };
  };
  const erpService: ErpServiceOptions = {
    lease: erpLease,
    config: erpConfig,
    run: (job) => fillJobs.run(job),
    reconcile: (job) => reconcileJobs.run(job),
    acquireErp: () => maintenance.enter('erp'),
    acquireBackground: () => maintenance.enter('background'),
    ...(erpExecutor ? {} : { executorReady: extensionReady }),
    // The same test that decides whether a job is sent 凭据 (and 暂存s): only then is the executor a 本地执行器.
    unattended: async (accountId) => autoRerun && (await erpCredentials.forJob(accountId)) !== null,
  };
  // Every task service is scoped to one account; the parser job gets the owner's service for each task it drives.
  const serviceFor = (accountId: string) =>
    createTaskService(db, dataDir, accountId, { onChange: (snapshot) => publish(snapshot, accountId), erp: erpService });
  // A restart ends every ERP job the old process ran: each gets its result before any request is served (a fill with
  // a durable attempt -> reconcile; never a replay). Recovery itself is a background write and therefore runs only
  // while the durable barrier is open. A closed barrier with unfinished jobs becomes durable `unknown`, rather than
  // silently settling work during a maintenance window.
  let recovery: Promise<void> | null = null;
  let recoveryError: unknown = null;
  const settled = () => (recovery ?? Promise.resolve()).catch(() => undefined);

  async function recoverWhileOpen(): Promise<void> {
    const admission = maintenance.enter('background');
    if (!admission) throw new Error('ERP job recovery is blocked by the maintenance barrier');
    try {
      await recoverErpJobs(db, record);
    } finally {
      admission.release();
    }
  }

  async function ensureRecovered(): Promise<unknown> {
    if (!recovery) return recoveryError;
    try {
      await recovery;
      return recoveryError;
    } catch (error) {
      return recoveryError ?? error;
    }
  }
  const tasksOf = (c: Context<AppEnv>) => serviceFor(accountOf(c).accountId);
  const parseJobs = createParseJobs(serviceFor, () => parseBacklogOfAllAccounts(db, dataDir), parser ?? workerExecutor(), () => maintenance.enter('background'));
  jobs = parseJobs;
  maintenance.onOpen(() => parseJobs.resumeAll());
  // Startup recovery runs before the server accepts requests. A failed recovery leaves the durable gate unusable
  // instead of letting a later request decide that uncertain ERP state is safe.
  const ready = (async () => {
    await maintenance.ready;
    if (maintenance.status().state !== 'open') {
      // A clean admitted barrier is allowed to restart for inspection, but it never resumes parser or ERP work. A
      // crashed job under that barrier cannot be settled without breaking the window, so make reopening fail closed.
      if (maintenance.status().state === 'admitted' && (await hasUnfinishedErpJobs(db))) {
        recoveryError = new Error('ERP job recovery is blocked by an admitted maintenance barrier');
        console.error('ERP job recovery failed', recoveryError);
        await maintenance.failClosed();
      }
      return;
    }
    recovery = recoverWhileOpen();
    try {
      await recovery;
    } catch (error) {
      recoveryError = error;
      console.error('ERP job recovery failed', error);
      await maintenance.failClosed();
      return;
    }
    // A restart mid-job picks up every account's parser backlog after the ERP recovery boundary is known.
    parseJobs.resumeAll();
  })();

  const app = new Hono<AppEnv>();

  // An 上传批次 may carry several files; one 支付截图 is a single image. Both leave room for multipart framing.
  const tooLarge = (c: Context) => failure(c, 400, 'too_large', UPLOAD_REJECT_MESSAGES.too_large);
  const batchLimit = bodyLimit({ maxSize: UPLOAD_MAX_FILE_BYTES * UPLOAD_BATCH_MAX_FILES, onError: tooLarge });

  // Only the address the app is served at may talk to it (story 82). Neither binding to 127.0.0.1 nor sitting on the
  // company VPN is enough on its own: a page on the attacker's domain can point that domain at this app's address
  // (DNS rebinding) and then drive these routes from the victim's browser, cookies attached, reaching
  // /api/auth/setup on a fresh install or register at any time. The rebound request still carries the attacker's name
  // in Host, and a cross-origin write still carries its Origin. A configured `publicOrigin` turns both checks from
  // "loopback" into "exactly this origin": the reverse proxy in front of Node passes the browser's own Host and
  // Origin through, so the app judges what the browser actually wrote.
  // The Host predicate is shared with the WebSocket upgrade (`extension/websocket.ts`), which never reaches this
  // middleware; both live in `public-origin.ts` so the two doors cannot drift apart.
  const forbidden = (c: Context) => failure(c, 403, FORBIDDEN_HOST_CODE, publicOrigin ? NOT_THIS_ADDRESS : NOT_LOCAL);
  // Redeeming a 配对码, and the extension revoking its own pairing, are the writes that do not come from this app's
  // page: the extension sends them from its own `chrome-extension://…` origin (ADR-0019), which the exact-origin check
  // could never admit. That path is exempt because the origin check is a defence for cookie-authorised writes, and
  // it reads no cookie — the single-use 配对码 in the body, or the pairing token in `Authorization`, is its whole
  // authority, and a page on another origin has no way to know either. The Host check still applies to it, so DNS
  // rebinding gains nothing here either.
  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    if (!admitsHost(publicOrigin, host)) return forbidden(c);
    const origin = c.req.header('origin');
    // `null` is a sandboxed/opaque origin, never this app's own page.
    if (WRITE_METHODS.has(c.req.method) && origin !== undefined && c.req.path !== EXTENSION_PAIR_PATH && !admitsOrigin(publicOrigin, origin)) return forbidden(c);
    // This also holds GET routes until recovery has either completed or made the gate fail closed. Some reads have
    // narrowly admitted housekeeping writes (session and pairing liveness), so they cannot begin while startup work
    // is still deciding the durable boundary.
    await ready;
    if (!WRITE_METHODS.has(c.req.method)) return next();
    const admission = maintenance.enter('http');
    if (!admission) return failure(c, 503, MAINTENANCE_WRITE_CODE, MAINTENANCE_WRITE_MESSAGE);
    try {
      await next();
    } finally {
      admission.release();
    }
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
  const secureSession = publicOrigin?.secure ?? false;
  mountAuthRoutes(
    app,
    {
      ...accounts,
      setup: (credentials) => accounts.setup(credentials, (tx, accountId) => legacy.onFirstAdmin(accountId, tx)),
    },
    secureSession,
  );
  // 扩展配对 (ADR-0019): the extension's own two routes carry no session and are mounted before the gate, because a
  // pairing outlives every login. The settings page's routes sit behind it like everything else.
  //
  // The pairing view reports whether that account's extension is connected, which only the live channel knows, and
  // the channel resolves tokens through the pairing service: each needs the other, so the pairing service reaches
  // the channel through the binding rather than the value. It also closes the channel's socket when a pairing goes.
  const pairings = createPairingService(
    db,
    now,
    { connected: (accountId) => extensionChannel.connected(accountId), disconnect: (accountId) => extensionChannel.disconnect(accountId) },
    () => maintenance.enter('background'),
  );
  const extensionChannel = createExtensionChannel({ pairings, now, schedule, onRequest: remote.answer, onLost: remote.lost });
  mountExtensionPairRoutes(app, pairings);
  mountLocalExecutorReleaseRoutes(app, localExecutor, pairings);
  // The invoice originals of the 去报销 running in the paired extension (#256, ADR-0022), before the gate for the same
  // reason: the extension's token is its only credential. Three answers read alike, so nothing can be learnt by
  // probing: no running job, a sha256 its plan does not name, and another account's original. The task service is
  // the token's account's, so the owner check every read path carries is made here too, on top of the plan's.
  app.get(`${EXTENSION_BLOB_PATH}/:sha256`, async (c) => {
    const paired = await pairings.lookup(bearer(c));
    if (!paired) return failure(c, 401, 'not_paired', EXTENSION_PAIRING_ERRORS.notPaired);
    const sha256 = c.req.param('sha256');
    const job = remote.runningOriginal(paired.accountId, sha256);
    const found = job ? await serviceFor(paired.accountId).file(job.taskId, sha256) : null;
    if (!found || !existsSync(found.path)) return failure(c, 404, 'not_found', '没有这个文件。');
    return c.body(readFileSync(found.path), 200, { 'Content-Type': servedType(found.mime), 'Cache-Control': 'no-store', 'X-Content-Type-Options': NOSNIFF });
  });
  app.use('/api/*', requireAccount(accounts, secureSession));
  // A deactivated account loses its extension the way it loses its sessions: its token stops resolving (`lookup`),
  // and its open socket closes now rather than at the next `hello`.
  mountAccountRoutes(app, {
    ...accounts,
    update: async (actor, accountId, change) => {
      const list = await accounts.update(actor, accountId, change);
      if ('active' in change && !change.active) extensionChannel.disconnect(accountId);
      return list;
    },
  });
  mountPairingRoutes(app, pairings, publicOrigin);
  mountErpCredentialRoutes(app, erpCredentials);
  mountExtensionDownloadRoute(app, extensionTemplate, publicOrigin);
  mountLocalExecutorDownloadRoute(app, localExecutor, join(dataDir, 'cache', 'local-executor'), publicOrigin);

  // Legacy import (旧数据导入) as the signed-in account sees it; only the owner of a failed run may retry or skip.
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

  // Reset (完全重置), per account: voids the signed-in account's own tasks; other accounts, accounts themselves and
  // sessions are untouched. Answers the new task list.
  app.post('/api/reset', async (c) => c.json(await tasksOf(c).resetAll()));

  // The personal project book (个人项目簿) belongs to the signed-in account. Every account can read the shared public
  // project book (公共项目簿); admins alone can add an entry. Intake is offline and a changed book pushes fresh
  // snapshots of open tasks.
  type BookOf = (c: Context<AppEnv>) => BookService;
  const personalBookOf: BookOf = (c) => createBookService(db, { scope: 'personal', ownerAccountId: accountOf(c).accountId }, accountOf(c).accountId, now);
  const publicBookOf: BookOf = (c) => createBookService(db, { scope: 'public' }, accountOf(c).accountId, now);
  const everyOpenTaskChanged = async () => {
    const owners = await db.selectFrom('task').select('account_id').distinct().where('lifecycle', '=', 'open').execute();
    for (const { account_id } of owners) await serviceFor(account_id).bookChanged();
  };
  const CHANGED: ReadonlySet<ProjectBookResult['status']> = new Set(['admitted', 'edited', 'deactivated', 'restored', 'deleted', 'converted']);
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
  const lifecycleBookAction =
    (bookOf: BookOf, { adminOnly }: { adminOnly: boolean }, action: 'deactivate' | 'restore' | 'delete') =>
    async (c: Context<AppEnv>) => {
      if (adminOnly && accountOf(c).role !== 'admin') return c.json({ error: { code: FORBIDDEN_CODE, message: ADMIN_ERRORS.forbidden }, book: await bookOf(c).view() }, 403);
      const input = ProjectBookLifecycleInputSchema.safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ error: { code: 'invalid_input', message: '请求无效。' }, book: await bookOf(c).view() }, 400);
      const book = bookOf(c);
      const result = action === 'deactivate' ? await book.deactivate(input.data) : action === 'restore' ? await book.restore(input.data) : await book.delete(input.data);
      if (CHANGED.has(result.status)) await (adminOnly ? everyOpenTaskChanged() : tasksOf(c).bookChanged());
      return c.json(result);
    };
  const personal = { adminOnly: false };
  app.get('/api/project-book', async (c) => c.json(await personalBookOf(c).view()));
  app.post('/api/project-book/intake', intakeBookAction(personalBookOf, personal));
  const editBookAction =
    (bookOf: BookOf, { adminOnly }: { adminOnly: boolean }) =>
    async (c: Context<AppEnv>) => {
      if (adminOnly && accountOf(c).role !== 'admin') return c.json({ error: { code: FORBIDDEN_CODE, message: ADMIN_ERRORS.forbidden }, book: await bookOf(c).view() }, 403);
      const input = ProjectBookEditInputSchema.safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ error: { code: 'invalid_input', message: '请求无效。' }, book: await bookOf(c).view() }, 400);
      const result = await bookOf(c).edit(input.data);
      if (CHANGED.has(result.status)) await (adminOnly ? everyOpenTaskChanged() : tasksOf(c).bookChanged());
      return c.json(result);
    };
  const confirmPublicConversion = async (c: Context<AppEnv>) => {
    if (accountOf(c).role !== 'admin') return c.json({ error: { code: FORBIDDEN_CODE, message: ADMIN_ERRORS.forbidden }, book: await publicBookOf(c).view() }, 403);
    const input = PublicProjectConversionInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: { code: 'invalid_input', message: '请求无效。' }, book: await publicBookOf(c).view() }, 400);
    const result = await publicBookOf(c).confirmConversion(input.data);
    if (CHANGED.has(result.status)) await everyOpenTaskChanged();
    return c.json(result);
  };
  const adminOnly = { adminOnly: true };
  app.get('/api/public-project-book', async (c) => c.json(await publicBookOf(c).view()));
  app.post('/api/public-project-book/intake', intakeBookAction(publicBookOf, adminOnly));
  app.post('/api/project-book/edit', editBookAction(personalBookOf, personal));
  app.post('/api/public-project-book/edit', editBookAction(publicBookOf, adminOnly));
  app.post('/api/public-project-book/convert', confirmPublicConversion);
  app.post('/api/project-book/deactivate', lifecycleBookAction(personalBookOf, personal, 'deactivate'));
  app.post('/api/project-book/restore', lifecycleBookAction(personalBookOf, personal, 'restore'));
  app.post('/api/project-book/delete', lifecycleBookAction(personalBookOf, personal, 'delete'));
  app.post('/api/public-project-book/deactivate', lifecycleBookAction(publicBookOf, adminOnly, 'deactivate'));
  app.post('/api/public-project-book/restore', lifecycleBookAction(publicBookOf, adminOnly, 'restore'));
  app.post('/api/public-project-book/delete', lifecycleBookAction(publicBookOf, adminOnly, 'delete'));

  app.get('/api/tasks/:id', async (c) => c.json(await tasksOf(c).snapshot(c.req.param('id'))));

  // The whole multipart body is buffered to judge each file, so it is capped before a byte of it is read: without
  // this an unbounded upload is held in memory first and refused afterwards.
  app.post('/api/tasks/:id/batches', batchLimit, async (c) => {
    const body = await c.req.parseBody({ all: true });
    const entries = ([] as unknown[]).concat(body['files'] ?? []);
    // `webkitRelativePath` is browser-local metadata and is not carried by multipart's filename. The adapter sends
    // one sourcePaths field per file in the same order, preserving nested directory provenance without accepting an
    // absolute path from the client.
    const sourcePaths = ([] as unknown[]).concat(body['sourcePaths'] ?? []).map((path) => (typeof path === 'string' ? path : null));
    const files: UploadedFile[] = [];
    let fileIndex = 0;
    for (const entry of entries) {
      if (!(entry instanceof File)) continue;
      files.push({ fileName: entry.name, relativePath: sourcePaths[fileIndex] ?? entry.name, mime: entry.type || 'application/octet-stream', bytes: new Uint8Array(await entry.arrayBuffer()) });
      fileIndex += 1;
    }
    if (files.length === 0) return failure(c, 400, 'no_files', '没有收到文件。');
    return c.json(await tasksOf(c).upload(c.req.param('id'), files));
  });

  // 支付截图 from a 住宿 invoice's 待确认项 (multipart `voucherMaterialId`, `stepToken`, one `files` per image): a new batch
  // placed with that invoice, and a new inventory run (ADR-0032).
  app.post('/api/tasks/:id/payment-screenshots', batchLimit, async (c) => {
    const body = await c.req.parseBody({ all: true });
    const voucherMaterialId = body['voucherMaterialId'];
    const stepToken = body['stepToken'];
    const files: UploadedFile[] = [];
    for (const entry of ([] as unknown[]).concat(body['files'] ?? [])) {
      if (entry instanceof File) files.push({ fileName: entry.name, mime: entry.type || 'application/octet-stream', bytes: new Uint8Array(await entry.arrayBuffer()) });
    }
    if (files.length === 0 || typeof voucherMaterialId !== 'string' || voucherMaterialId === '' || typeof stepToken !== 'string') return failure(c, 400, 'invalid_input', '请求无效。');
    return c.json(await tasksOf(c).addPaymentScreenshots(c.req.param('id'), voucherMaterialId, files, stepToken));
  });

  app.post('/api/tasks/:id/dining-evidence', batchLimit, async (c) => {
    const body = await c.req.parseBody({ all: true });
    const pendingItemId = body['pendingItemId'];
    const stepToken = body['stepToken'];
    const files: UploadedFile[] = [];
    for (const entry of ([] as unknown[]).concat(body['files'] ?? [])) {
      if (entry instanceof File) files.push({ fileName: entry.name, mime: entry.type || 'application/octet-stream', bytes: new Uint8Array(await entry.arrayBuffer()) });
    }
    if (files.length === 0 || typeof pendingItemId !== 'string' || pendingItemId === '' || typeof stepToken !== 'string') return failure(c, 400, 'invalid_input', '请求无效。');
    return c.json(await tasksOf(c).supplementDiningEvidence(c.req.param('id'), pendingItemId, files, stepToken));
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

  return Object.assign(app, {
    extensionChannel,
    maintenance,
    ready,
    close: async () => {
      extensionChannel.close();
      await settled();
      await parseJobs.close();
      await fillJobs.close();
      await reconcileJobs.close();
    },
  });
}

// How many max-size files one 上传批次 may hold before the request itself is refused unread.
const UPLOAD_BATCH_MAX_FILES = 20;

const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const FORBIDDEN_HOST_CODE = 'forbidden_host';
const NOT_LOCAL = '这个应用只能从本机访问。';
const NOT_THIS_ADDRESS = '这个应用只能从管理员配置的地址访问。';

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
  'confirm-review': taskAction(withToken(ConfirmReviewInputSchema.shape), (tasks, id, { digest, acceptDeadlineWarnings, stepToken }) => tasks.confirmReview(id, digest, stepToken, acceptDeadlineWarnings)),
  'exclude-material': taskAction(withToken({ materialId: z.string().min(1) }), (tasks, id, { materialId, stepToken }) => tasks.excludeMaterial(id, materialId, stepToken)),
  // 去报销 and its login pause. While another task of the same 应用账号 holds the ERP lease: 409 `erp_in_use`, naming
  // no task. Another account's job never refuses this one (ADR-0019).
  'start-erp-write': taskAction(withToken({}), (tasks, id, { stepToken }) => tasks.startErpWrite(id, stepToken)),
  'confirm-login': taskAction(withToken({}), (tasks, id, { stepToken }) => tasks.confirmLogin(id, stepToken)),
  'cancel-erp-write': taskAction(withToken({}), (tasks, id, { stepToken }) => tasks.cancelErpWrite(id, stepToken)),
  // 去打印 (#190): print settings only, without a stepToken (contract); see `printChange` in tasks.ts.
  'generate-print-sheet': taskAction(z.object({}), (tasks, id) => tasks.generatePrintSheet(id)),
  'rotate-placement': taskAction(z.object({ pageId: z.string().min(1), slot: PlacementSlotSchema, rotate: z.boolean() }), (tasks, id, { pageId, slot, rotate }) => tasks.rotatePlacement(id, pageId, slot, rotate)),
  'crop-placement': taskAction(CropInputSchema, (tasks, id, { pageId, slot, corners }) => tasks.cropPlacement(id, pageId, slot, corners)),
  'remove-payment-screenshot': taskAction(z.object({ screenshotId: z.string().min(1) }), (tasks, id, { screenshotId }) => tasks.removePaymentScreenshot(id, screenshotId)),
  // 「已传齐」 (#331): the 住宿 invoice's 支付截图 group is complete.
  'complete-payment-screenshots': taskAction(z.object({ voucherMaterialId: z.string().min(1) }), (tasks, id, { voucherMaterialId }) => tasks.completePaymentScreenshots(id, voucherMaterialId)),
  // 对账 (read-only, 409 `erp_in_use` while another task of the same 应用账号 holds the lease) and 转人工 (terminal).
  reconcile: taskAction(withToken({}), (tasks, id, { stepToken }) => tasks.reconcile(id, stepToken)),
  'hand-off': taskAction(withToken({}), (tasks, id, { stepToken }) => tasks.handOff(id, stepToken)),
  // 重新去报销 (ADR-0027): a new fill job on the same task, offered only by the 对账 verdict that allows it.
  refill: taskAction(withToken({}), (tasks, id, { stepToken }) => tasks.refill(id, stepToken)),
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
