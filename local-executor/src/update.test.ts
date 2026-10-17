// The 本地执行器 keeps itself on the program its server ships (ADR-0035): what it does for each answer.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_EXECUTOR_PROGRAM_PATH, LOCAL_EXECUTOR_RELEASE_PATH } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkForUpdate, sha256 } from './update';

const ORIGIN = 'http://10.250.0.222';
const OLD = Buffer.from('old program');
const NEW = Buffer.from('new program');
let dir: string;
let programPath: string;
let asked: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'baox-update-'));
  programPath = join(dir, 'baox-local-executor.mjs');
  writeFileSync(programPath, OLD);
  asked = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const server = (release: unknown, program: Uint8Array<ArrayBuffer> = NEW): typeof fetch => (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  asked.push(url.slice(ORIGIN.length));
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok');
  if (url.endsWith(LOCAL_EXECUTOR_RELEASE_PATH)) return Response.json(release);
  if (url.endsWith(LOCAL_EXECUTOR_PROGRAM_PATH)) return new Response(program);
  return new Response(null, { status: 404 });
}) as typeof fetch;

const OWN_NODE = '/opt/homebrew/bin/node';
const DOWNLOADED = '/Users/zhang/.baox/local-executor/app/runtime/node';
let checkedUnder: string[];
let downloads: string[];
beforeEach(() => { checkedUnder = []; downloads = []; });
const check = (get: typeof fetch, starts = true) => checkForUpdate({
  origin: ORIGIN, token: 'tok', programPath, running: sha256(OLD), runtime: '24.21.0', node: OWN_NODE, fetch: get,
  selfCheck: (_path, node) => { checkedUnder.push(node); return starts; },
  downloadedRuntime: async (major) => { downloads.push(String(major)); return DOWNLOADED; },
});

describe('checkForUpdate', () => {
  it('does nothing when it already runs the program the app ships', async () => {
    expect(await check(server({ program: sha256(OLD), runtime: '24.21.0' }))).toEqual({ kind: 'current' });
    expect(asked).toEqual([LOCAL_EXECUTOR_RELEASE_PATH]);
  });

  it('replaces the program with the one the app ships, checked by its sha256, and asks for a restart', async () => {
    expect(await check(server({ program: sha256(NEW), runtime: '24.21.0' }))).toEqual({ kind: 'restart' });
    expect(readFileSync(programPath)).toEqual(NEW);
  });

  it('keeps the program, and the old one beside it, when the new one does not start here', async () => {
    const result = await check(server({ program: sha256(NEW), runtime: '24.21.0' }), false);
    expect(result).toMatchObject({ kind: 'failed' });
    expect(readFileSync(programPath)).toEqual(OLD);
  });

  it('keeps the previous program beside the new one', async () => {
    await check(server({ program: sha256(NEW), runtime: '24.21.0' }));
    expect(readFileSync(`${programPath}.prev`)).toEqual(OLD);
  });

  it('keeps the program when the bytes it got are not the ones announced', async () => {
    const result = await check(server({ program: sha256(NEW), runtime: '24.21.0' }, Buffer.from('tampered')));
    expect(result).toMatchObject({ kind: 'failed' });
    expect(readFileSync(programPath)).toEqual(OLD);
  });

  it('ignores a change of the server\'s Node minor version', async () => {
    expect(await check(server({ program: sha256(OLD), runtime: '24.30.1' }))).toEqual({ kind: 'current' });
    expect(await check(server({ program: sha256(NEW), runtime: '24.30.1' }))).toEqual({ kind: 'restart' });
    expect(checkedUnder).toEqual([OWN_NODE]);
    expect(downloads).toEqual([]);
  });

  it('on a change of major version, switches to the downloaded runtime and checks the new program under it', async () => {
    expect(await check(server({ program: sha256(NEW), runtime: '26.0.0' }))).toEqual({ kind: 'restart', node: DOWNLOADED });
    expect(downloads).toEqual(['26']);
    expect(checkedUnder).toEqual([DOWNLOADED]);
    expect(readFileSync(programPath)).toEqual(NEW);
  });

  it('switches the runtime even when the program stays the same', async () => {
    expect(await check(server({ program: sha256(OLD), runtime: '26.0.0' }))).toEqual({ kind: 'restart', node: DOWNLOADED });
  });

  it('stays on its Node and its program when the new runtime cannot be fetched', async () => {
    const result = await checkForUpdate({
      origin: ORIGIN, token: 'tok', programPath, running: sha256(OLD), runtime: '24.21.0', node: OWN_NODE,
      fetch: server({ program: sha256(NEW), runtime: '26.0.0' }), selfCheck: () => true,
      downloadedRuntime: async () => { throw new Error('connect ECONNREFUSED'); },
    });
    expect(result).toEqual({ kind: 'failed', reason: 'connect ECONNREFUSED' });
    expect(readFileSync(programPath)).toEqual(OLD);
  });

  it('only restarts when the new program is already on disk (installed while it ran)', async () => {
    writeFileSync(programPath, NEW);
    expect(await check(server({ program: sha256(NEW), runtime: '24.21.0' }))).toEqual({ kind: 'restart' });
    expect(asked).toEqual([LOCAL_EXECUTOR_RELEASE_PATH]);
  });

  it('carries on with what it has when the app does not answer', async () => {
    const down = (async () => { throw new Error('connect ECONNREFUSED'); }) as typeof fetch;
    expect(await check(down)).toEqual({ kind: 'failed', reason: 'connect ECONNREFUSED' });
    expect(readFileSync(programPath)).toEqual(OLD);
  });
});
