import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { ParseOutcome } from './dispatch';
import type { Layout } from './layout';
import { LAYOUTS } from './layouts';
import { parseMaterial, type ParseInput } from './material';

// Where parsing runs. The server uses one `worker_thread` for all tasks (ADR-0017), so HTTP stays responsive; it is
// started on demand and released after `idleMs` without work, which also releases OCR (#186) when a job ends.
// Tests may inject another executor (`inlineExecutor`, or a gated one).

export interface ParseExecutor {
  // Never rejects: a crash of the runtime is a retryable `failed` outcome.
  parse(input: ParseInput): Promise<ParseOutcome>;
  close(): Promise<void>;
}

export function inlineExecutor(layouts: readonly Layout[] = LAYOUTS): ParseExecutor {
  return { parse: (input) => parseMaterial(input, layouts), close: async () => {} };
}

// The built server ships `dist/parse-worker.mjs` next to `dist/main.mjs`. From source (tests, `pnpm dev`) the TS entry
// runs through tsx, resolved from the server package (the working directory of both).
function workerEntry(): { url: URL; execArgv: string[] } {
  const built = new URL('./parse-worker.mjs', import.meta.url);
  if (existsSync(fileURLToPath(built))) return { url: built, execArgv: [] };
  return { url: new URL('./worker.ts', import.meta.url), execArgv: ['--import', 'tsx'] };
}

export type WorkerRequest = { id: number; input: ParseInput };
export type WorkerReply = { id: number; outcome: ParseOutcome };

export function workerExecutor({ idleMs = 2000 }: { idleMs?: number } = {}): ParseExecutor {
  let worker: Worker | null = null;
  let idle: NodeJS.Timeout | null = null;
  let nextId = 0;
  const waiting = new Map<number, (outcome: ParseOutcome) => void>();

  const failAll = (reason: string) => {
    for (const resolve of waiting.values()) resolve({ outcome: 'failed', retryable: true, reason });
    waiting.clear();
  };

  const scheduleRelease = () => {
    idle = setTimeout(() => {
      const current = worker;
      worker = null;
      if (current && waiting.size === 0) void current.terminate();
    }, idleMs);
    idle.unref();
  };

  const spawn = (): Worker => {
    const entry = workerEntry();
    const spawned = new Worker(entry.url, { execArgv: entry.execArgv });
    spawned.on('message', ({ id, outcome }: WorkerReply) => {
      waiting.get(id)?.(outcome);
      waiting.delete(id);
      if (waiting.size === 0) scheduleRelease();
    });
    spawned.on('error', (error) => failAll(`parse worker failed: ${error.message}`));
    spawned.on('exit', (code) => {
      if (worker === spawned) worker = null;
      failAll(`parse worker exited (${code})`);
    });
    spawned.unref();
    return spawned;
  };

  return {
    parse(input) {
      if (idle) clearTimeout(idle);
      idle = null;
      worker ??= spawn();
      const id = nextId++;
      const target = worker;
      return new Promise<ParseOutcome>((resolve) => {
        waiting.set(id, resolve);
        target.postMessage({ id, input } satisfies WorkerRequest);
      });
    },
    async close() {
      if (idle) clearTimeout(idle);
      const current = worker;
      worker = null;
      failAll('parse worker closed');
      if (current) await current.terminate();
    },
  };
}
