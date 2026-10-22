import { CHANNEL_PING_METHOD, ChannelMessageSchema, CHANNEL_PATH, CHANNEL_HEARTBEAT_MS, EXECUTOR_VERSION, type ChannelMessage } from '@baox/contract';
import { CHANNEL_CLOSED } from './messages';

// The 本地执行器's side of the channel. It dials; the server never dials it, because a browser on an employee's
// machine has no address a server could reach.
//
// Everything here is one socket's worth of state plus the loop that replaces it. Nothing in this file knows about
// a runtime: the 本地执行器 supplies the socket and the credentials, and a test supplies a fake, which is how a
// channel with correlated request/response gets covered without a browser or a port.

export type ClientSocket = {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
};

export type OpenSocket = (url: string) => ClientSocket;

// What the client reports. `refused` is terminal: the server has said this 本地执行器 may not connect at all, and
// dialling again would only repeat the refusal.
export type ChannelStatus = { state: 'connecting' } | { state: 'ready'; accountId: string } | { state: 'offline'; retryInMs: number } | { state: 'refused'; code: string; message: string };

// What the server asks this 本地执行器 to do. #254 gives the methods meaning; without a handler every request is
// refused by name rather than dropped, so a mismatch shows up as an error and not as a hang.
export type ClientRequestHandler = (method: string, payload: unknown) => Promise<unknown>;

export type ChannelClientOptions = {
  // Baked in at build time (`origin.ts`). There is deliberately no way to change it at run time: an employee who
  // could retarget the 本地执行器 could be talked into targeting someone else's server.
  origin: string;
  token: string;
  open: OpenSocket;
  version?: string;
  onRequest?: ClientRequestHandler;
  onStatus?: (status: ChannelStatus) => void;
};

export type ChannelClient = {
  request(method: string, payload: unknown): Promise<unknown>;
  emit(name: string, payload: unknown): void;
  status(): ChannelStatus;
  stop(): void;
};

// Same shape as the web page's SSE backoff: quick first retry for a server that is merely restarting, capped so a
// server that is off for the night is not hammered.
export const RECONNECT_MIN_MS = 500;
export const RECONNECT_MAX_MS = 10_000;
export const reconnectDelay = (attempt: number): number => Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** attempt);

export function channelUrl(origin: string): string {
  return `${origin.replace(/^http/, 'ws')}${CHANNEL_PATH}`;
}

class RequestFailed extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RequestFailed';
  }
}

export function createChannelClient({ origin, token, open, version = EXECUTOR_VERSION, onRequest, onStatus }: ChannelClientOptions): ChannelClient {
  type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
  const pending = new Map<string, Pending>();
  let socket: ClientSocket | null = null;
  let current: ChannelStatus = { state: 'connecting' };
  let attempt = 0;
  let nextId = 0;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  // Set when a ping goes out, cleared when it comes back. Two in a row unanswered is a socket that is open only as
  // far as TCP is concerned.
  let awaitingPing = false;

  const announce = (status: ChannelStatus) => {
    current = status;
    onStatus?.(status);
  };

  const write = (message: ChannelMessage) => socket?.send(JSON.stringify(message));

  const failPending = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };

  function stopTimers(): void {
    if (heartbeat !== null) clearInterval(heartbeat);
    heartbeat = null;
    awaitingPing = false;
  }

  function scheduleReconnect(): void {
    if (stopped || current.state === 'refused') return;
    const delay = reconnectDelay(attempt);
    attempt += 1;
    announce({ state: 'offline', retryInMs: delay });
    retry = setTimeout(connect, delay);
  }

  function beat(): void {
    if (awaitingPing) {
      // Unanswered: tear the socket down so the reconnect loop can replace it.
      socket?.close();
      return;
    }
    awaitingPing = true;
    void request(CHANNEL_PING_METHOD, null).then(
      () => {
        awaitingPing = false;
      },
      () => undefined,
    );
  }

  function handle(message: ChannelMessage): void {
    switch (message.type) {
      case 'ready':
        attempt = 0;
        announce({ state: 'ready', accountId: message.accountId });
        // Started only once the server has accepted us; an unauthenticated socket sends nothing but `hello`.
        heartbeat = setInterval(beat, CHANNEL_HEARTBEAT_MS);
        return;
      case 'refused':
        // Terminal by design (ADR-0021): a version the server will not talk to, or a pairing that is gone. Both need
        // the employee, not another dial.
        announce({ state: 'refused', code: message.code, message: message.message });
        return;
      case 'response': {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.ok) waiter.resolve(message.payload);
        else waiter.reject(new RequestFailed(message.error.code, message.error.message));
        return;
      }
      case 'request': {
        const answer = onRequest ? onRequest(message.method, message.payload) : Promise.reject(new RequestFailed('unknown_method', `这个本地执行器不认识 ${message.method}。`));
        void answer.then(
          (payload) => write({ type: 'response', id: message.id, ok: true, payload: payload ?? null }),
          (error: unknown) => write({ type: 'response', id: message.id, ok: false, error: { code: error instanceof RequestFailed ? error.code : 'executor_error', message: error instanceof Error ? error.message : String(error) } }),
        );
        return;
      }
      default:
        // `hello` and `event` are not answers to anything the 本地执行器 asked for; an event with no handler is
        // nothing to do, which is what one-way means.
        return;
    }
  }

  function connect(): void {
    if (stopped) return;
    retry = null;
    announce({ state: 'connecting' });
    const dialled = open(channelUrl(origin));
    socket = dialled;
    dialled.onopen = () => {
      // The first frame, and the only place the credential appears. Not the URL: a URL is written into logs.
      dialled.send(JSON.stringify({ type: 'hello', token, version }));
    };
    dialled.onmessage = (event) => {
      const parsed = ChannelMessageSchema.safeParse(((): unknown => {
        try {
          return JSON.parse(String(event.data)) as unknown;
        } catch {
          return null;
        }
      })());
      if (parsed.success) handle(parsed.data);
    };
    dialled.onclose = () => {
      if (socket !== dialled) return;
      socket = null;
      stopTimers();
      failPending(new RequestFailed(CHANNEL_CLOSED.code, CHANNEL_CLOSED.message));
      scheduleReconnect();
    };
    dialled.onerror = () => dialled.close();
  }

  function request(method: string, payload: unknown): Promise<unknown> {
    if (!socket || current.state !== 'ready') {
      // `ping` is the exception: it is sent from inside the heartbeat, which only runs on a ready socket.
      if (!(socket && method === CHANNEL_PING_METHOD)) return Promise.reject(new RequestFailed(CHANNEL_CLOSED.code, CHANNEL_CLOSED.message));
    }
    nextId += 1;
    const id = `e${nextId}`;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      write({ type: 'request', id, method, payload });
    });
  }

  connect();

  return {
    request,
    emit: (name, payload) => write({ type: 'event', name, payload }),
    status: () => current,
    stop() {
      stopped = true;
      if (retry !== null) clearTimeout(retry);
      retry = null;
      stopTimers();
      failPending(new RequestFailed(CHANNEL_CLOSED.code, CHANNEL_CLOSED.message));
      socket?.close();
      socket = null;
    },
  };
}

/**
 * A channel's status as a running ERP job needs it (`ChannelWatch` in `job-link.ts`): fed every status the client
 * announces (null: no client at all), it tells when the socket that was `ready` went, and when one is `ready` again.
 */
export function channelWatch() {
  let ready = false;
  const closed = new Set<() => void>();
  const waiting: Array<() => void> = [];
  return {
    status(status: ChannelStatus | null): void {
      const now = status?.state === 'ready';
      if (ready && !now) for (const listener of [...closed]) listener();
      ready = now;
      if (ready) for (const resolve of waiting.splice(0)) resolve();
    },
    onClosed(listener: () => void): () => void {
      closed.add(listener);
      return () => void closed.delete(listener);
    },
    ready: (): Promise<void> => (ready ? Promise.resolve() : new Promise((resolve) => void waiting.push(resolve))),
  };
}
