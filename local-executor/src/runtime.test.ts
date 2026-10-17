// Which Node the 本地执行器 runs on (ADR-0035, #424): the employee's own Node of the server's major version, on macOS
// only with Node's official signature; otherwise the runtime downloaded from the app server, fetched and checked by
// its sha256 when it is not there.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localExecutorRuntimePath, localExecutorRuntimeSha256Path } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chooseNode, cleanEnv, nodeProbe, type NodeProbe } from './runtime';
import { sha256 } from './update';

const ORIGIN = 'https://10.250.0.222:8443';
const RUNTIME = Buffer.from('the server runtime');
let dir: string;
let downloaded: string;
let asked: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'baox-runtime-'));
  downloaded = join(dir, 'app', 'runtime', 'node');
  asked = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const server = (bytes: Uint8Array<ArrayBuffer> = RUNTIME, sum = sha256(RUNTIME)): typeof fetch => (async (input: string | URL | Request) => {
  const url = String(input).slice(ORIGIN.length);
  asked.push(url);
  if (url === localExecutorRuntimeSha256Path('darwin-arm64')) return new Response(`${sum}\n`);
  if (url === localExecutorRuntimePath('darwin-arm64')) return new Response(bytes);
  return new Response(null, { status: 404 });
}) as typeof fetch;

/** Nodes by path: their version and whether they carry Node's signature. A path not listed does not exist. */
const machine = (nodes: Record<string, { version: string; signed?: boolean }>): NodeProbe => ({
  exists: (path) => path in nodes || existsSync(path),
  version: (path) => nodes[path]?.version ?? (existsSync(path) ? 'v24.21.0' : null),
  signed: (path) => nodes[path]?.signed ?? false,
});

const choose = (recorded: string | undefined, probe: NodeProbe, platform: NodeJS.Platform = 'darwin', get = server()) => chooseNode({
  recorded, downloaded, platform, major: 24, probe, userHome: dir,
  runtime: { origin: ORIGIN, platform: 'darwin-arm64', fetch: get },
});

describe('choosing a Node', () => {
  const own = '/opt/homebrew/bin/node';

  it('keeps the employee\'s own Node 24, signed by Node.js, and downloads nothing', async () => {
    expect(await choose(own, machine({ [own]: { version: 'v24.3.0', signed: true } }))).toEqual({ path: own, switched: false });
    expect(asked).toEqual([]);
  });

  it('refuses another major version and switches to the downloaded runtime, fetching it', async () => {
    const chosen = await choose(own, machine({ [own]: { version: 'v26.1.0', signed: true } }));
    expect(chosen).toMatchObject({ path: downloaded, switched: true });
    expect(readFileSync(downloaded)).toEqual(RUNTIME);
    expect(asked).toEqual([localExecutorRuntimePath('darwin-arm64'), localExecutorRuntimeSha256Path('darwin-arm64')]);
  });

  it('refuses an unsigned Node on macOS', async () => {
    expect(await choose(own, machine({ [own]: { version: 'v24.3.0', signed: false } }))).toMatchObject({ path: downloaded, switched: true });
  });

  it('checks only the version on Windows', async () => {
    const mine = 'C:\\Program Files\\nodejs\\node.exe';
    expect(await choose(mine, machine({ [mine]: { version: 'v24.3.0', signed: false } }), 'win32')).toEqual({ path: mine, switched: false });
  });

  it('switches to the downloaded runtime when the recorded Node is gone', async () => {
    expect(await choose('/Users/zhang/.nvm/versions/node/v24.3.0/bin/node', machine({}))).toMatchObject({ path: downloaded, switched: true });
    expect(readFileSync(downloaded)).toEqual(RUNTIME);
  });

  it('uses the downloaded runtime already there without fetching it again', async () => {
    mkdirSync(join(dir, 'app', 'runtime'), { recursive: true });
    writeFileSync(downloaded, 'already here');
    expect(await choose(own, machine({}))).toMatchObject({ path: downloaded, switched: true });
    expect(asked).toEqual([]);
    expect(await choose(downloaded, machine({}))).toEqual({ path: downloaded, switched: false });
  });

  it('fetches the runtime again when the one there is of another major version', async () => {
    mkdirSync(join(dir, 'app', 'runtime'), { recursive: true });
    writeFileSync(downloaded, 'old runtime');
    expect(await choose(downloaded, machine({ [downloaded]: { version: 'v22.9.0' } }))).toMatchObject({ path: downloaded });
    expect(readFileSync(downloaded)).toEqual(RUNTIME);
  });

  it('keeps nothing of a download whose sha256 is not the one the server names', async () => {
    await expect(choose(own, machine({}), 'darwin', server(Buffer.from('cut off')))).rejects.toThrow();
    expect(existsSync(downloaded)).toBe(false);
    expect(existsSync(`${downloaded}.part`)).toBe(false);
  });

  it('takes a zip install, which recorded nothing, to run on the runtime beside it', async () => {
    mkdirSync(join(dir, 'app', 'runtime'), { recursive: true });
    writeFileSync(downloaded, 'zip runtime');
    expect(await choose(undefined, machine({}))).toEqual({ path: downloaded, switched: false });
  });

  it('on macOS, the real check takes this signed Node and turns an unsigned one away', { skip: process.platform !== 'darwin' }, () => {
    const probe = nodeProbe();
    expect(probe.signed(process.execPath)).toBe(true);
    const stub = join(dir, 'node');
    writeFileSync(stub, '#!/bin/sh\necho v24.21.0\n');
    chmodSync(stub, 0o755);
    expect(probe.version(stub)).toBe('v24.21.0');
    expect(probe.signed(stub)).toBe(false);
  });
});

describe('the environment it runs in', () => {
  it('has none of the variables that make Node load extra code or trust another certificate', () => {
    const env = cleanEnv({ HOME: '/Users/zhang', PATH: '/usr/bin', NODE_OPTIONS: '--require /tmp/evil.js', NODE_PATH: '/tmp', DYLD_INSERT_LIBRARIES: '/tmp/x.dylib', LD_PRELOAD: '/tmp/x.so', NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_EXTRA_CA_CERTS: '/tmp/ca.pem', NODE_REPL_EXTERNAL_MODULE: '/tmp/r.js' });
    expect(env).toEqual({ HOME: '/Users/zhang', PATH: '/usr/bin' });
  });
});
