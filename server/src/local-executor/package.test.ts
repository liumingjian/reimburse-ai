import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { EXTENSION_PAIR_PATH, EXTENSION_VERSION, ExtensionPairingSchema, ExtensionTokenSchema, LOCAL_EXECUTOR_CONFIG_FILE, LOCAL_EXECUTOR_DOWNLOAD_ERRORS, LOCAL_EXECUTOR_DOWNLOAD_PATH, LOCAL_EXECUTOR_PROGRAM_PATH, LOCAL_EXECUTOR_RELEASE_PATH, LocalExecutorReleaseSchema } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestClient, type TestServer } from '../test/harness';
import type { LocalExecutorDist } from './package';

// The 本地执行器's distribution (ADR-0035) at the HTTP seam: the settings page's zip, opened the way unzip tools open it,
// and the two answers an installed executor asks for to keep itself current.

const ORIGIN = 'http://127.0.0.1:4319';
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

type Member = { data: Buffer; mode: number };
// Reads a zip through its central directory, as unzip tools do, and checks every member's checksum on the way.
function unzip(bytes: Buffer): Map<string, Member> {
  const members = new Map<string, Member>();
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i += 1) {
    const method = bytes.readUInt16LE(at + 10);
    const crc = bytes.readUInt32LE(at + 16);
    const size = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const mode = bytes.readUInt32LE(at + 38) >>> 16;
    const offset = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    const data = bytes.subarray(start, start + size);
    expect(method, name).toBe(0);
    expect(crc32(data) >>> 0, name).toBe(crc);
    members.set(name, { data, mode });
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return members;
}

const download = async (platform: string) => alice.request(`${ORIGIN}${LOCAL_EXECUTOR_DOWNLOAD_PATH}?platform=${platform}`);

async function pairedToken(): Promise<string> {
  const issued = ExtensionPairingSchema.parse(await (await alice.post('/api/extension/pairing/code', {})).json());
  const redeemed = await server.app.request(EXTENSION_PAIR_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'chrome-extension://kmbhfnaoapecjdgphfnbkejnnojfeeih' },
    body: JSON.stringify({ code: issued.code, browser: 'baox 本地执行器（darwin）', version: EXTENSION_VERSION, holder: 'local_executor' }),
  });
  return ExtensionTokenSchema.parse(await redeemed.json()).token;
}

describe('the 本地执行器 download', () => {
  it('hands out a Windows zip: the runtime, the program, the app\'s address and a launcher, all under one folder', async () => {
    const answer = await download('win-x64');
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-disposition')).toContain('baox-local-executor-win-x64.zip');
    const members = unzip(Buffer.from(await answer.arrayBuffer()));
    expect([...members.keys()].sort()).toEqual([
      'baox-local-executor/baox-config.json', 'baox-local-executor/baox-local-executor.mjs', 'baox-local-executor/runtime/node.exe', 'baox-local-executor/start-baox.cmd',
    ]);
    expect(JSON.parse(members.get(`baox-local-executor/${LOCAL_EXECUTOR_CONFIG_FILE}`)!.data.toString('utf8'))).toEqual({ origin: ORIGIN, platform: 'win-x64' });
    expect(members.get('baox-local-executor/runtime/node.exe')!.data.toString('utf8')).toBe('runtime for win-x64');
    const launcher = members.get('baox-local-executor/start-baox.cmd')!.data.toString('utf8');
    expect(launcher).toContain('setup');
    expect(launcher).toMatch(/^[\x00-\x7f]*$/);
    expect(launcher).toContain('\r\n');
  });

  it('keeps the Mac runtime and launcher executable', async () => {
    const members = unzip(Buffer.from(await (await download('darwin-arm64')).arrayBuffer()));
    expect(members.get('baox-local-executor/runtime/node')!.data.toString('utf8')).toBe('runtime for darwin-arm64');
    expect(members.get('baox-local-executor/runtime/node')!.mode & 0o777).toBe(0o755);
    expect(members.get('baox-local-executor/start-baox.command')!.mode & 0o777).toBe(0o755);
    expect(members.get('baox-local-executor/baox-local-executor.mjs')!.mode & 0o777).toBe(0o644);
  });

  it('opens with the system unzip, where there is one', async () => {
    const zip = join(workDir, 'download.zip');
    writeFileSync(zip, Buffer.from(await (await download('darwin-x64')).arrayBuffer()));
    let tested: string;
    try {
      tested = execFileSync('unzip', ['-t', zip], { encoding: 'utf8' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    expect(tested).toContain('No errors detected');
  });

  it('is behind the login, and asks for a platform it knows', async () => {
    expect((await server.app.request(`${LOCAL_EXECUTOR_DOWNLOAD_PATH}?platform=win-x64`)).status).toBe(401);
    const answer = await download('linux-x64');
    expect(answer.status).toBe(400);
    expect(await answer.json()).toMatchObject({ error: { message: LOCAL_EXECUTOR_DOWNLOAD_ERRORS.platform } });
  });

  it('says so, rather than serve half a package, when the runtime was never fetched', async () => {
    rmSync(join(dist.runtimes, '24.21.0', 'win-x64'), { recursive: true });
    const answer = await download('win-x64');
    expect(answer.status).toBe(503);
    expect(await answer.json()).toMatchObject({ error: { message: LOCAL_EXECUTOR_DOWNLOAD_ERRORS.unavailable } });
  });

  it('serves the new program once it is rebuilt, not the zip assembled before', async () => {
    unzip(Buffer.from(await (await download('win-x64')).arrayBuffer()));
    writeFileSync(dist.program, 'console.log("baox 2");\n');
    const members = unzip(Buffer.from(await (await download('win-x64')).arrayBuffer()));
    expect(members.get('baox-local-executor/baox-local-executor.mjs')!.data.toString('utf8')).toContain('baox 2');
  });
});

describe('what an installed 本地执行器 asks to keep current', () => {
  it('tells a paired executor the program\'s sha256 and the runtime, and serves the program', async () => {
    const token = await pairedToken();
    const headers = { authorization: `Bearer ${token}` };
    const release = LocalExecutorReleaseSchema.parse(await (await server.app.request(LOCAL_EXECUTOR_RELEASE_PATH, { headers })).json());
    expect(release).toEqual({ program: createHash('sha256').update(readFileSync(dist.program)).digest('hex'), runtime: '24.21.0' });
    const program = await server.app.request(LOCAL_EXECUTOR_PROGRAM_PATH, { headers });
    expect(Buffer.from(await program.arrayBuffer()).equals(readFileSync(dist.program))).toBe(true);
  });

  it('answers nobody without a pairing', async () => {
    expect((await server.app.request(LOCAL_EXECUTOR_RELEASE_PATH)).status).toBe(401);
    expect((await server.app.request(LOCAL_EXECUTOR_PROGRAM_PATH, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
  });
});
