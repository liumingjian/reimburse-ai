// One 本地执行器 per PC: a second copy (the login's autostart next to one started by `setup`, say) would hold a second
// channel, and the two would take the account's pairing from each other. The first one listens on a fixed loopback
// port; a later one that cannot get the port leaves. The system frees the port when the holder dies, however it dies,
// so a crash can never leave a stale claim behind (a pid file can: Windows reuses pids freely).
//
// The same listener serves the pairing endpoint (`./pairing-port`, ADR-0035 amended 2026-10-16). It keeps the process
// alive: an executor whose pairing is gone has nothing else to run, and waits here for a new 配对码. Without a
// listener every connection is refused as it arrives.

import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LOCAL_EXECUTOR_PORT } from '@baox/contract';

export const INSTANCE_PORT = LOCAL_EXECUTOR_PORT;

export type Instance = { release(): void; address(): AddressInfo };

/** Claim the PC's single executor slot; null when another live process holds it. `port` 0 is for tests. */
export function claimInstance(port: number = INSTANCE_PORT, listener?: RequestListener): Promise<Instance | null> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(listener ?? ((_, response) => { response.statusCode = 404; response.end(); }));
    server.once('error', (error: NodeJS.ErrnoException) => (error.code === 'EADDRINUSE' ? resolve(null) : reject(error)));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      resolve({
        release: () => { server.close(); server.closeAllConnections(); },
        address: () => server.address() as AddressInfo,
      });
    });
  });
}
