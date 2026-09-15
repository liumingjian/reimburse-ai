import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { CreateTaskInputSchema, SNAPSHOT_EVENT, STALE_STEP_CODE, STALE_STEP_HTTP_STATUS, STALE_STEP_NOTICE, type TaskSnapshot } from '@baox/contract';
import { z } from 'zod';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Db } from './db/database';
import { workerExecutor, type ParseExecutor } from './parse/executor';
import { createParseJobs, type ParseJobs } from './parse/jobs';
import { ActionRefusedError, createTaskService, StaleStepError, TaskNotFoundError, type TaskService, type UploadedFile } from './tasks';

// The HTTP app. Wire rules (contract/src/http.ts): success is 200 with the whole new snapshot; failure is
// `{ error: { code, message } }`; a stale stepToken is 409 `{ error, snapshot }` with the fresh snapshot; SSE pushes
// whole snapshots as `event: snapshot`. The task service publishes every accepted change, so routes never do.
// Tests drive it through `app.request()`; `startServer` puts it on 127.0.0.1.

export type AppOptions = {
  db: Db;
  dataDir: string;
  // The built frontend (`web/dist`), served same-origin in production. Absent in tests and under `pnpm dev`.
  webDist?: string | null;
  // Where the parser job parses; the server's one worker_thread by default. Tests inject inline or gated executors.
  parser?: ParseExecutor;
};

// `close` stops the background jobs (after the material in flight) and releases the parse worker; call it before
// closing the database.
export type App = Hono & { close: () => Promise<void> };

type SnapshotListener = (snapshot: TaskSnapshot) => void;

const failure = (c: Context, status: 400 | 404, code: string, message: string) => c.json({ error: { code, message } }, status);

export function createApp({ db, dataDir, webDist = null, parser }: AppOptions): App {
  const listeners = new Map<string, Set<SnapshotListener>>();
  let jobs: ParseJobs | null = null;
  const publish = (snapshot: TaskSnapshot) => {
    for (const listener of listeners.get(snapshot.task.taskId) ?? []) listener(snapshot);
    // A run with materials still waiting (just started, or mid-way) needs its parser job.
    if (snapshot.inventory.status === 'running') jobs?.ensure(snapshot.task.taskId);
  };
  const tasks = createTaskService(db, dataDir, { onChange: publish });
  const parseJobs = createParseJobs(tasks, parser ?? workerExecutor());
  jobs = parseJobs;
  // A restart mid-job picks the backlog up again: what is left is derived from the facts.
  parseJobs.resumeAll();

  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof TaskNotFoundError) return failure(c, 404, 'task_not_found', '没有这个报销任务。');
    if (error instanceof StaleStepError) return c.json({ error: { code: STALE_STEP_CODE, message: STALE_STEP_NOTICE }, snapshot: error.snapshot }, STALE_STEP_HTTP_STATUS);
    if (error instanceof ActionRefusedError) {
      const body = { error: error.error, ...(error.snapshot ? { snapshot: error.snapshot } : {}), ...(error.taskList ? { taskList: error.taskList } : {}) };
      return c.json(body, error.error.code === 'task_not_found' ? 404 : 400);
    }
    throw error;
  });

  app.get('/api/tasks', async (c) => c.json(await tasks.list()));

  app.post('/api/tasks', async (c) => {
    const input = CreateTaskInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return failure(c, 400, 'invalid_input', input.error.issues[0]?.message ?? '请求无效。');
    return c.json(await tasks.create(input.data.homeCity));
  });

  app.get('/api/tasks/:id', async (c) => c.json(await tasks.snapshot(c.req.param('id'))));

  app.post('/api/tasks/:id/batches', async (c) => {
    const body = await c.req.parseBody({ all: true });
    const entries = ([] as unknown[]).concat(body['files'] ?? []);
    const files: UploadedFile[] = [];
    for (const entry of entries) {
      if (!(entry instanceof File)) continue;
      files.push({ fileName: entry.name, mime: entry.type || 'application/octet-stream', bytes: new Uint8Array(await entry.arrayBuffer()) });
    }
    if (files.length === 0) return failure(c, 400, 'no_files', '没有收到文件。');
    return c.json(await tasks.upload(c.req.param('id'), files));
  });

  app.post('/api/tasks/:id/abandon', async (c) => c.json(await tasks.voidTask(c.req.param('id'))));

  app.post('/api/tasks/:id/actions/:name', async (c) => {
    const action = TASK_ACTIONS[c.req.param('name')];
    if (!action) return failure(c, 404, 'not_found', '没有这个接口。');
    const input = action.input.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return failure(c, 400, 'invalid_input', input.error.issues[0]?.message ?? '请求无效。');
    return c.json(await action.run(tasks, c.req.param('id'), input.data));
  });

  // SSE: the current snapshot on connect, then every new one. Nothing buffers it (the Vite proxy passes it through).
  app.get('/api/tasks/:id/events', async (c) => {
    const taskId = c.req.param('id');
    const first = await tasks.snapshot(taskId);
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
