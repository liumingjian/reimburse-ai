// Pairing on 47319 (ADR-0035, amended 2026-10-16 and 2026-10-17): what lets the 设置页 re-pair a running executor in one
// click, after an account switch or a revoke, without a terminal.
//
// The holder owns the executor's pairing while it runs. A pairing that is gone (the app says `not_paired`: revoked, or
// replaced by a newer pairing) stops the job loop and is forgotten, and the executor stays up, unpaired. A
// 配对码 handed over by the page is redeemed exactly as the install redeems one; on success the job loop starts again
// on the new pairing, replacing the old one if there was one.
//
// The listener answers the app's own page only, decided by the request's `Origin`: another site, or a request without
// an Origin, learns nothing (not even whom it is paired to) and cannot hand over a code. It answers the browser's
// private-network preflight for the same origin only, since the page is on the network and 47319 is on loopback.

import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import {
  LOCAL_EXECUTOR_PAIRING_ERRORS, LOCAL_EXECUTOR_PAIRING_PATH, LocalExecutorPairRequestSchema,
  type LocalExecutorPairAnswer, type LocalExecutorPairingState,
} from '@baox/contract';
import type { PairingOutcome } from '@baox/channel/pairing';
import type { Store, StoredPairing } from './store';

export type PairingHolderPorts = {
  /** The app's own configured origin: the pairing is made there, and only its page may ask for one. */
  origin: string;
  store: Pick<Store, 'readPairing' | 'writePairing' | 'clearPairing'>;
  /** Redeem a 配对码 at the app, as the install does. */
  redeem(code: string): Promise<PairingOutcome>;
  /** Start the job loop on a pairing; `lost` is for when the app says it is gone. Returns its stop. */
  connect(pairing: StoredPairing, lost: () => void): () => void;
  /** A 去报销 is running: the pairing is not taken over under it. */
  busy(): boolean;
};

export type PairingHolder = {
  /** Start the job loop on the stored pairing, if there is one. */
  start(): void;
  current(): StoredPairing | null;
  pair(code: string): Promise<LocalExecutorPairAnswer & { status?: number }>;
};

export function createPairingHolder(ports: PairingHolderPorts): PairingHolder {
  const origin = ports.origin.replace(/\/+$/, '');
  let current: StoredPairing | null = null;
  let stop: (() => void) | null = null;
  let generation = 0;
  let pairing = false;

  const run = (next: StoredPairing | null) => {
    stop?.();
    stop = null;
    current = next;
    const mine = ++generation;
    if (!next) return;
    // A word from a loop already replaced is about a pairing this executor no longer holds.
    stop = ports.connect(next, () => {
      if (mine !== generation) return;
      ports.store.clearPairing();
      run(null);
    });
  };

  return {
    start: () => run(ports.store.readPairing()),
    current: () => current,
    async pair(code) {
      if (pairing) return { ok: false, code: 'local_executor_pairing', message: LOCAL_EXECUTOR_PAIRING_ERRORS.pairing, status: 409 };
      if (ports.busy()) return { ok: false, code: 'local_executor_busy', message: LOCAL_EXECUTOR_PAIRING_ERRORS.busy, status: 409 };
      pairing = true;
      try {
        const outcome = await ports.redeem(code);
        if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message, status: 422 };
        const next = { origin, token: outcome.token, accountId: outcome.accountId };
        ports.store.writePairing(next);
        run(next);
        return { ok: true, accountId: next.accountId };
      } finally {
        pairing = false;
      }
    },
  };
}

const BODY_LIMIT = 4 * 1024;

const sameOrigin = (value: string | undefined, expected: string) => {
  if (!value) return false;
  try { return new URL(value).origin === new URL(expected).origin; } catch { return false; }
};

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) { resolve(null); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); } catch { resolve(null); } });
    request.on('error', () => resolve(null));
  });
}

/**
 * The 47319 listener. `log` takes an unexpected error (the executor's own log, by default its stderr): the page only
 * ever gets the fixed sentence for it, never the error's own text.
 */
export function pairingListener({ appOrigin, holder, log = (error) => console.error('pairing on 47319 failed:', error) }: { appOrigin: string; holder: Pick<PairingHolder, 'current' | 'pair'>; log?: (error: unknown) => void }): RequestListener {
  const allowed = new URL(appOrigin).origin;
  return (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, body?: unknown) => {
      response.statusCode = status;
      if (body !== undefined) response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    response.setHeader('vary', 'Origin');
    if (!sameOrigin(request.headers.origin, allowed)) return send(403);
    response.setHeader('access-control-allow-origin', allowed);
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path !== LOCAL_EXECUTOR_PAIRING_PATH) return send(404);
    if (request.method === 'OPTIONS') {
      response.setHeader('access-control-allow-methods', 'GET, POST');
      response.setHeader('access-control-allow-headers', 'content-type');
      response.setHeader('access-control-allow-private-network', 'true');
      response.setHeader('access-control-max-age', '600');
      return send(204);
    }
    if (request.method === 'GET') {
      const pairing = holder.current();
      const state: LocalExecutorPairingState = pairing ? { paired: true, accountId: pairing.accountId } : { paired: false };
      return send(200, state);
    }
    if (request.method !== 'POST') return send(405);
    void (async () => {
      const parsed = LocalExecutorPairRequestSchema.safeParse(await readBody(request));
      if (!parsed.success) return send(400, { ok: false, code: 'bad_request', message: LOCAL_EXECUTOR_PAIRING_ERRORS.request });
      const { status, ...answer } = await holder.pair(parsed.data.code).catch((error: unknown) => {
        log(error);
        return { ok: false as const, code: 'local_executor_error', message: LOCAL_EXECUTOR_PAIRING_ERRORS.failed, status: 500 };
      });
      send(status ?? 200, answer);
    })();
  };
}
