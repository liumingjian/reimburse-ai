import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXTENSION_PAIR_PATH, EXTENSION_VERSION, ExtensionPairingSchema, ExtensionTokenSchema, LOCAL_EXECUTOR_PROGRAM_PATH, LOCAL_EXECUTOR_RELEASE_ERRORS, LOCAL_EXECUTOR_RELEASE_PATH, LocalExecutorReleaseSchema } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestClient, type TestServer } from '../test/harness';
import type { LocalExecutorDist } from './release';

// What an installed 本地执行器 asks for to keep itself current (ADR-0035), at the HTTP seam. The install script's own
// routes are `install.test.ts` and `runtime.test.ts`.

let workDir: string;
let dist: LocalExecutorDist;
let server: TestServer;
let alice: TestClient;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'baox-local-executor-'));
  dist = { program: join(workDir, 'dist', 'baox-local-executor.mjs'), runtimes: join(workDir, 'runtime') };
  mkdirSync(join(workDir, 'dist'), { recursive: true });
  writeFileSync(dist.program, 'console.log("baox");\n');
  for (const [platform, binary] of [['win-x64', 'node.exe'], ['darwin-arm64', 'node'], ['darwin-x64', 'node']] as const) {
    mkdirSync(join(dist.runtimes, '24.21.0', platform), { recursive: true });
    writeFileSync(join(dist.runtimes, '24.21.0', platform, binary), `runtime for ${platform}`);
  }
  writeFileSync(join(dist.runtimes, 'VERSION'), '24.21.0\n');
  server = await createTestServer({ localExecutor: dist });
  alice = await server.signIn('alice');
});
afterEach(async () => {
  await server.close();
  rmSync(workDir, { recursive: true, force: true });
});

async function pairedToken(): Promise<string> {
  const issued = ExtensionPairingSchema.parse(await (await alice.post('/api/extension/pairing/code', {})).json());
  const redeemed = await server.app.request(EXTENSION_PAIR_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'chrome-extension://kmbhfnaoapecjdgphfnbkejnnojfeeih' },
    body: JSON.stringify({ code: issued.code, browser: 'baox 本地执行器（darwin）', version: EXTENSION_VERSION, holder: 'local_executor' }),
  });
  return ExtensionTokenSchema.parse(await redeemed.json()).token;
}

describe('what an installed 本地执行器 asks to keep current', () => {
  it('tells a paired executor the program\'s sha256 and the runtime, and serves the program', async () => {
    const token = await pairedToken();
    const headers = { authorization: `Bearer ${token}` };
    const release = LocalExecutorReleaseSchema.parse(await (await server.app.request(LOCAL_EXECUTOR_RELEASE_PATH, { headers })).json());
    expect(release).toEqual({ program: createHash('sha256').update(readFileSync(dist.program)).digest('hex'), runtime: '24.21.0' });
    const program = await server.app.request(LOCAL_EXECUTOR_PROGRAM_PATH, { headers });
    expect(Buffer.from(await program.arrayBuffer()).equals(readFileSync(dist.program))).toBe(true);
  });

  it('says the server has nothing to ship when the program was never built', async () => {
    const token = await pairedToken();
    rmSync(dist.program);
    const answer = await server.app.request(LOCAL_EXECUTOR_RELEASE_PATH, { headers: { authorization: `Bearer ${token}` } });
    expect(answer.status).toBe(503);
    expect(await answer.json()).toMatchObject({ error: { message: LOCAL_EXECUTOR_RELEASE_ERRORS.unavailable } });
  });

  it('answers nobody without a pairing', async () => {
    expect((await server.app.request(LOCAL_EXECUTOR_RELEASE_PATH)).status).toBe(401);
    expect((await server.app.request(LOCAL_EXECUTOR_PROGRAM_PATH, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
  });
});
