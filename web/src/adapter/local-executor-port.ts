import {
  LOCAL_EXECUTOR_LOOPBACK_ORIGIN, LOCAL_EXECUTOR_PAIRING_PATH, LocalExecutorPairAnswerSchema, LocalExecutorPairingStateSchema,
  type LocalExecutorPairAnswer, type LocalExecutorPairingState,
} from '@baox/contract';

// The page's way to the baox 本地执行器 running on this PC (ADR-0035, amended 2026-10-16): its loopback listener on
// 47319 answers the app's own page only (`local-executor/src/pairing-port.ts`). The 设置页 asks it whom it is paired to,
// and hands it a fresh 配对码 to redeem, so re-pairing an installed executor is one click instead of a terminal.
// Injected like the extension bridge (`App`'s `localExecutor`), so tests and the mock hand in their own.
//
// Silence is an answer: no executor on this PC, or a browser that refuses to reach loopback, resolves null.

export type LocalExecutorPort = {
  /** Who the executor on this PC is paired to. Null when nothing answers in time. */
  probe(): Promise<LocalExecutorPairingState | null>;
  /** Hands it a 配对码 issued for this account. Null when nothing answers in time. */
  pair(code: string): Promise<LocalExecutorPairAnswer | null>;
};

/** A port nothing ever answers on: pages rendered without one. */
export const SILENT_LOCAL_EXECUTOR_PORT: LocalExecutorPort = { probe: async () => null, pair: async () => null };

// The executor answers at once; anything slower is not there. Pairing waits for its round trip to the app.
export const LOCAL_EXECUTOR_PROBE_TIMEOUT_MS = 1_500;
export const LOCAL_EXECUTOR_PAIR_TIMEOUT_MS = 15_000;

export type LoopbackPortOptions = { fetch?: typeof fetch; probeTimeoutMs?: number; pairTimeoutMs?: number };

/** The real port, over `fetch` to 127.0.0.1:47319. */
export function createLoopbackPort({ fetch: get = (...args) => fetch(...args), probeTimeoutMs = LOCAL_EXECUTOR_PROBE_TIMEOUT_MS, pairTimeoutMs = LOCAL_EXECUTOR_PAIR_TIMEOUT_MS }: LoopbackPortOptions = {}): LocalExecutorPort {
  const url = `${LOCAL_EXECUTOR_LOOPBACK_ORIGIN}${LOCAL_EXECUTOR_PAIRING_PATH}`;
  async function ask<T>(init: RequestInit, timeoutMs: number, parse: (body: unknown) => T | null): Promise<T | null> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await get(url, { ...init, signal: abort.signal, cache: 'no-store' });
      return parse(await response.json());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    probe: () => ask({ method: 'GET' }, probeTimeoutMs, (body) => {
      const parsed = LocalExecutorPairingStateSchema.safeParse(body);
      return parsed.success ? parsed.data : null;
    }),
    // A refusal (busy, pairing, a code the app did not take) comes back with its sentence, whatever the status.
    pair: (code) => ask({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }, pairTimeoutMs, (body) => {
      const parsed = LocalExecutorPairAnswerSchema.safeParse(body);
      return parsed.success ? parsed.data : null;
    }),
  };
}
