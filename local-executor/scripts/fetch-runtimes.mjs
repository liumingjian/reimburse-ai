import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, createReadStream, createWriteStream, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip, createInflateRaw } from 'node:zlib';

// Fetches Node's own runtime for every platform the 本地执行器 ships to (ADR-0035) into `runtime/<version>/<platform>/`
// (or under the directory given as the first argument), and names the version served in `runtime/VERSION`. The version is the repo's (.nvmrc), the one the
// program is built and tested on. Each archive is checked against the release's SHASUMS256.txt before anything is
// taken out of it, and only the node binary is kept, with its own sha256 in `node[.exe].sha256` beside it: Node signs it (Authenticode on Windows, Developer ID and
// notarisation on macOS), and baox ships it untouched, so neither system has to be told to trust a binary of ours.
//
// Run by the operator's candidate prepare on each deploy (deploy/operator, phase `host`), through curl so the deployment's proxy settings apply. A platform
// already present at this version is skipped. Everything streams: the host this runs on has little memory to spare.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = process.argv[2] ? resolve(process.argv[2]) : join(root, 'runtime');
const mirror = (process.env.NODE_MIRROR || 'https://npmmirror.com/mirrors/node').replace(/\/+$/, '');
const version = readFileSync(join(root, '..', '.nvmrc'), 'utf8').trim().replace(/^v/, '');

const PLATFORMS = {
  'win-x64': { archive: `node-v${version}-win-x64.zip`, member: `node-v${version}-win-x64/node.exe`, binary: 'node.exe' },
  'darwin-arm64': { archive: `node-v${version}-darwin-arm64.tar.gz`, member: `node-v${version}-darwin-arm64/bin/node`, binary: 'node' },
  'darwin-x64': { archive: `node-v${version}-darwin-x64.tar.gz`, member: `node-v${version}-darwin-x64/bin/node`, binary: 'node' },
};

const curl = (url, file) => execFileSync('curl', ['-fsSL', '--retry', '3', '-o', file, url], { stdio: ['ignore', 'inherit', 'inherit'] });
const sha256Of = async (file) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};

/** Stream one member out of a .tar.gz into `target`: 512-byte headers, each member's data padded to 512. */
async function fromTarGz(archive, member, target) {
  let pending = Buffer.alloc(0);
  let state = 'header';
  let dataLeft = 0;
  let padLeft = 0;
  let writing = null;
  const source = createReadStream(archive).pipe(createGunzip());
  for await (const chunk of source) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    for (;;) {
      if (state === 'header') {
        if (pending.length < 512) break;
        const header = pending.subarray(0, 512);
        pending = pending.subarray(512);
        if (header.every((b) => b === 0)) continue;
        const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
        const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
        dataLeft = parseInt(field(124, 12).trim() || '0', 8);
        padLeft = Math.ceil(dataLeft / 512) * 512 - dataLeft;
        writing = name === member ? createWriteStream(target) : null;
        state = 'data';
      } else if (state === 'data') {
        const n = Math.min(dataLeft, pending.length);
        if (writing && n > 0 && !writing.write(pending.subarray(0, n))) await new Promise((r) => writing.once('drain', r));
        pending = pending.subarray(n);
        dataLeft -= n;
        if (dataLeft > 0) break;
        if (writing) {
          const done = writing;
          await new Promise((r) => done.end(r));
          source.destroy();
          return;
        }
        state = 'pad';
      } else {
        const n = Math.min(padLeft, pending.length);
        pending = pending.subarray(n);
        padLeft -= n;
        if (padLeft > 0) break;
        state = 'header';
      }
    }
  }
  throw new Error(`${member} is not in ${archive}`);
}

/** Stream one member out of a .zip into `target`, by its central directory. */
async function fromZip(archive, member, target) {
  const fd = openSync(archive, 'r');
  try {
    const size = fstatSync(fd).size;
    const tailLength = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLength);
    readSync(fd, tail, 0, tailLength, size - tailLength);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error(`${archive} has no end of central directory`);
    const entries = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOffset);
    let at = 0;
    for (let i = 0; i < entries; i += 1) {
      const method = cd.readUInt16LE(at + 10);
      const compressed = cd.readUInt32LE(at + 20);
      const nameLength = cd.readUInt16LE(at + 28);
      const extraLength = cd.readUInt16LE(at + 30);
      const commentLength = cd.readUInt16LE(at + 32);
      const localOffset = cd.readUInt32LE(at + 42);
      const name = cd.subarray(at + 46, at + 46 + nameLength).toString('utf8');
      at += 46 + nameLength + extraLength + commentLength;
      if (name !== member) continue;
      const local = Buffer.alloc(30);
      readSync(fd, local, 0, 30, localOffset);
      const start = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const data = createReadStream(archive, { start, end: start + compressed - 1 });
      if (method === 0) await pipeline(data, createWriteStream(target));
      else if (method === 8) await pipeline(data, createInflateRaw(), createWriteStream(target));
      else throw new Error(`${member} in ${archive} uses compression method ${method}`);
      return;
    }
    throw new Error(`${member} is not in ${archive}`);
  } finally {
    closeSync(fd);
  }
}

mkdirSync(out, { recursive: true });
const scratch = join(tmpdir(), `baox-runtimes-${process.pid}`);
mkdirSync(scratch, { recursive: true });
try {
  // Each version in its own directory; VERSION names the one served, and moves only once that one is complete. A
  // fetch that fails half-way leaves the server on the version it had.
  const versionFile = join(out, 'VERSION');
  const current = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : null;
  const home = join(out, version);
  // A runtime counts as present only with its sha256 beside it. One cached before the sha256 was recorded is fetched
  // again rather than hashed where it lies: only a binary just taken out of a checked archive gets a sha256.
  const todo = Object.entries(PLATFORMS).filter(([platform, p]) => !existsSync(join(home, platform, p.binary)) || !existsSync(join(home, platform, `${p.binary}.sha256`)));
  if (todo.length > 0) {
    curl(`${mirror}/v${version}/SHASUMS256.txt`, join(scratch, 'SHASUMS256.txt'));
    const sums = new Map(readFileSync(join(scratch, 'SHASUMS256.txt'), 'utf8').split('\n').map((line) => line.trim().split(/\s+/)).filter((p) => p.length === 2).map(([sum, file]) => [file, sum]));
    for (const [platform, p] of todo) {
      const archive = join(scratch, p.archive);
      console.log(`[runtimes] ${platform}: ${p.archive}`);
      curl(`${mirror}/v${version}/${p.archive}`, archive);
      const expected = sums.get(p.archive);
      const actual = await sha256Of(archive);
      if (!expected || expected !== actual) throw new Error(`${p.archive}: sha256 ${actual} does not match SHASUMS256.txt (${expected ?? 'not listed'})`);
      const dir = join(home, platform);
      mkdirSync(dir, { recursive: true });
      const partial = join(dir, `${p.binary}.partial`);
      if (p.archive.endsWith('.zip')) await fromZip(archive, p.member, partial);
      else await fromTarGz(archive, p.member, partial);
      chmodSync(partial, 0o755);
      // The binary's own sha256, which the server serves beside it (`server/src/local-executor/release.ts`): the
      // official sums cover the archive, which is discarded. The binary is named before its sha256, so a run cut off
      // in between leaves a binary without one, which the next run fetches again.
      writeFileSync(join(dir, `${p.binary}.sha256.partial`), `${await sha256Of(partial)}\n`);
      renameSync(partial, join(dir, p.binary));
      renameSync(join(dir, `${p.binary}.sha256.partial`), join(dir, `${p.binary}.sha256`));
      rmSync(archive, { force: true });
    }
  }
  if (current !== version) {
    writeFileSync(`${versionFile}.partial`, `${version}\n`);
    renameSync(`${versionFile}.partial`, versionFile);
  }
  // Only the version served is kept.
  for (const entry of readdirSync(out)) if (/^\d+\.\d+\.\d+$/.test(entry) && entry !== version) rmSync(join(out, entry), { recursive: true, force: true });
  console.log(todo.length ? `[runtimes] Node ${version} ready in ${out}` : `[runtimes] Node ${version} already present for every platform`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
