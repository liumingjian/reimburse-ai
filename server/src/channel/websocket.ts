import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { CHANNEL_PATH } from '@baox/contract';
import { WebSocketServer, type WebSocket } from 'ws';
import { admitsHost, type PublicOrigin } from '../public-origin';
import type { ExecutorHub } from './channel';

// Structural, so both what `@hono/node-server` returns and a bare `http.Server` fit without a cast.
export type UpgradeHost = {
  on(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
  off(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
};

// The only WebSocket server in the app, and the only thing here that knows about sockets at all: it turns an upgrade
// request into the `ChannelSocket` that `channel.ts` speaks to, and nothing else.
//
// `noServer: true` because Hono answers the HTTP requests and this answers the upgrades; one listening socket, two
// protocols. Because an upgrade never reaches Hono, it never meets the Host guard in `app.ts` either, so the same
// predicate (`admitsHost`, `public-origin.ts`) is applied here, before the handshake: a name rebound onto this
// machine gets a 403 at this door exactly as it does at the other one (story 32).
//
// There is deliberately no Origin check. The 本地执行器 is no page of the app's origin (it sends whatever Origin its
// runtime sends, or none), which the exact-origin check could never admit — the same reasoning as the 配对码
// redemption in `app.ts` — and the channel reads no cookie: the 配对凭据 in the first frame (`channel.ts`) is its
// whole authority.
export function attachExecutorHub(server: UpgradeHost, channel: ExecutorHub, publicOrigin: PublicOrigin | null): () => void {
  const sockets = new WebSocketServer({ noServer: true });

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // `request.url` is a path here, never absolute; the base only makes it parseable.
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== CHANNEL_PATH) {
      socket.destroy();
      return;
    }
    // HTTP/1.1 requires Host, so a request without one is refused like a foreign one.
    if (!admitsHost(publicOrigin, request.headers.host ?? '')) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      const session = channel.open({
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
      });
      ws.on('message', (data: unknown) => void session.message(String(data)));
      ws.on('close', () => session.closed());
      // A transport error ends the connection the same way a close does; `closed` is idempotent.
      ws.on('error', () => session.closed());
    });
  };

  server.on('upgrade', upgrade);
  return () => {
    server.off('upgrade', upgrade);
    sockets.close();
  };
}
