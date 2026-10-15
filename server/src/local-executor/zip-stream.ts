import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { crc32 } from 'node:zlib';

// A zip written to disk without holding its members in memory: the 本地执行器's zips carry a Node runtime of ~100 MB,
// and this host has little memory to spare. Members are stored, not deflated (the runtime barely compresses, and the
// intranet is fast), each checksummed in a first pass over its file so its header can be written ahead of it. Unix
// modes go into the central directory, so macOS's Archive Utility keeps the runtime and the launcher executable;
// Windows ignores them. No zip64: every member and the whole zip stay far below 4 GiB.

export type StreamEntry = { name: string; mode: number } & ({ file: string } | { data: Buffer });

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const VERSION_NEEDED = 20;
const MADE_BY_UNIX = (3 << 8) | 20;
const UTF8_NAMES = 0x0800;
const STORED = 0;
const DOS_DATE_1980_01_01 = (1 << 5) | 1;
const REGULAR_FILE = 0o100000;

// The size is taken once and both passes read exactly that many bytes, so the header and the data always agree.
async function measure(entry: StreamEntry): Promise<{ crc: number; size: number }> {
  if ('data' in entry) return { crc: crc32(entry.data), size: entry.data.length };
  const size = statSync(entry.file).size;
  let crc = 0;
  if (size > 0) for await (const chunk of createReadStream(entry.file, { end: size - 1 })) crc = crc32(chunk as Buffer, crc);
  return { crc, size };
}

export async function writeStoredZip(target: string, entries: readonly StreamEntry[]): Promise<void> {
  const out = createWriteStream(target);
  // A write that fails (a full disk) rejects here instead of surfacing as an unhandled 'error' that ends the server.
  let failure: Error | null = null;
  out.on('error', (error) => { failure = error; });
  const write = async (bytes: Buffer) => {
    if (failure) throw failure;
    if (!out.write(bytes)) await Promise.race([once(out, 'drain'), once(out, 'close')]);
    if (failure) throw failure;
  };
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const { crc, size } = await measure(entry);
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(STORED, 8);
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    await write(local);
    await write(name);
    if ('data' in entry) await write(entry.data);
    else if (size > 0) for await (const chunk of createReadStream(entry.file, { end: size - 1 })) await write(chunk as Buffer);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(MADE_BY_UNIX, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(STORED, 10);
    central.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((REGULAR_FILE | entry.mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + size;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(directory);
  await write(end);
  out.end();
  await finished(out);
}
