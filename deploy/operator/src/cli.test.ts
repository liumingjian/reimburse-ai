import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runOperatorCli } from './cli.js';
import type { CandidateTransport } from './candidate.js';
import type { DoctorReport, GateStatus } from './host.js';
import { createSourceRepository } from './source.js';
import type { SnapshotTransport } from './snapshot.js';
import type { CutoverTransport } from './cutover.js';
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
  const code = await runOperatorCli(
    argv,
    { source: createSourceRepository(repository), host: target, bootstrapProvenance: async () => undefined },
    { out: (line) => out.push(line), err: (line) => err.push(line) },
  );
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

it('accepts pnpm\'s leading argument separator at the CLI boundary', async () => {
  const repository = committedRepository();
  const target = new ControllableTarget({ gate: openGate() });

  const result = await cli(repository, target, '--', 'plan', '--json');

  expect(result).toMatchObject({ code: 0, err: '' });
  expect(JSON.parse(result.out)).toMatchObject({ command: 'plan' });
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

it('refuses a dry-run routine deployment when isolated prerequisites are missing without attempting bootstrap', async () => {
  const repository = committedRepository();
  const doctor: DoctorReport = {
    nodeVersion: 'v24.13.0',
    gccVersion: null,
    buildPython: null,
    pnpmVersion: '10.17.1',
    caddyVersion: 'v2.10.2',
    serviceAccount: 'ready',
    maintenanceWrapper: 'present',
    issues: [{ code: 'missing-isolated-gcc', message: '缺少隔离 GCC 运行时。请先执行 bootstrap。' }],
  };
  const target = new ControllableTarget({ gate: openGate(), doctor });

  const result = await cli(repository, target, 'deploy', '--dry-run', '--json');

  expect(result.code).toBe(1);
  expect(result.out).toContain('缺少隔离 GCC');
  expect(target.commands).toEqual([{ kind: 'doctor' }, { kind: 'gate-status' }]);
  expect(target.uploads).toEqual([]);
});

it('does not upload or invoke a host bootstrap action without an explicit reviewed digest', async () => {
  const repository = committedRepository();
  const target = new ControllableTarget({ gate: openGate() });

  const result = await cli(repository, target, 'bootstrap-apply', '--proxy', 'http://proxy.example.test:7890');

  expect(result.code).toBe(2);
  expect(target.commands).toEqual([]);
  expect(target.uploads).toEqual([]);
});

it('requires operator-side provenance before it invokes the target bootstrap action', async () => {
  const repository = committedRepository();
  const target = new ControllableTarget({ gate: openGate() });
  const out: string[] = [];
  const err: string[] = [];
  let provenanceCalls = 0;

  const code = await runOperatorCli(
    ['bootstrap-apply', '--confirm', 'a'.repeat(64), '--proxy', 'http://proxy.example.test:7890'],
    {
      source: createSourceRepository(repository),
      host: target,
      bootstrapProvenance: async () => {
        provenanceCalls += 1;
        throw new Error('test provenance rejection');
      },
    },
    { out: (line) => out.push(line), err: (line) => err.push(line) },
  );

  expect(code).toBe(3);
  expect(provenanceCalls).toBe(1);
  expect(out).toEqual([]);
  expect(err.join('\n')).toContain('test provenance rejection');
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

it('refuses candidate preparation while the maintenance barrier is admitted before reading an archive or touching a candidate', async () => {
  const target = new ControllableTarget({
    gate: { kind: 'available', response: { version: 1, state: 'admitted', barrier: true, activeWrites: 0, activeErpAttempt: false } },
  });
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
  const source = {
    plan: async () => { throw new Error('source plan must not run'); },
    archive: async () => { throw new Error('source archive must not run'); },
  };
  const out: string[] = [];
  const err: string[] = [];

  const code = await runOperatorCli(['prepare', '--json'], { source, host: target, candidate }, { out: (line) => out.push(line), err: (line) => err.push(line) });

  expect(code).toBe(1);
  expect(out.join('\n')).toContain('开放状态');
  expect(err).toEqual([]);
  expect(prepares).toBe(0);
  expect(target.commands).toEqual([{ kind: 'gate-status' }]);
});

it('starts a recovery snapshot only from an open maintenance gate and forwards explicit retention', async () => {
  const repository = committedRepository();
  const target = new ControllableTarget({ gate: openGate() });
  const requests: Array<{ candidateId: string; retention?: number }> = [];
  const snapshot: SnapshotTransport = {
    async snapshot(request) {
      requests.push(request);
      return { state: 'verified', snapshotId: `snapshot-${request.candidateId}-0123456789abcdef`, manifest: '/opt/tools/baox/recovery-snapshots/manifest.json', completion: 'reopen' };
    },
  };
  const out: string[] = [];
  const err: string[] = [];
  const candidateId = '0123456789ab-cdef01234567';

  const code = await runOperatorCli(
    ['snapshot', candidateId, '--retain', '1', '--json'],
    { source: createSourceRepository(repository), host: target, snapshot },
    { out: (line) => out.push(line), err: (line) => err.push(line) },
  );

  expect(code).toBe(0);
  expect(err).toEqual([]);
  expect(requests).toEqual([{ candidateId, retention: 1 }]);
  expect(target.commands).toEqual([{ kind: 'gate-status' }]);
  expect(JSON.parse(out.join('\n'))).toMatchObject({
    command: 'snapshot',
    candidateId,
    retention: 1,
    maintenanceGate: openGate(),
    snapshot: { state: 'verified', completion: 'reopen' },
  });
});

it('refuses a recovery snapshot while the maintenance barrier is already closed', async () => {
  const repository = committedRepository();
  const target = new ControllableTarget({
    gate: { kind: 'available', response: { version: 1, state: 'admitted', barrier: true, activeWrites: 0, activeErpAttempt: false } },
  });
  let calls = 0;
  const snapshot: SnapshotTransport = {
    async snapshot() {
      calls += 1;
      return { state: 'failed', code: 'should-not-run' };
    },
  };
  const out: string[] = [];
  const err: string[] = [];

  const code = await runOperatorCli(
    ['snapshot', '0123456789ab-cdef01234567', '--json'],
    { source: createSourceRepository(repository), host: target, snapshot },
    { out: (line) => out.push(line), err: (line) => err.push(line) },
  );

  expect(code).toBe(1);
  expect(err).toEqual([]);
  expect(calls).toBe(0);
  expect(target.commands).toEqual([{ kind: 'gate-status' }]);
  expect(JSON.parse(out.join('\n'))).toMatchObject({ command: 'snapshot', refusal: expect.stringContaining('开放状态') });
});

it('reconciles a matching cutover journal through the CLI while the gate is closed and services are unavailable', async () => {
  const repository = committedRepository();
  const candidateId = '0123456789ab-cdef01234567';
  const target = new ControllableTarget({
    gate: { kind: 'available', response: { version: 1, state: 'admitted', barrier: true, activeWrites: 0, activeErpAttempt: false } },
    status: { currentRelease: '/opt/tools/baox/releases/original', baoxService: 'inactive', caddyService: 'inactive', dataDirectory: 'present', availableKib: 4_000_000 },
  });
  let prepares = 0;
  let cutovers = 0;
  const candidate: CandidateTransport = {
    async prepare() {
      prepares += 1;
      return { state: 'prepared', candidateId, manifest: '/opt/tools/baox/candidates/manifest.json' };
    },
    async inspect() {
      return { state: 'inspection', lock: { state: 'inactive' }, journal: { schema: 1, operation: 'cutover', candidateId, phase: 'candidate-switched' }, manifest: null };
    },
  };
  const cutover: CutoverTransport = {
    async cutover(request) {
      cutovers += 1;
      expect(request).toEqual({ candidateId });
      return { state: 'verified', candidateId, release: `releases/${candidateId}`, snapshotId: `snapshot-${candidateId}-0123456789abcdef`, manifest: '/opt/tools/baox/recovery-snapshots/manifest.json' };
    },
  };
  const out: string[] = [];
  const err: string[] = [];

  const code = await runOperatorCli(
    ['deploy', '--candidate', candidateId, '--json'],
    { source: createSourceRepository(repository), host: target, candidate, cutover },
    { out: (line) => out.push(line), err: (line) => err.push(line) },
  );

  expect(code).toBe(0);
  expect(err).toEqual([]);
  expect(prepares).toBe(0);
  expect(cutovers).toBe(1);
  expect(target.commands).toEqual([]);
  expect(JSON.parse(out.join('\n'))).toMatchObject({ command: 'deploy', reconciliation: true, cutover: { state: 'verified', candidateId } });
});

it('reconciles a default deploy source before candidate preparation when its cutover journal is outstanding', async () => {
  const repository = committedRepository();
  const source = await createSourceRepository(repository).archive();
  const candidateId = `${source.plan.commit.slice(0, 12)}-${source.plan.archiveSha256.slice(0, 12)}`;
  const target = new ControllableTarget({
    gate: { kind: 'available', response: { version: 1, state: 'admitted', barrier: true, activeWrites: 0, activeErpAttempt: false } },
  });
  let prepares = 0;
  const candidate: CandidateTransport = {
    async prepare() {
      prepares += 1;
      return { state: 'failed', code: 'should-not-prepare' };
    },
    async inspect() {
      return { state: 'inspection', lock: { state: 'inactive' }, journal: { schema: 1, operation: 'recovery-snapshot', candidateId, phase: 'snapshot-verified-held' }, manifest: null };
    },
  };
  const cutover: CutoverTransport = {
    async cutover(request) {
      expect(request).toEqual({ candidateId });
      return { state: 'verified', candidateId, release: `releases/${candidateId}`, snapshotId: `snapshot-${candidateId}-0123456789abcdef`, manifest: '/opt/tools/baox/recovery-snapshots/manifest.json' };
    },
  };
  const out: string[] = [];
  const err: string[] = [];

  const code = await runOperatorCli(
    ['deploy', 'origin/main', '--json'],
    { source: createSourceRepository(repository), host: target, candidate, cutover },
    { out: (line) => out.push(line), err: (line) => err.push(line) },
  );

  expect(code).toBe(0);
  expect(err).toEqual([]);
  expect(prepares).toBe(0);
  expect(target.commands).toEqual([]);
  expect(JSON.parse(out.join('\n'))).toMatchObject({ command: 'deploy', source: { ref: 'origin/main' }, reconciliation: true });
});

it('refuses a fresh deploy while the maintenance gate is already closed without preparing a candidate', async () => {
  const repository = committedRepository();
  const target = new ControllableTarget({
    gate: { kind: 'available', response: { version: 1, state: 'admitted', barrier: true, activeWrites: 0, activeErpAttempt: false } },
  });
  let prepares = 0;
  let cutovers = 0;
  const candidate: CandidateTransport = {
    async prepare() {
      prepares += 1;
      return { state: 'prepared', candidateId: '0123456789ab-cdef01234567', manifest: '/opt/tools/baox/candidates/manifest.json' };
    },
    async inspect() {
      return { state: 'inspection', lock: { state: 'inactive' }, journal: null, manifest: null };
    },
  };
  const cutover: CutoverTransport = {
    async cutover() {
      cutovers += 1;
      return { state: 'failed', code: 'should-not-cutover' };
    },
  };
  const out: string[] = [];
  const err: string[] = [];

  const code = await runOperatorCli(
    ['deploy', '--candidate', '0123456789ab-cdef01234567', '--json'],
    { source: createSourceRepository(repository), host: target, candidate, cutover },
    { out: (line) => out.push(line), err: (line) => err.push(line) },
  );

  expect(code).toBe(1);
  expect(err).toEqual([]);
  expect(prepares).toBe(0);
  expect(cutovers).toBe(0);
  expect(target.commands).toEqual([{ kind: 'doctor' }, { kind: 'gate-status' }]);
});

it('rejects a ref that does not name a committed source revision', async () => {
  const repository = committedRepository();
  const target = new ControllableTarget({ gate: openGate() });

  const result = await cli(repository, target, 'plan', 'missing-ref');

  expect(result).toMatchObject({ code: 2, err: expect.stringContaining('已提交的 Git 引用') });
  expect(target.commands).toEqual([]);
});
