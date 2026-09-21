import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { EXTENSION_CHANNEL_PATH } from '@baox/contract';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ExtensionChannel } from './channel';

// Structural, so both what `@hono/node-server` returns and a bare `http.Server` fit without a cast.
export type UpgradeHost = {
  on(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
  off(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
};

// The only WebSocket server in the app, and the only thing here that knows about sockets at all: it turns an upgrade
// request into the `ChannelSocket` that `channel.ts` speaks to, and nothing else.
//
// `noServer: true` because Hono answers the HTTP requests and this answers the upgrades; one listening socket, two
// protocols. The path is checked here rather than in the route table for the same reason — an upgrade never reaches
// Hono.
//
// Nothing is authorised at this point. The 配对凭据 arrives in the first message (`channel.ts`), so the upgrade
// itself carries no credential to check: an unpaired socket is admitted, says something that is not a valid `hello`
// or resolves to no pairing, and is closed. It reads nothing and writes nothing in between.
export function attachExtensionChannel(server: UpgradeHost, channel: ExtensionChannel): () => void {
  const sockets = new WebSocketServer({ noServer: true });

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // `request.url` is a path here, never absolute; the base only makes it parseable.
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== EXTENSION_CHANNEL_PATH) {
      socket.destroy();
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
