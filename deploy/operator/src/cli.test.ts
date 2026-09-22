import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runOperatorCli } from './cli.js';
import type { CandidateTransport } from './candidate.js';
import type { GateStatus } from './host.js';
import { createSourceRepository } from './source.js';
import { ControllableTarget } from './testing/controllable-target.js';

const repositories: string[] = [];

afterEach(() => {
  for (const repository of repositories.splice(0)) rmSync(repository, { recursive: true, force: true });
});

function committedRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), 'baox-operator-'));
  repositories.push(repository);
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'user.name', 'operator test']);
  git(repository, ['config', 'user.email', 'operator@example.test']);
  writeFileSync(join(repository, 'committed.txt'), 'committed source\n');
  git(repository, ['add', 'committed.txt']);
  git(repository, ['commit', '--quiet', '-m', 'initial source']);
  git(repository, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return repository;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function cli(repository: string, target: ControllableTarget, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runOperatorCli(argv, { source: createSourceRepository(repository), host: target }, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const openGate = (): GateStatus => ({
  kind: 'available',
  response: { version: 1, state: 'open', barrier: false, activeWrites: 0, activeErpAttempt: false },
});

it('locks origin/main to a committed archive and reports excluded local changes without contacting a host', async () => {
  const repository = committedRepository();
  const expectedArchive = createHash('sha256').update(execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: repository })).digest('hex');
  appendFileSync(join(repository, 'committed.txt'), 'local edit\n');
  writeFileSync(join(repository, 'untracked.txt'), 'not in the archive\n');
  const target = new ControllableTarget({ gate: openGate() });

  const result = await cli(repository, target, 'plan', '--json');

  expect(result).toMatchObject({ code: 0, err: '' });
  const plan = JSON.parse(result.out) as { source: { ref: string; commit: string; archiveSha256: string; excludedWorkingTreeChanges: { status: string; path: string }[] } };
  expect(plan.source.ref).toBe('origin/main');
  expect(plan.source.commit).toBe(git(repository, ['rev-parse', 'HEAD']).trim());
  expect(plan.source.archiveSha256).toBe(expectedArchive);
  expect(plan.source.excludedWorkingTreeChanges).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: ' M', path: 'committed.txt' }),
    expect.objectContaining({ status: '??', path: 'untracked.txt' }),
  ]));
  expect(target.commands).toEqual([]);
});

it('runs status, doctor, and logs through the same injected CLI target without a production target override', async () => {
  const repository = committedRepository();
  const target = new ControllableTarget({ gate: openGate(), logs: 'baox started' });

  expect(await cli(repository, target, 'status', '--json')).toMatchObject({ code: 0 });
  expect(target.commands.map((command) => command.kind)).toEqual(['status', 'gate-status']);

  target.clearCommands();
  expect(await cli(repository, target, 'doctor', '--json')).toMatchObject({ code: 0 });
  expect(target.commands.map((command) => command.kind)).toEqual(['status', 'doctor', 'gate-status']);

  target.clearCommands();
  expect(await cli(repository, target, 'logs', '--lines', '7', '--json')).toMatchObject({ code: 0 });
  expect(target.commands).toEqual([{ kind: 'logs', lines: 7 }]);
});

it('redacts credentials from collected logs without breaking JSON output', async () => {
  const repository = committedRepository();
  const target = new ControllableTarget({
    gate: openGate(),
    logs: 'temporary_password=first-secret token=second-secret authorization: Bearer third-secret cookie=fourth-secret 临时密码：fifth-secret {"token":"sixth-secret"}',
  });

  const result = await cli(repository, target, 'logs', '--json');

  expect(result.code).toBe(0);
  for (const secret of ['first-secret', 'second-secret', 'third-secret', 'fourth-secret', 'fifth-secret', 'sixth-secret']) expect(result.out).not.toContain(secret);
  expect(JSON.parse(result.out)).toMatchObject({ command: 'logs' });
});

it('refuses a dry-run routine deployment when the target lacks the maintenance gate before any host change', async () => {
  const repository = committedRepository();
  const target = new ControllableTarget({ gate: { kind: 'missing-gate' } });

  const result = await cli(repository, target, 'deploy', '--dry-run', '--json');

  expect(result.code).toBe(1);
  expect(result.out).toContain('首次启用');
  expect(target.commands).toEqual([{ kind: 'doctor' }, { kind: 'gate-status' }]);
});

it('does not upload or invoke a host bootstrap action without an explicit reviewed digest', async () => {
  const repository = committedRepository();
  const target = new ControllableTarget({ gate: openGate() });

  const result = await cli(repository, target, 'bootstrap-apply', '--proxy', 'http://proxy.example.test:7890');

  expect(result.code).toBe(2);
  expect(target.commands).toEqual([]);
  expect(target.uploads).toEqual([]);
});

it('presents a bootstrap transaction digest and sends an explicit confirmation to the host', async () => {
  const repository = committedRepository();
  const target = new ControllableTarget({ gate: openGate() });

  const preview = await cli(repository, target, 'bootstrap-preview', '--proxy', 'http://proxy.example.test:7890', '--json');

  expect(preview.code).toBe(0);
  expect(JSON.parse(preview.out)).toMatchObject({ command: 'bootstrap-preview', response: { state: 'preview', plan: { transactionDigest: 'a'.repeat(64) } } });
  expect(target.commands).toEqual([{ kind: 'bootstrap-preview', source: { kind: 'proxy', proxy: 'http://proxy.example.test:7890' } }]);

  target.clearCommands();
  const applied = await cli(repository, target, 'bootstrap-apply', '--confirm', 'a'.repeat(64), '--proxy', 'http://proxy.example.test:7890', '--json');

  expect(applied.code).toBe(0);
  expect(JSON.parse(applied.out)).toMatchObject({ command: 'bootstrap-apply', response: { state: 'applied' } });
  expect(target.commands).toEqual([{
    kind: 'bootstrap-apply',
    source: { kind: 'proxy', proxy: 'http://proxy.example.test:7890' },
    confirmationDigest: 'a'.repeat(64),
  }]);
});

it('refuses candidate preparation before source selection or target coordination when the maintenance gate is absent', async () => {
  const repository = committedRepository();
  const target = new ControllableTarget({ gate: { kind: 'missing-gate' } });
  let prepares = 0;
  const candidate: CandidateTransport = {
    async prepare() {
      prepares += 1;
      return { state: 'prepared', candidateId: 'candidate', manifest: '/tmp/manifest.json' };
    },
    async inspect() {
      return { state: 'inspection', lock: { state: 'inactive' }, journal: null, manifest: null };
    },
  };
  const out: string[] = [];
  const err: string[] = [];

  const code = await runOperatorCli(['prepare', '--json'], { source: createSourceRepository(repository), host: target, candidate }, { out: (line) => out.push(line), err: (line) => err.push(line) });

  expect(code).toBe(1);
  expect(out.join('\n')).toContain('首次启用');
  expect(err).toEqual([]);
  expect(prepares).toBe(0);
  expect(target.commands).toEqual([{ kind: 'gate-status' }]);
});

it('rejects a ref that does not name a committed source revision', async () => {
  const repository = committedRepository();
  const target = new ControllableTarget({ gate: openGate() });

  const result = await cli(repository, target, 'plan', 'missing-ref');

  expect(result).toMatchObject({ code: 2, err: expect.stringContaining('已提交的 Git 引用') });
  expect(target.commands).toEqual([]);
});
