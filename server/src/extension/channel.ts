import {
  CHANNEL_CLOSE,
  CHANNEL_PING_METHOD,
  ChannelMessageSchema,
  CHANNEL_ERRORS,
  CHANNEL_HEARTBEAT_MS,
  MINIMUM_CLIENT_VERSION,
  CLIENT_VERSION_TOO_OLD_CODE,
  clientVersionRefusal,
  type ChannelMessage,
} from '@baox/contract';
import type { Clock } from '../accounts/accounts';
import type { PairingService } from './pairing';

// The 浏览器扩展 (browser extension) channel: one open socket per 应用账号 (app account), opened by the extension and
// never by the server. The server cannot reach into an employee's browser — it has no address for it — so the only
// thing it can do is answer, and hold what it is given.
//
// What is in here is the envelope and the account routing. The fill protocol's methods are not: #254 supplies them
// through `onRequest`, and this module stays ignorant of what a fill is.
//
// Three properties this module owns:
//
// - The 配对凭据 (pairing credential) arrives in the first message, never in the URL. A `wss://…?token=` would be
//   copied into proxy logs, browser history and `Referer`; a first message is not.
// - The reported version is checked before anything else the extension says is acted on (ADR-0021). An extension
//   below the minimum is told what to do about it and disconnected, because half-executing a plan it does not
//   understand ends in an ERP write of undecidable outcome.
// - A pairing that goes away takes its socket with it (`disconnect`). The token is checked only at `hello`, so
//   revoking, replacing or deactivating would otherwise leave the old socket connected — and it would receive the next
//   `erp.fill` (stories 10 and 12).
// - When the socket goes, whoever runs work over it hears which account lost it (`onLost`), and nothing else is
//   decided here. A lost socket interrupts that account's job; whether the job resumes within the reconnection
//   window or ends — and with it the ERP 自动化控制权 (ERP automation control) the job holds — is the remote
//   executor's decision (ADR-0020), because only it knows whether a job was running and what was on record.

// A socket as this module needs it. Everything real is on the other side of `ws` (`websocket.ts`), so a test drives
// the channel with a fake extension client and never opens a port.
export type ChannelSocket = {
  send(data: string): void;
  close(code: number, reason: string): void;
};

// What the transport hands the incoming bytes and the close event to.
export type ChannelSession = {
  message(raw: string): Promise<void>;
  closed(): void;
};

// What the extension asks the server to do. Unknown methods are refused rather than ignored, so a new extension
// talking to an old server fails loudly on the first call instead of waiting forever.
export type ChannelRequestHandler = (accountId: string, method: string, payload: unknown) => Promise<unknown>;

// One-way, for what nobody waits on.
export type ChannelEventHandler = (accountId: string, name: string, payload: unknown) => void;

export class ExtensionChannelError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ExtensionChannelError';
  }
}

// The timer seam: runs `run` after `ms` and returns what cancels it. Tests pass one they fire by hand.
export type Schedule = (run: () => void, ms: number) => () => void;

export type ExtensionChannelOptions = {
  pairings: PairingService;
  now: Clock;
  // What this server still talks to. Injected so a test can pin refusal without inventing a fictional release.
  minimumVersion?: string;
  onRequest?: ChannelRequestHandler;
  onEvent?: ChannelEventHandler;
  // This account's connection is gone: dropped, gone silent, or replaced by a newer socket of the same extension.
  // Called before the requests still waiting on it are rejected.
  onLost?: (accountId: string) => void;
  // A socket that has said nothing for this long is gone, whatever TCP still believes. Three missed heartbeats.
  silenceMs?: number;
  // How long a fresh socket has to say `hello`. The silence sweep only sees sockets that already said who they are,
  // so without this a socket that upgrades and then says nothing would be held open for ever — and anything that can
  // reach the host could hold as many as it liked, on a box memory-capped because it shares with the databases.
  // One heartbeat interval: an honest extension sends `hello` the moment the socket opens, so it needs one round
  // trip, and fifteen seconds covers any VPN. One that somehow misses it is closed without a refusal and redials.
  helloDeadlineMs?: number;
  schedule?: Schedule;
};

export type ExtensionChannel = {
  // Called by the transport once a socket is up; the returned session is fed every frame and the close event.
  open(socket: ChannelSocket): ChannelSession;
  // Whether this account's extension is listening right now. The settings page shows this.
  connected(accountId: string): boolean;
  // Ask that account's extension to do something and wait for its answer. Rejects at once when nothing is
  // connected, and rejects in flight if the socket goes.
  request(accountId: string, method: string, payload: unknown): Promise<unknown>;
  // One-way, fire and forget; false when nothing is connected.
  emit(accountId: string, name: string, payload: unknown): boolean;
  // This account's pairing is gone: revoked, replaced by a new 配对码, or the account deactivated. Its socket is
  // refused and closed at once, with the terminal `refused` frame so the extension stops redialling, and it is lost
  // like any other: a job running over it is interrupted and settled by the reconnection window (ADR-0020). A `hello`
  // still being checked for this account is refused too.
  disconnect(accountId: string): void;
  close(): void;
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

type Connection = {
  accountId: string;
  socket: ChannelSocket;
  pending: Map<string, Pending>;
  lastSeen: number;
  gone: boolean;
};

// 1001 'going away': closed for a reason that is not the extension's doing, so it may reconnect.
const GOING_AWAY = 1001;
// 1008 'policy violation': the socket never said who it was. No `refused` frame, so an extension that was merely
// slow redials instead of giving up.
const POLICY_VIOLATION = 1008;

export const realTimer: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

// Why `request` rejected: nothing of that account was connected, or its socket went with the request in flight.
export const EXTENSION_OFFLINE_CODE = 'extension_offline';
// Why a 去报销 was refused before it started: this account has no extension paired at all.
export const EXTENSION_NOT_PAIRED_CODE = 'extension_not_paired';
export const EXTENSION_CONNECTION_LOST_CODE = 'extension_connection_lost';

export function createExtensionChannel({ pairings, now, minimumVersion = MINIMUM_CLIENT_VERSION, onRequest, onEvent, onLost, silenceMs = CHANNEL_HEARTBEAT_MS * 3, helloDeadlineMs = CHANNEL_HEARTBEAT_MS, schedule = realTimer }: ExtensionChannelOptions): ExtensionChannel {
  const byAccount = new Map<string, Connection>();
  let nextId = 0;
  // `disconnect` bumps the generation and notes it per account. A `hello` whose token was looked up before a
  // disconnect of its account would otherwise register a socket for a pairing that no longer exists.
  let generation = 0;
  const disconnectedAt = new Map<string, number>();

  const write = (socket: ChannelSocket, message: ChannelMessage) => socket.send(JSON.stringify(message));

  const refuse = (socket: ChannelSocket, code: number, reason: string, message: string) => {
    write(socket, { type: 'refused', code: reason, message });
    socket.close(code, reason);
  };
  const refuseNotPaired = (socket: ChannelSocket) => refuse(socket, CHANNEL_CLOSE.notPaired, 'not_paired', CHANNEL_ERRORS.notPaired);

  // Every way a connection ends funnels through here, so "a lost socket is heard about" is one rule in one place.
  function drop(connection: Connection): void {
    if (connection.gone) return;
    connection.gone = true;
    if (byAccount.get(connection.accountId) === connection) {
      byAccount.delete(connection.accountId);
      onLost?.(connection.accountId);
    }
    const lost = new ExtensionChannelError(EXTENSION_CONNECTION_LOST_CODE, '浏览器扩展的连接断开了。');
    for (const pending of connection.pending.values()) pending.reject(lost);
    connection.pending.clear();
  }

  // A socket that stopped answering still looks open to TCP for minutes. The extension sends a ping every
  // CHANNEL_HEARTBEAT_MS; three missed ones is gone, and gone interrupts whatever job ran over it.
  const sweep = setInterval(() => {
    const deadline = now().getTime() - silenceMs;
    for (const connection of [...byAccount.values()]) {
      if (connection.lastSeen > deadline) continue;
      drop(connection);
      connection.socket.close(GOING_AWAY, 'silent');
    }
  }, silenceMs);
  sweep.unref?.();

  return {
    open(socket) {
      let connection: Connection | null = null;
      // Cancelled by the first frame, whatever it is: anything but a valid `hello` is refused and closed on the spot,
      // so the deadline only ever catches a socket that says nothing at all.
      let cancelDeadline: (() => void) | null = schedule(() => {
        cancelDeadline = null;
        socket.close(POLICY_VIOLATION, 'hello_timeout');
      }, helloDeadlineMs);
      const stopDeadline = () => {
        cancelDeadline?.();
        cancelDeadline = null;
      };

      async function handle(message: ChannelMessage): Promise<void> {
        if (connection === null) {
          // Nothing but `hello` is read before the extension has said who it is: an unauthenticated socket gets no
          // side effects at all.
          if (message.type !== 'hello') return refuse(socket, CHANNEL_CLOSE.badMessage, 'bad_message', CHANNEL_ERRORS.badMessage);
          const tooOld = clientVersionRefusal(message.version, minimumVersion);
          if (tooOld) return refuse(socket, CHANNEL_CLOSE.versionTooOld, CLIENT_VERSION_TOO_OLD_CODE, tooOld);
          const lookedUpAt = generation;
          const found = await pairings.lookup(message.token);
          if (!found) return refuseNotPaired(socket);
          await pairings.noteConnection(found.accountId, message.version ?? null);
          if ((disconnectedAt.get(found.accountId) ?? -1) > lookedUpAt) return refuseNotPaired(socket);
          // One pairing per account means a second socket is the same extension reconnecting over a corpse of a
          // connection the server has not noticed yet. The newer one wins, and the older is lost like any other: a job
          // that ran over it is interrupted, and resumes over this one.
          const previous = byAccount.get(found.accountId);
          connection = { accountId: found.accountId, socket, pending: new Map(), lastSeen: now().getTime(), gone: false };
          byAccount.set(found.accountId, connection);
          if (previous) {
            previous.gone = true;
            onLost?.(found.accountId);
            for (const pending of previous.pending.values()) pending.reject(new ExtensionChannelError(EXTENSION_CONNECTION_LOST_CODE, '浏览器扩展的连接断开了。'));
            previous.pending.clear();
            previous.socket.close(GOING_AWAY, 'replaced');
          }
          write(socket, { type: 'ready', accountId: found.accountId, heartbeatMs: CHANNEL_HEARTBEAT_MS });
          return;
        }
        const live = connection;
        live.lastSeen = now().getTime();
        switch (message.type) {
          case 'request': {
            // The heartbeat is an ordinary request, so keeping the service worker alive needs no second mechanism.
            if (message.method === CHANNEL_PING_METHOD) return write(socket, { type: 'response', id: message.id, ok: true, payload: null });
            try {
              if (!onRequest) throw new ExtensionChannelError('unknown_method', `没有处理 ${message.method} 的办法。`);
              const payload = await onRequest(live.accountId, message.method, message.payload);
              if (!live.gone) write(socket, { type: 'response', id: message.id, ok: true, payload: payload ?? null });
            } catch (error) {
              const code = error instanceof ExtensionChannelError ? error.code : 'internal_error';
              if (!live.gone) write(socket, { type: 'response', id: message.id, ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } });
            }
            return;
          }
          case 'response': {
            const pending = live.pending.get(message.id);
            if (!pending) return;
            live.pending.delete(message.id);
            if (message.ok) pending.resolve(message.payload);
            else pending.reject(new ExtensionChannelError(message.error.code, message.error.message));
            return;
          }
          case 'event':
            onEvent?.(live.accountId, message.name, message.payload);
            return;
          default:
            // `hello` twice, or anything only the server may send. Nothing here is a message an extension sends on a
            // live channel, so it is a protocol error rather than something to ignore.
            drop(live);
            return refuse(socket, CHANNEL_CLOSE.badMessage, 'bad_message', CHANNEL_ERRORS.badMessage);
        }
      }

      return {
        async message(raw) {
          stopDeadline();
          const parsed = ChannelMessageSchema.safeParse(((): unknown => {
            try {
              return JSON.parse(raw) as unknown;
            } catch {
              return null;
            }
          })());
          if (!parsed.success) {
            if (connection) drop(connection);
            return refuse(socket, CHANNEL_CLOSE.badMessage, 'bad_message', CHANNEL_ERRORS.badMessage);
          }
          await handle(parsed.data);
        },
        closed() {
          stopDeadline();
          if (connection) drop(connection);
        },
      };
    },

    connected: (accountId) => byAccount.has(accountId),

    request(accountId, method, payload) {
      const connection = byAccount.get(accountId);
      if (!connection) return Promise.reject(new ExtensionChannelError(EXTENSION_OFFLINE_CODE, '这个账号的浏览器扩展现在没有连接。'));
      nextId += 1;
      const id = `s${nextId}`;
      return new Promise<unknown>((resolve, reject) => {
        connection.pending.set(id, { resolve, reject });
        write(connection.socket, { type: 'request', id, method, payload });
      });
    },

    emit(accountId, name, payload) {
      const connection = byAccount.get(accountId);
      if (!connection) return false;
      write(connection.socket, { type: 'event', name, payload });
      return true;
    },

    disconnect(accountId) {
      generation += 1;
      disconnectedAt.set(accountId, generation);
      const connection = byAccount.get(accountId);
      if (!connection) return;
      drop(connection);
      refuseNotPaired(connection.socket);
    },

    close() {
      clearInterval(sweep);
      for (const connection of [...byAccount.values()]) {
        drop(connection);
        connection.socket.close(GOING_AWAY, 'server_closing');
      }
    },
  };
}
