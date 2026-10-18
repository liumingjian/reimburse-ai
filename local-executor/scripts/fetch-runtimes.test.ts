import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The deploy's runtime fetch (`fetch-runtimes.mjs`, run by the operator's `host` phase) against a Node mirror on disk:
// archives built here the way nodejs.org lays them out, so the test needs neither the network nor 100 MB of Node.

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'fetch-runtimes.mjs');
const version = readFileSync(join(here, '..', '..', '.nvmrc'), 'utf8').trim().replace(/^v/, '');
const PLATFORMS = [
  { platform: 'win-x64', binary: 'node.exe', archive: `node-v${version}-win-x64.zip`, member: 'node.exe' },
  { platform: 'darwin-arm64', binary: 'node', archive: `node-v${version}-darwin-arm64.tar.gz`, member: join('bin', 'node') },
  { platform: 'darwin-x64', binary: 'node', archive: `node-v${version}-darwin-x64.tar.gz`, member: join('bin', 'node') },
] as const;
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

let work: string;
let mirror: string;
let out: string;
const binaries = new Map<string, Buffer>();

function publish(sums: (archive: string, actual: string) => string = (_archive, actual) => actual): void {
  const release = join(mirror, `v${version}`);
  mkdirSync(release, { recursive: true });
  const lines: string[] = [];
  for (const p of PLATFORMS) {
    const stage = join(work, 'stage', p.platform);
    const top = `node-v${version}-${p.platform}`;
    const bytes = Buffer.from(`#!/bin/sh\necho node ${p.platform}\n`.repeat(2000));
    binaries.set(p.platform, bytes);
    mkdirSync(dirname(join(stage, top, p.member)), { recursive: true });
    writeFileSync(join(stage, top, p.member), bytes);
    writeFileSync(join(stage, top, 'README.md'), 'not the runtime\n');
    const archive = join(release, p.archive);
    if (p.archive.endsWith('.zip')) execFileSync('zip', ['-qr', archive, top], { cwd: stage });
    else execFileSync('tar', ['-czf', archive, top], { cwd: stage, env: { ...process.env, COPYFILE_DISABLE: '1' } });
    lines.push(`${sums(p.archive, sha256(readFileSync(archive)))}  ${p.archive}`);
  }
  writeFileSync(join(release, 'SHASUMS256.txt'), `${lines.join('\n')}\n`);
}

const fetchRuntimes = () => execFileSync(process.execPath, [script, out], { env: { ...process.env, NODE_MIRROR: pathToFileURL(mirror).href }, encoding: 'utf8', stdio: 'pipe' });
const home = (platform: string) => join(out, version, platform);

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'baox-fetch-runtimes-'));
  mirror = join(work, 'mirror');
  out = join(work, 'runtime');
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe('the deploy\'s runtime fetch', () => {
  it('keeps each platform\'s binary and records that binary\'s own sha256 beside it', () => {
    publish();
    fetchRuntimes();
    for (const p of PLATFORMS) {
      const kept = readFileSync(join(home(p.platform), p.binary));
      expect(kept.equals(binaries.get(p.platform)!), p.platform).toBe(true);
      expect(readFileSync(join(home(p.platform), `${p.binary}.sha256`), 'utf8'), p.platform).toBe(`${sha256(kept)}\n`);
    }
    expect(readFileSync(join(out, 'VERSION'), 'utf8')).toBe(`${version}\n`);
  });

  it('records nothing for an archive that does not match SHASUMS256.txt', () => {
    publish((archive, actual) => (archive.includes('darwin-arm64') ? '0'.repeat(64) : actual));
    expect(() => fetchRuntimes()).toThrow();
    expect(existsSync(join(home('darwin-arm64'), 'node'))).toBe(false);
    expect(existsSync(join(home('darwin-arm64'), 'node.sha256'))).toBe(false);
    expect(existsSync(join(out, 'VERSION'))).toBe(false);
  });

  it('does not go to the mirror again once every runtime and its sha256 are there', () => {
    publish();
    fetchRuntimes();
    rmSync(mirror, { recursive: true });
    expect(fetchRuntimes()).toContain('already present');
  });

  it('fetches again a runtime cached before its sha256 was recorded, rather than vouch for it unchecked', () => {
    publish();
    fetchRuntimes();
    rmSync(join(home('win-x64'), 'node.exe.sha256'));
    writeFileSync(join(home('win-x64'), 'node.exe'), 'left by an older deploy');
    fetchRuntimes();
    const kept = readFileSync(join(home('win-x64'), 'node.exe'));
    expect(kept.equals(binaries.get('win-x64')!)).toBe(true);
    expect(readFileSync(join(home('win-x64'), 'node.exe.sha256'), 'utf8')).toBe(`${sha256(kept)}\n`);
  });
});
