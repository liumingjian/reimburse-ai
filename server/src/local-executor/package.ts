import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_EXECUTOR_CONFIG_FILE, type LocalExecutorPlatform, type LocalExecutorRelease } from '@baox/contract';
import { writeStoredZip, type StreamEntry } from './zip-stream';

// The 本地执行器 as the settings page hands it out (ADR-0035): per platform, a zip of Node's own runtime, the bundled
// program (`local-executor/scripts/build.mjs`), the app's address and a launcher to double-click. The runtimes are
// fetched at deploy (`local-executor/scripts/fetch-runtimes.mjs`) and never built here.
//
// The address is the one the server admits, written per request as the extension's is (`extension/download.ts`), for
// the same reason. A zip is assembled once per program, runtime, address and platform and kept under the data
// directory, so the ~100 MB runtime is copied once, not on every download.

export type LocalExecutorDist = {
  /** `local-executor/dist/baox-local-executor.mjs`. */
  program: string;
  /** `local-executor/runtime`: `<platform>/node[.exe]` and `VERSION`. */
  runtimes: string;
};

export const ROOT = 'baox-local-executor';
const binaryOf = (platform: LocalExecutorPlatform) => (platform === 'win-x64' ? 'node.exe' : 'node');

// What the employee double-clicks. ASCII names and contents: Windows' own unzip and cmd both read them safely. Each
// runs `setup` with the runtime beside it, which asks for the 配对码 and installs (`local-executor/src/main.ts`).
const LAUNCHERS: Readonly<Record<LocalExecutorPlatform, { name: string; content: string }>> = {
  'win-x64': {
    name: 'start-baox.cmd',
    content: ['@echo off', 'cd /d "%~dp0"', '"%~dp0runtime\\node.exe" "%~dp0baox-local-executor.mjs" setup', 'if errorlevel 1 pause', ''].join('\r\n'),
  },
  'darwin-arm64': { name: 'start-baox.command', content: '#!/bin/bash\ncd "$(dirname "$0")" || exit 1\n./runtime/node ./baox-local-executor.mjs setup\n' },
  'darwin-x64': { name: 'start-baox.command', content: '#!/bin/bash\ncd "$(dirname "$0")" || exit 1\n./runtime/node ./baox-local-executor.mjs setup\n' },
};
export const launcherName = (platform: LocalExecutorPlatform) => LAUNCHERS[platform].name;

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

/** The zip for `platform` and `origin`, assembled on first ask; its path. */
export async function packageLocalExecutor(dist: LocalExecutorDist | null, platform: LocalExecutorPlatform, origin: string, cacheDir: string): Promise<string> {
  const release = releaseOf(dist);
  const runtime = join(dist!.runtimes, platform, binaryOf(platform));
  if (!existsSync(runtime)) throw new LocalExecutorUnavailable(`no ${platform} runtime at ${runtime}`);
  const key = createHash('sha256').update(JSON.stringify([release, platform, origin])).digest('hex').slice(0, 24);
  const target = join(cacheDir, `${platform}-${key}.zip`);
  if (existsSync(target)) return target;
  mkdirSync(cacheDir, { recursive: true });
  const launcher = LAUNCHERS[platform];
  const entries: StreamEntry[] = [
    { name: `${ROOT}/${launcher.name}`, mode: 0o755, data: Buffer.from(launcher.content, 'utf8') },
    { name: `${ROOT}/${LOCAL_EXECUTOR_CONFIG_FILE}`, mode: 0o644, data: Buffer.from(JSON.stringify({ origin, platform }), 'utf8') },
    { name: `${ROOT}/baox-local-executor.mjs`, mode: 0o644, file: dist!.program },
    { name: `${ROOT}/runtime/${binaryOf(platform)}`, mode: 0o755, file: runtime },
  ];
  // Two downloads of a zip not built yet share one build.
  const building = inFlight.get(target) ?? (async () => {
    const partial = `${target}.${randomUUID()}.partial`;
    try {
      await writeStoredZip(partial, entries);
      renameSync(partial, target);
      // Only the newest zip of a platform is ever served again.
      for (const old of readdirSync(cacheDir)) if (old.startsWith(`${platform}-`) && join(cacheDir, old) !== target && !old.endsWith('.partial')) rmSync(join(cacheDir, old), { force: true });
    } finally {
      rmSync(partial, { force: true });
      inFlight.delete(target);
    }
  })();
  inFlight.set(target, building);
  await building;
  return target;
}
const inFlight = new Map<string, Promise<void>>();
