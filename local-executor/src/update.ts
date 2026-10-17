// The 本地执行器 keeps itself on the program its server ships (ADR-0035). The program is one file, identified by its
// sha256; the server says which one it ships (LOCAL_EXECUTOR_RELEASE_PATH) and serves it (LOCAL_EXECUTOR_PROGRAM_PATH),
// both for this executor's pairing token. Whatever differs, newer or older, is replaced: the server is the one place
// a release is decided. The runtime is not replaced in place; a release for another Node asks the employee to download
// the package again from the settings page.
//
// Before anything is replaced, the new program must load and answer `self-check` under this runtime: a release that
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

export type UpdateCheck =
  | { kind: 'current' }
  // The program file on disk is now the server's: restart into it.
  | { kind: 'restart' }
  | { kind: 'runtime'; wants: string }
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
  fetch?: typeof fetch;
  /** Does the program at this path load and answer `self-check`? */
  selfCheck?: (path: string) => boolean;
};

export const SELF_CHECK_ANSWER = 'baox-self-check-ok';
const runsHere = (path: string) => {
  const ran = spawnSync(process.execPath, [path, 'self-check'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  return ran.status === 0 && ran.stdout.includes(SELF_CHECK_ANSWER);
};

export async function checkForUpdate({ origin, token, programPath, running, runtime = process.versions.node, fetch: get = fetch, selfCheck = runsHere }: UpdatePorts): Promise<UpdateCheck> {
  const headers = { authorization: `Bearer ${token}` };
  try {
    const answer = await get(`${origin}${LOCAL_EXECUTOR_RELEASE_PATH}`, { headers });
    if (!answer.ok) return { kind: 'failed', reason: `应用回答 ${answer.status}` };
    const release = LocalExecutorReleaseSchema.parse(await answer.json());
    if (release.program === running) return { kind: 'current' };
    if (release.runtime !== runtime) return { kind: 'runtime', wants: release.runtime };
    // Already on disk (installed by `setup` while this copy ran on): only the restart is missing.
    if (sha256(readFileSync(programPath)) === release.program) return { kind: 'restart' };
    const program = await get(`${origin}${LOCAL_EXECUTOR_PROGRAM_PATH}`, { headers });
    if (!program.ok) return { kind: 'failed', reason: `应用回答 ${program.status}` };
    const bytes = new Uint8Array(await program.arrayBuffer());
    if (sha256(bytes) !== release.program) return { kind: 'failed', reason: '下载到的程序和应用说的不一致' };
    // Still a .mjs: Node picks the module system by the extension, and the self-check must load it as it will run.
    const next = programPath.replace(/\.mjs$/, '') + '.next.mjs';
    writeFileSync(next, bytes);
    if (!selfCheck(next)) {
      rmSync(next, { force: true });
      return { kind: 'failed', reason: '应用发布的新版本在这台电脑上启动不了，继续用现在的版本' };
    }
    copyFileSync(programPath, `${programPath}.prev`);
    renameSync(next, programPath);
    return { kind: 'restart' };
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}
