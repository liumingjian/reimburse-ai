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

const check = (get: typeof fetch) => checkForUpdate({ origin: ORIGIN, token: 'tok', programPath, running: sha256(OLD), runtime: '24.21.0', fetch: get });

describe('checkForUpdate', () => {
  it('does nothing when it already runs the program the app ships', async () => {
    expect(await check(server({ program: sha256(OLD), runtime: '24.21.0' }))).toEqual({ kind: 'current' });
    expect(asked).toEqual([LOCAL_EXECUTOR_RELEASE_PATH]);
  });

  it('replaces the program with the one the app ships, checked by its sha256, and asks for a restart', async () => {
    expect(await check(server({ program: sha256(NEW), runtime: '24.21.0' }))).toEqual({ kind: 'restart' });
    expect(readFileSync(programPath)).toEqual(NEW);
  });

  it('keeps the program when the bytes it got are not the ones announced', async () => {
    const result = await check(server({ program: sha256(NEW), runtime: '24.21.0' }, Buffer.from('tampered')));
    expect(result).toMatchObject({ kind: 'failed' });
    expect(readFileSync(programPath)).toEqual(OLD);
  });

  it('does not swap in a program for another runtime', async () => {
    expect(await check(server({ program: sha256(NEW), runtime: '26.0.0' }))).toEqual({ kind: 'runtime', wants: '26.0.0' });
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
