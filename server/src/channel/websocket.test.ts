import { randomBytes } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CHANNEL_PATH } from '@baox/contract';
import { parsePublicOrigin } from '../public-origin';
import { createTestServer, type TestServer } from '../test/harness';
import { attachClientChannel } from './websocket';

// The upgrade seam. An upgrade never reaches Hono, so the Host guard in `app.ts` never sees it; this is the one test
// that has to open a real loopback socket, because what is under test is the handshake itself. The request is
// written by hand so it can carry a Host that is not the address it was sent to — which is what DNS rebinding does.

const INTRANET = 'http://10.250.0.222';

let app: TestServer;
let http: Server;
let detach: () => void;

async function listen(publicOrigin: string | null): Promise<number> {
  app = await createTestServer(publicOrigin ? { publicOrigin } : {});
  http = createServer((_request, response) => response.end());
  detach = attachClientChannel(http, app.app.clientChannel, publicOrigin ? parsePublicOrigin(publicOrigin) : null);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return (http.address() as AddressInfo).port;
}

afterEach(async () => {
  detach();
  http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  await app.close();
});

// 101 when the handshake is accepted, otherwise the status the server refused it with.
function upgrade(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const sent = request({
      host: '127.0.0.1',
      port,
      path: CHANNEL_PATH,
      headers: { host, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64') },
    });
    sent.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    sent.on('response', (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    sent.on('error', reject);
    sent.end();
  });
}

describe('the channel upgrade answers only to the address the app is served at (story 32)', () => {
  it('admits the configured host and refuses a name rebound onto this machine', async () => {
    const port = await listen(INTRANET);

    expect(await upgrade(port, '10.250.0.222')).toBe(101);
    expect(await upgrade(port, 'evil.example.com')).toBe(403);
    // With a public origin configured, the loopback name is just another name, as it is for the Hono guard.
    expect(await upgrade(port, `127.0.0.1:${port}`)).toBe(403);
  });

  it('admits only loopback names when no public origin is configured', async () => {
    const port = await listen(null);

    expect(await upgrade(port, `127.0.0.1:${port}`)).toBe(101);
    expect(await upgrade(port, `localhost:${port}`)).toBe(101);
    expect(await upgrade(port, 'evil.example.com')).toBe(403);
  });
});
