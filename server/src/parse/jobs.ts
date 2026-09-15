import type { TaskService } from '../tasks';
import type { ParseExecutor } from './executor';

// The 盘点 (inventory) parser job: after start-inventory, parse the run's materials in the background, PDFs first,
// then images, one at a time. Each outcome is a fact appended through the task service, which bumps the revision and
// publishes the snapshot, so the page shows per-material progress live. The job keeps no state of its own: what is
// left is derived from the facts, so a restart resumes where it stopped (`resumeAll`).

export type ParseJobs = ReturnType<typeof createParseJobs>;

export function createParseJobs(tasks: TaskService, executor: ParseExecutor) {
  // Per task: running, and whether another pass was requested meanwhile (a start-inventory racing the last lap).
  const running = new Map<string, { again: boolean; done: Promise<void> }>();
  let closed = false;
  let resuming: Promise<void> = Promise.resolve();

  async function drain(taskId: string): Promise<void> {
    while (!closed) {
      const next = await tasks.nextToParse(taskId);
      if (!next) return;
      const outcome = await executor.parse(next.input);
      if (closed) return;
      if (!(await tasks.recordParse(taskId, next.runId, next.input.materialId, outcome))) return;
    }
  }

  function ensure(taskId: string): void {
    const current = running.get(taskId);
    if (current) {
      current.again = true;
      return;
    }
    const state = { again: false, done: Promise.resolve() };
    state.done = (async () => {
      try {
        do {
          state.again = false;
          await drain(taskId);
        } while (state.again && !closed);
      } catch (error) {
        console.error(`parser job for task ${taskId} stopped:`, error);
      } finally {
        running.delete(taskId);
      }
    })();
    running.set(taskId, state);
  }

  return {
    ensure,
    resumeAll(): void {
      resuming = tasks.parseBacklog().then((ids) => ids.forEach(ensure), (error) => console.error('parser job resume failed:', error));
    },
    // Stops after the material in flight, then releases the executor.
    async close(): Promise<void> {
      closed = true;
      await resuming;
      await executor.close();
      while (running.size) await Promise.all([...running.values()].map((state) => state.done));
    },
  };
}
