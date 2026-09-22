import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export type DirtyChange = {
  status: string;
  path: string;
  previousPath?: string;
};

export type SourcePlan = {
  ref: string;
  commit: string;
  archiveSha256: string;
  excludedWorkingTreeChanges: readonly DirtyChange[];
};

export type SourceRepository = {
  plan: (ref?: string) => Promise<SourcePlan>;
};

export class SourceSelectionError extends Error {}

export function createSourceRepository(cwd: string): SourceRepository {
  return { plan: (ref) => planSource(cwd, ref) };
}

async function planSource(cwd: string, requestedRef = 'origin/main'): Promise<SourcePlan> {
  if (!requestedRef || requestedRef.startsWith('-') || requestedRef.includes('\0')) {
    throw new SourceSelectionError('源代码引用必须是一个已提交的 Git 引用。');
  }

  let commit: string;
  try {
    commit = (await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${requestedRef}^{commit}`])).toString('utf8').trim();
  } catch {
    throw new SourceSelectionError(`无法把 ${requestedRef} 解析为已提交的 Git 引用。`);
  }
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new SourceSelectionError(`无法把 ${requestedRef} 解析为已提交的 Git 引用。`);
  }

  const [archive, status] = await Promise.all([
    runGit(cwd, ['archive', '--format=tar', commit]),
    runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ]);

  return {
    ref: requestedRef,
    commit,
    archiveSha256: createHash('sha256').update(archive).digest('hex'),
    excludedWorkingTreeChanges: parseDirtyChanges(status.toString('utf8')),
  };
}

function parseDirtyChanges(value: string): DirtyChange[] {
  const fields = value.split('\0');
  const changes: DirtyChange[] = [];

  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    const renamedOrCopied = status.includes('R') || status.includes('C');
    const previousPath = renamedOrCopied ? fields[++index] : undefined;
    changes.push({ status, path, ...(previousPath ? { previousPath } : {}) });
  }

  return changes;
}

function runGit(cwd: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `git exited ${code ?? 'without a status'}`));
    });
  });
}
