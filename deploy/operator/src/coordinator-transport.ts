import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';

export const LINUX_MAX_ARG_STRLEN = 128 * 1024;
export const MAX_COORDINATOR_FRAME_FIELD_BYTES = 1024 * 1024;

export type CoordinatorArchive = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

export type CoordinatorInvocation = Readonly<{
  remoteCommand: string;
  input: Readable;
}>;

export type CoordinatorInvocationOptions = Readonly<{
  nodePath: string;
  mode: string;
  coordinatorSource: string;
  request: unknown;
  archive?: CoordinatorArchive;
}>;

export type CoordinatorCommandResult = Readonly<{
  stdout: string;
  exitCode: number | null;
}>;

export type CoordinatorResponseOptions<T> = Readonly<{
  isResponse: (value: unknown) => value is T;
  malformedMessage: (exitCode: number | null) => string;
  exitMessage: (exitCode: number | null) => string;
  allowsNonzeroExit?: (response: T) => boolean;
  rejectNonzeroBeforeParsing?: boolean;
}>;

const FRAME_MAGIC = 'BCO1';

/**
 * This is the complete remote command payload. Coordinator source and request
 * bytes deliberately travel only on stdin, ahead of an optional source archive.
 */
export const COORDINATOR_LOADER = String.raw`'use strict';
const fs = require('node:fs');
const Module = require('node:module');
const frameLimit = 1024 * 1024;
function readExactly(length) {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const received = fs.readSync(0, buffer, offset, length - offset, null);
    if (received === 0) throw new Error('truncated coordinator frame');
    offset += received;
  }
  return buffer;
}
const header = readExactly(12);
if (header.subarray(0, 4).toString('ascii') !== 'BCO1') throw new Error('invalid coordinator frame');
const sourceLength = header.readUInt32BE(4);
const requestLength = header.readUInt32BE(8);
if (sourceLength === 0 || sourceLength > frameLimit || requestLength === 0 || requestLength > frameLimit) {
  throw new Error('invalid coordinator frame length');
}
const source = readExactly(sourceLength).toString('utf8');
let request;
try {
  request = JSON.parse(readExactly(requestLength).toString('utf8'));
} catch {
  throw new Error('invalid coordinator request');
}
globalThis.__BAOX_COORDINATOR_SOURCE = source;
globalThis.__BAOX_COORDINATOR_REQUEST = request;
const coordinator = new Module('baox-coordinator.cjs', module);
coordinator.filename = 'baox-coordinator.cjs';
coordinator.paths = module.paths;
coordinator._compile(source, coordinator.filename);
`;

export function createCoordinatorInvocation(options: CoordinatorInvocationOptions): CoordinatorInvocation {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(options.mode)) throw new Error('invalid coordinator mode');

  const source = Buffer.from(options.coordinatorSource, 'utf8');
  if (source.length === 0 || source.length > MAX_COORDINATOR_FRAME_FIELD_BYTES) {
    throw new Error('invalid coordinator source length');
  }

  let request: Buffer;
  try {
    const serialized = JSON.stringify(options.request);
    if (serialized === undefined) throw new Error('undefined request');
    request = Buffer.from(serialized, 'utf8');
  } catch {
    throw new Error('invalid coordinator request');
  }
  if (request.length === 0 || request.length > MAX_COORDINATOR_FRAME_FIELD_BYTES) {
    throw new Error('invalid coordinator request length');
  }

  const script = coordinatorLoaderCommand(options.nodePath, options.mode);
  const remoteCommand = `sh -c ${shellQuote(script)}`;
  assertLinuxArgumentBounds([options.nodePath, options.mode, COORDINATOR_LOADER, script, remoteCommand]);

  return {
    remoteCommand,
    input: Readable.from(frame(source, request, options.archive)),
  };
}

/** Reads the target-side implementation once, without putting it in argv or env. */
export function readCoordinatorSource(): string {
  return readFileSync(new URL('./candidate-coordinator.cjs', import.meta.url), 'utf8');
}

/**
 * Extracts the final coordinator JSON record while preserving each operation's
 * response schema and user-facing failure semantics.
 */
export function parseCoordinatorResponse<T>(result: CoordinatorCommandResult, options: CoordinatorResponseOptions<T>): T {
  if (result.exitCode !== 0 && options.rejectNonzeroBeforeParsing) {
    throw new Error(options.exitMessage(result.exitCode));
  }
  const parsed = lastJson(result.stdout);
  if (!options.isResponse(parsed)) throw new Error(options.malformedMessage(result.exitCode));
  if (result.exitCode !== 0 && !options.allowsNonzeroExit?.(parsed)) {
    throw new Error(options.exitMessage(result.exitCode));
  }
  return parsed;
}

export function coordinatorLoaderCommand(nodePath: string, mode: string): string {
  return `set -eu\nexec ${shellQuote(nodePath)} -e ${shellQuote(COORDINATOR_LOADER)} -- ${shellQuote(mode)}`;
}

export function assertLinuxArgumentBounds(fields: readonly string[]): void {
  for (const field of fields) {
    if (Buffer.byteLength(field, 'utf8') >= LINUX_MAX_ARG_STRLEN) {
      throw new Error('coordinator transport exceeds Linux MAX_ARG_STRLEN');
    }
  }
}

async function* frame(source: Buffer, request: Buffer, archive: CoordinatorArchive | undefined): AsyncGenerator<Buffer> {
  const header = Buffer.alloc(12);
  header.write(FRAME_MAGIC, 0, 'ascii');
  header.writeUInt32BE(source.length, 4);
  header.writeUInt32BE(request.length, 8);
  yield header;
  yield source;
  yield request;
  if (!archive) return;
  for await (const chunk of archive) yield Buffer.from(chunk);
}

function lastJson(stdout: string): unknown {
  const line = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
