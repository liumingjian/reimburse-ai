import { timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import { MAINTENANCE_GATE_VERSION, type MaintenanceCommand, type MaintenanceGate, type MaintenanceStatus } from './maintenance';

const MAX_REQUEST_BYTES = 4096;

const RequestSchema = z.object({
  version: z.literal(MAINTENANCE_GATE_VERSION),
  command: z.enum(['status', 'admit', 'reopen']),
  token: z.string().min(1),
});

export type MaintenanceControl = { path: string; close: () => Promise<void> };

export function maintenanceSocketPath(dataDir: string): string {
  return join(dataDir, 'maintenance-gate.sock');
}

// The token is kept out of command arguments and operator output. The wrapper on the host reads this same file only
// long enough to make a Unix-socket request.
export function readMaintenanceToken(path: string): string {
  let value: string;
  try {
    value = readFileSync(path, 'utf8').trim();
  } catch {
    throw new Error('cannot read the maintenance control credential');
  }
  if (!/^[A-Za-z0-9_-]{32,}$/.test(value)) throw new Error('the maintenance control credential is invalid');
  return value;
}

function sameToken(actual: string, supplied: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(supplied);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

const unavailable = (reason: string) => ({
  version: MAINTENANCE_GATE_VERSION,
  state: 'unknown' as const,
  barrier: true,
  activeWrites: 'unknown' as const,
  activeErpAttempt: 'unknown' as const,
  reason,
});

function respond(socket: Socket, body: MaintenanceStatus | ReturnType<typeof unavailable>): void {
  socket.end(`${JSON.stringify(body)}\n`);
}

function removeStaleSocket(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isSocket()) throw new Error(`maintenance control path is not a socket: ${path}`);
  unlinkSync(path);
}

export async function startMaintenanceControl({ gate, path, token }: { gate: MaintenanceGate; path: string; token: string }): Promise<MaintenanceControl> {
  removeStaleSocket(path);
  const server = createServer((socket) => {
    let buffer = '';
    let handled = false;
    socket.setTimeout(5_000, () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        handled = true;
        respond(socket, unavailable('invalid_request'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      void handle(buffer.slice(0, newline));
    });

    async function handle(raw: string): Promise<void> {
      let parsed: z.infer<typeof RequestSchema>;
      try {
        const value = RequestSchema.safeParse(JSON.parse(raw) as unknown);
        if (!value.success) return respond(socket, unavailable('invalid_request'));
        parsed = value.data;
      } catch {
        return respond(socket, unavailable('invalid_request'));
      }
      if (!sameToken(token, parsed.token)) return respond(socket, unavailable('unauthorized'));
      try {
        const status = await command(gate, parsed.command);
        respond(socket, status);
      } catch {
        respond(socket, unavailable('unknown_write_state'));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once('error', failed);
    server.listen(path, () => {
      server.off('error', failed);
      resolve();
    });
  });
  chmodSync(path, 0o600);

  return {
    path,
    async close() {
      await closeServer(server);
      if (existsSync(path) && lstatSync(path).isSocket()) unlinkSync(path);
    },
  };
}

async function command(gate: MaintenanceGate, value: MaintenanceCommand): Promise<MaintenanceStatus> {
  if (value === 'status') {
    await gate.ready;
    return gate.status();
  }
  return value === 'admit' ? gate.admit() : gate.reopen();
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
