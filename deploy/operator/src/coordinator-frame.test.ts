import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { createCoordinatorInvocation, LINUX_MAX_ARG_STRLEN } from './coordinator-transport.js';

async function execute(remoteCommand: string, input: Readable) {
  const child = spawn('sh', ['-c', remoteCommand], { stdio: ['pipe', 'pipe', 'pipe'] });
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
  child.stdin.on('error', () => undefined);
  input.pipe(child.stdin);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    input.on('error', reject);
    child.on('close', resolve);
  });
  return { code, stdout: Buffer.concat(output).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8') };
}

it('executes source and requests larger than Linux argument limits without consuming trailing archive bytes', async () => {
  const source = `/*${'source padding '.repeat(15_000)}*/
const { createHash } = require('node:crypto');
const request = globalThis.__BAOX_COORDINATOR_REQUEST;
const archive = [];
process.stdin.on('data', chunk => archive.push(chunk));
process.stdin.on('end', () => console.log(JSON.stringify({
  marker: request.marker,
  requestHash: createHash('sha256').update(request.payload).digest('hex'),
  sourceHash: createHash('sha256').update(globalThis.__BAOX_COORDINATOR_SOURCE).digest('hex'),
  archiveHash: createHash('sha256').update(Buffer.concat(archive)).digest('hex'),
  archiveBytes: Buffer.concat(archive).length,
  mode: process.argv[1],
  sourceInEnvironment: Object.hasOwn(process.env, 'BAOX_COORDINATOR_SOURCE_BASE64'),
  requestInEnvironment: Object.hasOwn(process.env, 'BAOX_CANDIDATE_REQUEST_BASE64')
})));`;
  const request = { marker: "quoted ' request\n汉字", payload: '汉字'.repeat(30_000) };
  const archive = Buffer.from(Array.from({ length: 100_000 }, (_, index) => index % 256));
  const invocation = createCoordinatorInvocation({
    nodePath: process.execPath,
    mode: 'receive',
    coordinatorSource: source,
    request,
    archive: [archive.subarray(0, 1), archive.subarray(1, 123), archive.subarray(123)],
  });
  expect(Buffer.byteLength(source)).toBeGreaterThan(LINUX_MAX_ARG_STRLEN);
  expect(Buffer.byteLength(JSON.stringify(request))).toBeGreaterThan(LINUX_MAX_ARG_STRLEN);
  expect(Buffer.byteLength(invocation.remoteCommand)).toBeLessThan(16_384);
  expect(invocation.remoteCommand).not.toContain(request.marker);
  const result = await execute(invocation.remoteCommand, invocation.input);
  expect(result, result.stderr).toMatchObject({ code: 0, stderr: '' });
  expect(JSON.parse(result.stdout)).toEqual({
    marker: request.marker,
    requestHash: hash(request.payload),
    sourceHash: hash(source),
    archiveHash: hash(archive),
    archiveBytes: archive.length,
    mode: 'receive',
    sourceInEnvironment: false,
    requestInEnvironment: false,
  });
});

it('rejects a truncated request before executing the coordinator', async () => {
  const source = 'console.log("coordinator-executed");';
  const invocation = createCoordinatorInvocation({ nodePath: process.execPath, mode: 'report', coordinatorSource: source, request: { value: 'required' } });
  const chunks: Buffer[] = [];
  for await (const chunk of invocation.input) chunks.push(Buffer.from(chunk));
  const frame = Buffer.concat(chunks);
  const result = await execute(invocation.remoteCommand, Readable.from([frame.subarray(0, frame.length - 1)]));
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('invalid coordinator request');
});

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
