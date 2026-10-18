// Which Node the 本地执行器 runs on (ADR-0035, amended 2026-10-16/17). The employee's own Node is used when it is the
// server's Node major version (`.nvmrc`, 24 today) and, on macOS, `codesign` verifies Node.js's own Developer ID
// signature; Windows checks the version only, for now. Otherwise it runs on the runtime downloaded from the app server
// into `app/runtime`, fetched and checked by its sha256 when it is not there. The employee's own Node is only ever
// read: never upgraded, replaced or removed.
//
// The executor's config records the Node it uses (`node` in baox-config.json); every start rechecks it (`start.ts`),
// and the start-at-login entry runs exactly that path with the variables below cleared (`install.ts`).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, win32 } from 'node:path';
import { CODE_LOADING_ENV, localExecutorRuntimePath, localExecutorRuntimeSha256Path, NODE_SIGNATURE_REQUIREMENT, type LocalExecutorPlatform } from '@baox/contract';

// The server's Node major version, baked in by the build from `.nvmrc` (scripts/build.mjs). The executor always runs
// the program its server ships, so this is the server's. From the repo (tsx) it is the Node running it.
declare const __BAOX_NODE_MAJOR__: string | undefined;
export const majorOf = (version: string): number => Number(/^v?(\d+)\./.exec(version.trim())?.[1] ?? Number.NaN);
export const NODE_MAJOR = typeof __BAOX_NODE_MAJOR__ === 'string' ? Number(__BAOX_NODE_MAJOR__) : majorOf(process.versions.node);

export function cleanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const name of CODE_LOADING_ENV) delete clean[name];
  return clean;
}

// In the contract because the install script the server writes clears and checks the same (`server/src/local-executor/install-script.ts`).
export { CODE_LOADING_ENV, NODE_SIGNATURE_REQUIREMENT, NODE_SIGNER_TEAM } from '@baox/contract';

export type NodeProbe = {
  exists(path: string): boolean;
  /** What `<path> --version` prints, or null when it does not run. */
  version(path: string): string | null;
  /** Does `codesign` verify Node.js's own signature on it (macOS)? */
  signed(path: string): boolean;
};

export function nodeProbe(): NodeProbe {
  return {
    exists: existsSync,
    version(path) {
      const ran = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true, env: cleanEnv() });
      return ran.status === 0 ? ran.stdout.trim() : null;
    },
    signed(path) {
      const ran = spawnSync('/usr/bin/codesign', ['--verify', '--strict', '-R', NODE_SIGNATURE_REQUIREMENT, path], { stdio: 'ignore', timeout: 30_000 });
      return ran.status === 0;
    },
  };
}

/** A Windows path as the start entry writes it: ASCII only, a Chinese user name reached through %USERPROFILE%. */
export function windowsPath(path: string, userHome: string): string {
  const rel = win32.relative(userHome, path);
  return rel && !rel.startsWith('..') && /^[\x20-\x7e]*$/.test(rel) ? `%USERPROFILE%\\${rel}` : path;
}

/** Why this Node is not the employee's own Node 24 the executor may use, or null when it may. */
function refusal({ path, platform, major, probe, userHome }: { path: string; platform: NodeJS.Platform; major: number; probe: NodeProbe; userHome: string }): string | null {
  if (!probe.exists(path)) return '不在了';
  // On macOS the signature comes first, as in the install script: an unsigned binary is never run, not even for
  // `--version`.
  if (platform === 'darwin' && !probe.signed(path)) return '没有 Node.js 官方签名';
  const version = probe.version(path);
  if (!version || majorOf(version) !== major) return `版本是 ${version ?? '未知'}，不是 ${major}`;
  // The Windows start entry is ASCII; a path it cannot write would never start.
  if (platform === 'win32' && !/^[\x20-\x7e]*$/.test(windowsPath(path, userHome))) return '路径里有启动项写不了的字符';
  return null;
}

export type RuntimeSource = { origin: string; platform: LocalExecutorPlatform; fetch?: typeof fetch };

/** Fetch the server's runtime for this platform into `target`, checked by its sha256; nothing is left on a mismatch. */
export async function fetchRuntime(target: string, { origin, platform, fetch: get = fetch }: RuntimeSource): Promise<void> {
  const answer = await get(`${origin}${localExecutorRuntimePath(platform)}`);
  if (!answer.ok) throw new Error(`下载运行环境时应用回答 ${answer.status}`);
  const bytes = new Uint8Array(await answer.arrayBuffer());
  const sum = await get(`${origin}${localExecutorRuntimeSha256Path(platform)}`);
  if (!sum.ok) throw new Error(`下载运行环境的校验值时应用回答 ${sum.status}`);
  if (createHash('sha256').update(bytes).digest('hex') !== (await sum.text()).trim()) throw new Error('下载到的运行环境和应用给的校验值不一致');
  mkdirSync(dirname(target), { recursive: true });
  const part = `${target}.part`;
  writeFileSync(part, bytes, { mode: 0o755 });
  chmodSync(part, 0o755);
  try {
    renameSync(part, target);
  } catch {
    // Windows will not replace a node.exe that is running, but it lets it be renamed away.
    rmSync(`${target}.old`, { force: true });
    renameSync(target, `${target}.old`);
    renameSync(part, target);
  }
}

/** The downloaded runtime at `downloaded`, of `major`: kept when it is there and of that major, else fetched. */
export async function ensureDownloaded({ downloaded, major, probe, runtime }: { downloaded: string; major: number; probe: NodeProbe; runtime: RuntimeSource }): Promise<string> {
  if (probe.exists(downloaded) && majorOf(probe.version(downloaded) ?? '') === major) return downloaded;
  await fetchRuntime(downloaded, runtime);
  return downloaded;
}

export type NodeChoice = { path: string; switched: boolean; why?: string };

/**
 * The Node to run on: the recorded one while it qualifies, else the downloaded runtime. A zip install recorded none;
 * it runs on the runtime beside it, which is the downloaded one.
 */
export async function chooseNode({ recorded, downloaded, platform, major, probe, userHome, runtime }: {
  recorded: string | undefined;
  downloaded: string;
  platform: NodeJS.Platform;
  major: number;
  probe: NodeProbe;
  userHome: string;
  runtime: RuntimeSource;
}): Promise<NodeChoice> {
  const current = recorded ?? downloaded;
  if (current !== downloaded) {
    const why = refusal({ path: current, platform, major, probe, userHome });
    if (!why) return { path: current, switched: false };
    return { path: await ensureDownloaded({ downloaded, major, probe, runtime }), switched: true, why };
  }
  // The runtime the server gave is vouched for by its sha256; only its version is rechecked.
  return { path: await ensureDownloaded({ downloaded, major, probe, runtime }), switched: false };
}
