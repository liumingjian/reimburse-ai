import { parentPort } from 'node:worker_threads';
import type { WorkerReply, WorkerRequest } from './executor';
import { parseMaterial } from './material';

// The parse `worker_thread` (ADR-0017): one material at a time, in arrival order. Built to `dist/parse-worker.mjs`.
const port = parentPort;
if (!port) throw new Error('parse worker must run in a worker_thread');

let queue: Promise<void> = Promise.resolve();
port.on('message', (request: WorkerRequest) => {
  queue = queue.then(async () => {
    const outcome = await parseMaterial(request.input);
    port.postMessage({ id: request.id, outcome } satisfies WorkerReply);
  });
});
