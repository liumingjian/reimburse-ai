import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalExecutorPlatform, LocalExecutorRelease } from '@baox/contract';

// What this server ships of the 本地执行器 (ADR-0035): the bundled program (`local-executor/scripts/build.mjs`) and Node's
// own runtime per platform, fetched at deploy (`local-executor/scripts/fetch-runtimes.mjs`) and never built here. The
// install script downloads both (`./install-script.ts`); an installed executor asks for the release and fetches the
// program when it is not what it runs (`local-executor/src/update.ts`).

export type LocalExecutorDist = {
  /** `local-executor/dist/baox-local-executor.mjs`. */
  program: string;
  /** `local-executor/runtime`: `<version>/<platform>/node[.exe]`, and `VERSION` naming the version served. */
  runtimes: string;
};

const binaryOf = (platform: LocalExecutorPlatform) => (platform === 'win-x64' ? 'node.exe' : 'node');

export class LocalExecutorUnavailable extends Error {}

const digests = new Map<string, { at: string; sha256: string }>();
/** sha256 of a file, remembered until its size or mtime changes. */
function digestOf(file: string): string {
  const { size, mtimeMs } = statSync(file);
  const at = `${size}:${mtimeMs}`;
  const known = digests.get(file);
  if (known?.at === at) return known.sha256;
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  digests.set(file, { at, sha256 });
  return sha256;
}

/** What this server ships now, or why it ships nothing. */
export function releaseOf(dist: LocalExecutorDist | null): LocalExecutorRelease {
  if (!dist || !existsSync(dist.program)) throw new LocalExecutorUnavailable('no local executor program; run the local-executor build');
  const versionFile = join(dist.runtimes, 'VERSION');
  const runtime = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : '';
  if (!runtime) throw new LocalExecutorUnavailable(`no runtimes at ${dist.runtimes}; run the local-executor fetch-runtimes`);
  return { program: digestOf(dist.program), runtime };
}

/**
 * The runtime the install script and the executor download for `platform`, and the sha256 the deploy recorded for that
 * binary after its archive passed SHASUMS256.txt (`node[.exe].sha256` beside it). A runtime without one, cached before
 * the deploy recorded them, is not served: nothing would vouch for it.
 */
export function runtimeOf(dist: LocalExecutorDist | null, platform: LocalExecutorPlatform): { file: string; sha256: string } {
  const release = releaseOf(dist);
  const file = join(dist!.runtimes, release.runtime, platform, binaryOf(platform));
  const sumFile = `${file}.sha256`;
  const sha256 = existsSync(sumFile) ? readFileSync(sumFile, 'utf8').trim() : '';
  if (!existsSync(file) || !/^[0-9a-f]{64}$/.test(sha256)) throw new LocalExecutorUnavailable(`no checked ${platform} runtime at ${file}; run the local-executor fetch-runtimes`);
  return { file, sha256 };
}
