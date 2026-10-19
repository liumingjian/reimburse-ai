// The client channel's timers, fired by hand (`createTestServer({ schedule })`): the hello deadline and the
// reconnection window close when a test says so, not 15 or 120 seconds later.
export function manualTimers() {
  const due = new Set<{ run: () => void; ms: number }>();
  return {
    schedule: (run: () => void, ms: number) => {
      const entry = { run, ms };
      due.add(entry);
      return () => void due.delete(entry);
    },
    pending: (ms: number) => [...due].filter((entry) => entry.ms === ms).length,
    elapse(ms: number) {
      for (const entry of [...due]) {
        if (entry.ms !== ms) continue;
        due.delete(entry);
        entry.run();
      }
    },
  };
}
