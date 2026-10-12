// What the page did on the wire and in its console while the spike watched it: every request (method, path, type,
// status, size, how long), every WebSocket, every console error or warning, every uncaught exception. S2's login
// stops in some runs and not others; this is the record that tells a slow link from a request that never came back,
// a click that sent nothing from a console that never finished, and a failed resource from a script error.
//
// URLs keep their origin and path and lose the query string, which is where session ids and tickets travel. Messages
// are cut short; the report redacts them like everything else.
import { evalIn, type CdpSession } from '@baox/erp-executor/cdp';

type Request = { id: string; method: string; url: string; type: string; startMs: number; endMs: number | null; status: number | null; failed: string | null; bytes: number | null };
type Socket = { url: string; openedMs: number; handshake: number | null; handshakeMs: number | null; closedMs: number | null; errors: string[]; framesIn: number; framesOut: number };
type ConsoleLine = { atMs: number; source: string; level: string; text: string };
type Open = { method: string; url: string; type: string; ageMs: number };

export type PageTrace = {
  /** Requests still open at least `minAgeMs` after they started, oldest first. WebSockets are not requests here. */
  pending(minAgeMs?: number): Open[];
  /** How many requests the page has started since the trace attached: a click that sends nothing leaves it unchanged. */
  started(): number;
  snapshot(): Promise<TraceSnapshot>;
  stop(): void;
};

export type TraceSnapshot = {
  sinceAttachMs: number; requests: number;
  /** All bytes received over all request time: a rough measure of the link. */
  link: { bytes: number; kbPerSec: number | null };
  pending: Open[];
  failed: Array<{ method: string; url: string; type: string; atMs: number; error: string }>;
  httpErrors: Array<{ method: string; url: string; type: string; status: number }>;
  slowest: Array<{ method: string; url: string; type: string; ms: number; status: number | null; kb: number | null }>;
  /** The most recent requests in the order they started: what the page did last before it stopped. */
  latest: Array<{ method: string; url: string; type: string; startMs: number; ms: number | null; status: number | null; failed: string | null }>;
  sockets: Socket[];
  console: ConsoleLine[];
  /** The page's own Resource Timing, which also covers what loaded before the spike attached. */
  resources: { count: number; failedOrBlocked: string[]; slowest: Array<{ url: string; ms: number; status: number | null }> } | null;
};

const MAX_REQUESTS = 3000;
const MAX_CONSOLE = 200;
const MAX_SOCKETS = 20;

/** Origin and path only: the query string is where tickets and session ids travel. */
export const bareUrl = (url: unknown): string => {
  try { const u = new URL(String(url)); return u.protocol === 'data:' ? 'data:…' : `${u.origin}${u.pathname}`; } catch { return String(url).slice(0, 80); }
};

const short = (text: unknown, n = 240) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const RESOURCES = `(() => {
  const all = performance.getEntriesByType('resource');
  const bare = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return String(u).slice(0, 80); } };
  const status = (e) => (typeof e.responseStatus === 'number' ? e.responseStatus : null);
  return {
    count: all.length,
    // A failed or blocked fetch leaves an entry with no response at all: zero transfer and zero response start.
    failedOrBlocked: all.filter((e) => e.responseStart === 0 || (status(e) !== null && (status(e) === 0 || status(e) >= 400)))
      .map((e) => e.initiatorType + ' ' + bare(e.name) + (status(e) !== null ? ' ' + status(e) : '')).slice(0, 30),
    slowest: [...all].sort((a, b) => b.duration - a.duration).slice(0, 10)
      .map((e) => ({ url: bare(e.name), ms: Math.round(e.duration), status: status(e) })),
  };
})()`;

/**
 * Start recording `session`'s network and console. Enables the Network, Runtime and Log domains on it; reading never
 * changes what the page does. Returns a recorder whose snapshots are safe to put in the report after redaction.
 */
export async function tracePage(session: CdpSession): Promise<PageTrace> {
  const attached = Date.now();
  const requests = new Map<string, Request>();
  const sockets = new Map<string, Socket>();
  const lines: ConsoleLine[] = [];
  const at = () => Date.now() - attached;
  const say = (source: string, level: string, text: unknown) => {
    if (lines.length < MAX_CONSOLE) lines.push({ atMs: at(), source, level, text: short(text) });
  };
  const offs: Array<() => void> = [];
  const on = (method: string, listener: (p: any) => void) => { const off = session.on?.(method, listener); if (off) offs.push(off); };

  on('Network.requestWillBeSent', (p) => {
    if (requests.size >= MAX_REQUESTS && !requests.has(p.requestId)) return;
    requests.set(p.requestId, { id: p.requestId, method: p.request?.method ?? '?', url: bareUrl(p.request?.url), type: p.type ?? '?', startMs: at(), endMs: null, status: null, failed: null, bytes: null });
  });
  on('Network.responseReceived', (p) => { const r = requests.get(p.requestId); if (r) r.status = p.response?.status ?? null; });
  on('Network.loadingFinished', (p) => { const r = requests.get(p.requestId); if (r) { r.endMs = at(); r.bytes = typeof p.encodedDataLength === 'number' ? p.encodedDataLength : null; } });
  on('Network.loadingFailed', (p) => {
    const r = requests.get(p.requestId);
    if (r) { r.endMs = at(); r.failed = p.canceled ? 'canceled' : short(p.errorText ?? 'failed', 80); }
  });
  // WebSockets never reach requestWillBeSent; a console waiting on one that never connects shows no open request.
  on('Network.webSocketCreated', (p) => {
    if (sockets.size < MAX_SOCKETS) sockets.set(p.requestId, { url: bareUrl(p.url), openedMs: at(), handshake: null, handshakeMs: null, closedMs: null, errors: [], framesIn: 0, framesOut: 0 });
  });
  on('Network.webSocketHandshakeResponseReceived', (p) => { const s = sockets.get(p.requestId); if (s) { s.handshake = p.response?.status ?? null; s.handshakeMs = at(); } });
  on('Network.webSocketFrameReceived', (p) => { const s = sockets.get(p.requestId); if (s) s.framesIn += 1; });
  on('Network.webSocketFrameSent', (p) => { const s = sockets.get(p.requestId); if (s) s.framesOut += 1; });
  on('Network.webSocketFrameError', (p) => { const s = sockets.get(p.requestId); if (s && s.errors.length < 5) s.errors.push(short(p.errorMessage, 120)); });
  on('Network.webSocketClosed', (p) => { const s = sockets.get(p.requestId); if (s) s.closedMs = at(); });
  on('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error' && p.type !== 'warning' && p.type !== 'assert') return;
    say('console', p.type, (p.args ?? []).map((a: any) => a?.value ?? a?.description ?? a?.type).join(' '));
  });
  on('Runtime.exceptionThrown', (p) => say('exception', 'error', p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
  on('Log.entryAdded', (p) => {
    if (p.entry?.level !== 'error' && p.entry?.level !== 'warning') return;
    say(`log:${p.entry?.source ?? '?'}`, p.entry.level, `${p.entry.text ?? ''}${p.entry.url ? ` (${bareUrl(p.entry.url)})` : ''}`);
  });
  for (const domain of ['Network', 'Runtime', 'Log']) await session.send(`${domain}.enable`, {}).catch(() => null);

  const pending = (minAgeMs = 0) => {
    const now = at();
    return [...requests.values()].filter((r) => r.endMs === null && now - r.startMs >= minAgeMs)
      .sort((a, b) => a.startMs - b.startMs).map((r) => ({ method: r.method, url: r.url, type: r.type, ageMs: now - r.startMs }));
  };

  return {
    pending,
    started: () => requests.size,
    async snapshot() {
      const all = [...requests.values()];
      const done = all.filter((r) => r.endMs !== null && !r.failed);
      const bytes = done.reduce((n, r) => n + (r.bytes ?? 0), 0);
      const busyMs = done.reduce((n, r) => n + (r.endMs! - r.startMs), 0);
      return {
        sinceAttachMs: at(), requests: all.length,
        link: { bytes, kbPerSec: busyMs > 0 ? Math.round(bytes / busyMs) : null },
        pending: pending().slice(0, 30),
        failed: all.filter((r) => r.failed).slice(-30).map((r) => ({ method: r.method, url: r.url, type: r.type, atMs: r.endMs ?? 0, error: r.failed! })),
        httpErrors: all.filter((r) => (r.status ?? 0) >= 400).slice(-30).map((r) => ({ method: r.method, url: r.url, type: r.type, status: r.status! })),
        slowest: [...done].sort((a, b) => (b.endMs! - b.startMs) - (a.endMs! - a.startMs)).slice(0, 10)
          .map((r) => ({ method: r.method, url: r.url, type: r.type, ms: r.endMs! - r.startMs, status: r.status, kb: r.bytes === null ? null : Math.round(r.bytes / 1024) })),
        latest: [...all].sort((a, b) => a.startMs - b.startMs).slice(-40)
          .map((r) => ({ method: r.method, url: r.url, type: r.type, startMs: r.startMs, ms: r.endMs === null ? null : r.endMs - r.startMs, status: r.status, failed: r.failed })),
        sockets: [...sockets.values()].map((s) => ({ ...s, errors: [...s.errors] })),
        console: [...lines],
        resources: await evalIn<TraceSnapshot['resources']>(session, RESOURCES).catch(() => null),
      };
    },
    stop() { for (const off of offs) off(); },
  };
}
