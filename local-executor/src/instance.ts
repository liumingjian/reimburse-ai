// One 本地执行器 per PC: a second copy (the login's autostart next to one started by `setup`, say) would hold a second
// channel, and the two would take the account's pairing from each other. The first one listens on a fixed loopback
// port; a later one that cannot get the port leaves. The system frees the port when the holder dies, however it dies,
// so a crash can never leave a stale claim behind (a pid file can: Windows reuses pids freely). Nothing is served on
// the port: connections are closed as they arrive.

import { createServer, type Server } from 'node:net';

export const INSTANCE_PORT = 47319;

/** Claim the PC's single executor slot; null when another live process holds it. */
export function claimInstance(port: number = INSTANCE_PORT): Promise<{ release(): void } | null> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((socket) => socket.destroy());
    server.once('error', (error: NodeJS.ErrnoException) => (error.code === 'EADDRINUSE' ? resolve(null) : reject(error)));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.unref();
      resolve({ release: () => server.close() });
    });
  });
}
