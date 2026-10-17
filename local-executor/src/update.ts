// The 本地执行器 keeps itself on the program its server ships (ADR-0035). The program is one file, identified by its
// sha256; the server says which one it ships (LOCAL_EXECUTOR_RELEASE_PATH) and serves it (LOCAL_EXECUTOR_PROGRAM_PATH),
// both for this executor's pairing token. Whatever differs, newer or older, is replaced: the server is the one place
// a release is decided. Only the program is replaced. The runtime is compared by its Node major version (ADR-0035,
// amended 2026-10-16): a change of the server's minor version is ignored, and a change of major version switches the
// executor to the runtime downloaded from the server (fetched when it is not there), which the caller then records.
//
// Before anything is replaced, the new program must load and answer `self-check` under the runtime it will run on: a release that
// cannot start would otherwise restart forever and never reach the update check that could fix it. Then the old
// program is kept as `.prev` and the new one renamed over it, so a crash leaves either the old program or the new one.
// The running process keeps the program it started with; it exits with RESTART_EXIT_CODE and its launcher starts the
// new one.
//
// Trust: the sha256 comes from the same server as the program, over the app's own connection. It proves the bytes
// arrived whole, not who wrote them: whoever controls the server or the network path to it controls every executor.
// That is why the app must be reached over TLS before employees get the executor (erp-headless-v1.md).

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { LOCAL_EXECUTOR_PROGRAM_PATH, LOCAL_EXECUTOR_RELEASE_PATH, LocalExecutorReleaseSchema } from '@baox/contract';
import { cleanEnv, majorOf } from './runtime';

export type UpdateCheck =
  | { kind: 'current' }
  // The program file on disk is now the server's: restart into it.
  // `node`: and on the downloaded runtime at this path, for a change of the server's Node major version.
  | { kind: 'restart'; node?: string }
  | { kind: 'failed'; reason: string };

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export type UpdatePorts = {
  origin: string;
  token: string;
  /** The program file this process was started from. */
  programPath: string;
  /** The sha256 of the program as this process started it. */
  running: string;
  /** This process's Node version, without the leading v. */
  runtime?: string;
  /** This process's Node. */
  node?: string;
  fetch?: typeof fetch;
  /** Does the program at this path load and answer `self-check` under this Node? */
  selfCheck?: (path: string, node: string) => boolean;
  /** The runtime downloaded from the server for this Node major version, fetched when it is not there; its path. */
  downloadedRuntime?: (major: number) => Promise<string>;
};

export const SELF_CHECK_ANSWER = 'baox-self-check-ok';
const runsHere = (path: string, node: string) => {
  const ran = spawnSync(node, [path, 'self-check'], { encoding: 'utf8', timeout: 30_000, windowsHide: true, env: cleanEnv() });
  return ran.status === 0 && ran.stdout.includes(SELF_CHECK_ANSWER);
};

const noDownload = async (): Promise<string> => { throw new Error('这里没有下载的运行环境'); };

export async function checkForUpdate({ origin, token, programPath, running, runtime = process.versions.node, node = process.execPath, fetch: get = fetch, selfCheck = runsHere, downloadedRuntime = noDownload }: UpdatePorts): Promise<UpdateCheck> {
  const headers = { authorization: `Bearer ${token}` };
  try {
    const answer = await get(`${origin}${LOCAL_EXECUTOR_RELEASE_PATH}`, { headers });
    if (!answer.ok) return { kind: 'failed', reason: `应用回答 ${answer.status}` };
    const release = LocalExecutorReleaseSchema.parse(await answer.json());
    const major = majorOf(release.runtime);
    const switched = major !== majorOf(runtime) ? { node: await downloadedRuntime(major) } : {};
    const under = switched.node ?? node;
    if (release.program === running) return switched.node ? { kind: 'restart', ...switched } : { kind: 'current' };
    // Already on disk (installed while this copy ran on): only the restart is missing.
    if (sha256(readFileSync(programPath)) === release.program) return { kind: 'restart', ...switched };
    const program = await get(`${origin}${LOCAL_EXECUTOR_PROGRAM_PATH}`, { headers });
    if (!program.ok) return { kind: 'failed', reason: `应用回答 ${program.status}` };
    const bytes = new Uint8Array(await program.arrayBuffer());
    if (sha256(bytes) !== release.program) return { kind: 'failed', reason: '下载到的程序和应用说的不一致' };
    // Still a .mjs: Node picks the module system by the extension, and the self-check must load it as it will run.
    const next = programPath.replace(/\.mjs$/, '') + '.next.mjs';
    writeFileSync(next, bytes);
    if (!selfCheck(next, under)) {
      rmSync(next, { force: true });
      return { kind: 'failed', reason: '应用发布的新版本在这台电脑上启动不了，继续用现在的版本' };
    }
    copyFileSync(programPath, `${programPath}.prev`);
    renameSync(next, programPath);
    return { kind: 'restart', ...switched };
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}
