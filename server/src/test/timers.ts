// The 本地执行器 channel's timers, fired by hand (`createTestServer({ schedule })`): the hello deadline and the
// reconnection window close when a test says so, not 15 or 120 seconds later.
export function manualTimers() {
  let now = 0;
  const due = new Set<{ run: () => void; ms: number; dueAt: number }>();
  return {
    schedule: (run: () => void, ms: number) => {
      const entry = { run, ms, dueAt: now + ms };
      due.add(entry);
      return () => void due.delete(entry);
    },
    pending: (ms: number) => [...due].filter((entry) => entry.ms === ms).length,
    advanceBy(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = [...due].filter((entry) => entry.dueAt <= target).sort((a, b) => a.dueAt - b.dueAt)[0];
        if (!next) break;
        now = next.dueAt;
        due.delete(next);
        next.run();
      }
      now = target;
    },
    elapse(ms: number) {
      for (const entry of [...due]) {
        if (entry.ms !== ms) continue;
        due.delete(entry);
        entry.run();
      }
    },
  };
}
