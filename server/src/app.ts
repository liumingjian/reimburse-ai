import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { CreateTaskInputSchema, SNAPSHOT_EVENT, type TaskSnapshot } from '@baox/contract';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Db } from './db/database';
import { createTaskService, TaskNotFoundError, type UploadedFile } from './tasks';

// The HTTP app. Wire rules (contract/src/http.ts): success is 200 with the whole new snapshot; failure is
// `{ error: { code, message } }`; SSE pushes whole snapshots as `event: snapshot`.
// Tests drive it through `app.request()`; `startServer` puts it on 127.0.0.1.

export type AppOptions = {
  db: Db;
  dataDir: string;
  // The built frontend (`web/dist`), served same-origin in production. Absent in tests and under `pnpm dev`.
  webDist?: string | null;
};

type SnapshotListener = (snapshot: TaskSnapshot) => void;

const failure = (c: Context, status: 400 | 404, code: string, message: string) => c.json({ error: { code, message } }, status);

export function createApp({ db, dataDir, webDist = null }: AppOptions): Hono {
  const tasks = createTaskService(db, dataDir);
  const listeners = new Map<string, Set<SnapshotListener>>();
  const publish = (snapshot: TaskSnapshot) => {
    for (const listener of listeners.get(snapshot.task.taskId) ?? []) listener(snapshot);
  };

  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof TaskNotFoundError) return failure(c, 404, 'task_not_found', '没有这个报销任务。');
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
    const snapshot = await tasks.upload(c.req.param('id'), files);
    publish(snapshot);
    return c.json(snapshot);
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

  return app;
}

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
