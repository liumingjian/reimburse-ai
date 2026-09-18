// Waiting primitives shared by the executor. The real ERP needs real waits (settling grids, lazy sections,
// the invoice assistant); tests on the fake ERP pass a fast pace instead of editing the waits themselves.

export type Pace = {
  /** Quiet period used to decide that a grid has stopped recalculating. */
  quietMs: number;
  /** Poll interval of every wait-for-condition loop. */
  pollMs: number;
  /** Fixed settle sleeps the real ERP needs after clicks (section anchors, menus, dialogs). */
  settleMs: number;
  /** Upper bound for waits on slow ERP work (navigation, the invoice assistant, recognition). */
  longMs: number;
};

export const DEFAULT_PACE: Pace = { quietMs: 900, pollMs: 300, settleMs: 1200, longMs: 90_000 };

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Observe until `ok` holds or the time runs out. A timeout returns the last observation; the caller judges. */
export async function waitFor<T>(probe: () => Promise<T>, ok: (value: T) => boolean, ms: number, pollMs = 300): Promise<T> {
  const deadline = Date.now() + ms;
  let last = await probe();
  while (!ok(last) && Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    last = await probe();
  }
  return last;
}
