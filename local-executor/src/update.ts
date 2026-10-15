// The 本地执行器 keeps itself on the program its server ships (ADR-0035). The program is one file, identified by its
// sha256; the server says which one it ships (LOCAL_EXECUTOR_RELEASE_PATH) and serves it (LOCAL_EXECUTOR_PROGRAM_PATH),
// both for this executor's pairing token. Whatever differs, newer or older, is replaced: the server is the one place
// a release is decided. The runtime is not replaced in place; a release for another Node asks the employee to download
// the package again from the settings page.
//
// Replacing is a rename over the program file once the new bytes are on disk and their sha256 matched, so a crash
// leaves either the old program or the new one. The running process keeps the program it started with; it exits with
// RESTART_EXIT_CODE and its launcher starts the new one.

import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
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
};

export async function checkForUpdate({ origin, token, programPath, running, runtime = process.versions.node, fetch: get = fetch }: UpdatePorts): Promise<UpdateCheck> {
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
    const next = `${programPath}.next`;
    writeFileSync(next, bytes);
    renameSync(next, programPath);
    return { kind: 'restart' };
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}
