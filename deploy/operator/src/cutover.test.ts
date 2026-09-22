import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { SshCandidateTransport } from './candidate.js';
import { runOperatorCli } from './cli.js';
import { SshCutoverTransport } from './cutover.js';
import { SshHostTransport } from './host.js';
import { createSourceRepository } from './source.js';
import { writeBlob } from '../../../server/src/data-dir.js';
import { createSnapshotIsolatedTarget, type SnapshotIsolatedTarget } from './testing/isolated-target.js';

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

it('runs default deploy from committed origin/main through a fresh held snapshot and only reopens after candidate verification', async () => {
  const target = await createTarget();
  const releaseA = installManagedCurrentRelease(target, 'release-a');
  const source = candidateRepository(target, 'candidate-success');
  const originalBlob = writeBlob(target.dataDir, Buffer.from('original blob before cutover\n'));
  const commandsBefore = target.controller.commands().length;

  const result = await cli(target, source, 'deploy', '--json');

  expect(result, result.out).toMatchObject({ code: 0, err: '' });
  const output = JSON.parse(result.out) as { cutover: { state: string; candidateId: string; snapshotId: string; manifest: string } };
  expect(output.cutover.state).toBe('verified');
  expect(readlinkSync(target.current)).toBe(`releases/${output.cutover.candidateId}`);
  const releaseRoot = join(target.profile.deployRoot, 'releases');
  expect(statSync(releaseRoot).mode & 0o777).toBe(0o750);
  expect(readFileSync(join(target.barrier, 'chown.log'), 'utf8')).toEqual(expect.stringContaining(`root:baox ${releaseRoot}`));
  expect((await fetch(`${target.controller.serviceUrl}/api/session`)).status).toBeLessThan(500);
  expect((await fetch(`${target.controller.publicUrl}/api/session`)).status).toBeLessThan(500);
  expect(existsSync(join(target.dataDir, 'files', 'sha256', originalBlob.slice(0, 2), originalBlob))).toBe(true);
  const manifest = JSON.parse(readFileSync(output.cutover.manifest, 'utf8')) as { original: { release: string }; rehearsal: { state: string } };
  expect(manifest).toMatchObject({ original: { release: `releases/${releaseA}` }, rehearsal: { state: 'verified' } });
  const journal = JSON.parse(readFileSync(join(target.profile.deployRoot, 'maintenance', 'deployment-journal.json'), 'utf8')) as { operation: string; phase: string };
  expect(journal).toEqual(expect.objectContaining({ operation: 'cutover', phase: 'completed' }));

  const commands = target.controller.commands().slice(commandsBefore);
  const candidateStart = commands.lastIndexOf('start baox.service');
  const proxyStart = commands.lastIndexOf('start baox-caddy.service');
  expect(candidateStart).toBeGreaterThan(-1);
  expect(proxyStart).toBeGreaterThan(candidateStart);
}, 120_000);

it('restores data, configuration, runtime reference, and original release when candidate startup fails before public access', async () => {
  const target = await createTarget();
  const releaseA = installManagedCurrentRelease(target, 'release-a');
  const source = candidateRepository(target, 'candidate-startup-failure', { failStart: true, mutateBeforeFailure: true });
  const prepared = await prepareCandidate(target, source);
  const blob = writeBlob(target.dataDir, Buffer.from('restore this blob\n'));
  const originalConfiguration = target.activeConfiguration.map((file) => ({
    file,
    contents: readFileSync(file),
    mode: statSync(file).mode & 0o777,
    uid: statSync(file).uid,
    gid: statSync(file).gid,
  }));
  const originalRuntime = readlinkSync(join(target.profile.deployRoot, 'runtime', 'node'));
  const mutatedBlob = createHash('sha256').update('candidate pre-access blob mutation\n').digest('hex');

  const result = await cli(target, source, 'deploy', '--candidate', prepared, '--json');

  expect(result.code).toBe(1);
  const output = JSON.parse(result.out) as { cutover: { state: string; snapshotId: string; code: string } };
  expect(output.cutover).toMatchObject({ state: 'restored', code: 'service-command-failed' });
  expect(readlinkSync(target.current)).toBe(`releases/${releaseA}`);
  expect(readlinkSync(join(target.profile.deployRoot, 'runtime', 'node'))).toBe(originalRuntime);
  expect(existsSync(join(target.barrier, 'candidate-mutation-applied'))).toBe(true);
  expect(readFileSync(join(target.barrier, 'candidate-caddyfile-before-failure'), 'utf8')).toContain('candidate candidate-startup-failure');
  for (const expected of originalConfiguration) {
    const restored = statSync(expected.file);
    expect(readFileSync(expected.file)).toEqual(expected.contents);
    expect(restored.mode & 0o777).toBe(expected.mode);
    expect(restored.uid).toBe(expected.uid);
    expect(restored.gid).toBe(expected.gid);
  }
  expect(existsSync(join(target.dataDir, 'files', 'sha256', blob.slice(0, 2), blob))).toBe(true);
  expect(existsSync(join(target.dataDir, 'files', 'sha256', mutatedBlob.slice(0, 2), mutatedBlob))).toBe(false);
  expect(sqliteTablePresent(target.dataDir, 'cutover_test_mutation')).toBe(false);
  expect((await fetch(`${target.controller.serviceUrl}/api/session`)).status).toBeLessThan(500);
  expect((await fetch(`${target.controller.publicUrl}/api/session`)).status).toBeLessThan(500);
  await expect(new SshHostTransport({ profile: target.profile, runner: target.runner.run }).execute({ kind: 'gate-status' })).resolves.toMatchObject({
    kind: 'gate-status', value: { kind: 'available', response: { state: 'open', barrier: false } },
  });
  expect(JSON.parse(readFileSync(join(target.profile.deployRoot, 'maintenance', 'deployment-journal.json'), 'utf8'))).toMatchObject({
    operation: 'cutover', phase: 'restored', snapshotId: output.cutover.snapshotId,
  });
}, 120_000);

it('restores the original release when candidate proxy verification cannot start before reopening', async () => {
  const target = await createTarget();
  const releaseA = installManagedCurrentRelease(target, 'release-a');
  const source = candidateRepository(target, 'candidate-proxy-start-failure');
  const prepared = await prepareCandidate(target, source);
  const originalCaddyfile = readFileSync(target.activeConfiguration[0]!);
  const commandsBefore = target.controller.commands().length;
  target.controller.failNextStart('proxy');

  const result = await cli(target, source, 'deploy', '--candidate', prepared, '--json');

  expect(result.code).toBe(1);
  expect(JSON.parse(result.out)).toMatchObject({ cutover: { state: 'restored', code: 'service-command-failed' } });
  expect(readlinkSync(target.current)).toBe(`releases/${releaseA}`);
  expect(readFileSync(target.activeConfiguration[0]!)).toEqual(originalCaddyfile);
  const commands = target.controller.commands().slice(commandsBefore);
  const candidateStart = commands.indexOf('start baox.service');
  const proxyProbe = commands.indexOf('start baox-caddy.service');
  expect(candidateStart).toBeGreaterThan(-1);
  expect(proxyProbe).toBeGreaterThan(candidateStart);
  expect((await fetch(`${target.controller.publicUrl}/api/session`)).status).toBeLessThan(500);
  await expect(new SshHostTransport({ profile: target.profile, runner: target.runner.run }).execute({ kind: 'gate-status' })).resolves.toMatchObject({
    kind: 'gate-status', value: { kind: 'available', response: { state: 'open', barrier: false } },
  });
}, 120_000);

it('restores the original release when a reachable candidate proxy returns a non-session 404 before reopening', async () => {
  const target = await createTarget();
  const releaseA = installManagedCurrentRelease(target, 'release-a');
  const source = candidateRepository(target, 'candidate-wrong-proxy-session');
  const prepared = await prepareCandidate(target, source);
  target.controller.serveWrongSessionUntilReopen();

  const result = await cli(target, source, 'deploy', '--candidate', prepared, '--json');

  expect(result.code).toBe(1);
  expect(JSON.parse(result.out)).toMatchObject({ cutover: { state: 'restored', code: 'service-verification-failed' } });
  expect(readlinkSync(target.current)).toBe(`releases/${releaseA}`);
  const response = await fetch(`${target.controller.publicUrl}/api/session`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: 'setup_required', account: null });
  await expect(new SshHostTransport({ profile: target.profile, runner: target.runner.run }).execute({ kind: 'gate-status' })).resolves.toMatchObject({
    kind: 'gate-status', value: { kind: 'available', response: { state: 'open', barrier: false } },
  });
}, 120_000);

it('keeps the maintenance barrier closed when verified original recovery cannot restart', async () => {
  const target = await createTarget();
  const releaseA = installManagedCurrentRelease(target, 'release-a');
  const source = candidateRepository(target, 'candidate-recovery-start-failure', { failRecoveryStart: true });
  const prepared = await prepareCandidate(target, source);

  const failed = await cli(target, source, 'deploy', '--candidate', prepared, '--json');

  expect(failed.code).toBe(1);
  expect(JSON.parse(failed.out)).toMatchObject({ cutover: { state: 'recovery-required', code: 'service-command-failed' } });
  expect(readlinkSync(target.current)).toBe(`releases/${releaseA}`);
  await expect(fetch(`${target.controller.publicUrl}/api/session`)).rejects.toThrow();
  await expect(new SshHostTransport({ profile: target.profile, runner: target.runner.run }).execute({ kind: 'status' })).resolves.toMatchObject({
    kind: 'status', value: { baoxService: 'inactive', caddyService: 'inactive' },
  });
  expect(JSON.parse(readFileSync(join(target.profile.deployRoot, 'maintenance', 'deployment-journal.json'), 'utf8'))).toMatchObject({
    operation: 'cutover', phase: 'recovery-required', failure: 'service-command-failed',
  });

  const retried = await cli(target, source, 'deploy', '--candidate', prepared, '--json');

  expect(retried.code).toBe(1);
  expect(JSON.parse(retried.out)).toMatchObject({ reconciliation: true, cutover: { state: 'recovery-required', code: 'service-command-failed' } });
  await expect(fetch(`${target.controller.publicUrl}/api/session`)).rejects.toThrow();
}, 120_000);

it('retries the same candidate after a terminal ERP-admission refusal clears', async () => {
  const target = await createTarget();
  installManagedCurrentRelease(target, 'release-a');
  const source = candidateRepository(target, 'candidate-admission-retry');
  const prepared = await prepareCandidate(target, source);
  target.controller.refuseNextAdmission();

  const refused = await cli(target, source, 'deploy', '--candidate', prepared, '--json');

  expect(refused.code).toBe(1);
  expect(JSON.parse(refused.out)).toMatchObject({
    cutover: { state: 'refused', code: 'active_erp_attempt' },
  });
  expect(JSON.parse(readFileSync(join(target.profile.deployRoot, 'maintenance', 'deployment-journal.json'), 'utf8'))).toMatchObject({
    operation: 'cutover', phase: 'refused', candidateId: prepared,
  });
  await expect(new SshHostTransport({ profile: target.profile, runner: target.runner.run }).execute({ kind: 'gate-status' })).resolves.toMatchObject({
    kind: 'gate-status', value: { kind: 'available', response: { state: 'open', barrier: false } },
  });

  const retried = await cli(target, source, 'deploy', '--candidate', prepared, '--json');

  expect(retried.code, `${retried.out}\n${retried.err}`).toBe(0);
  expect(JSON.parse(retried.out)).toMatchObject({
    reconciliation: true,
    cutover: { state: 'verified', candidateId: prepared },
  });
  expect(verifiedSnapshots(target)).toHaveLength(1);
}, 120_000);

it('retries a terminal pre-admission capacity failure without restoring a nonexistent snapshot', async () => {
  const target = await createTarget({ snapshotAvailableBytes: 0 });
  installManagedCurrentRelease(target, 'release-a');
  const source = candidateRepository(target, 'candidate-capacity-retry');
  const prepared = await prepareCandidate(target, source);

  const failed = await cli(target, source, 'deploy', '--candidate', prepared, '--json');

  expect(failed.code).toBe(1);
  expect(JSON.parse(failed.out)).toMatchObject({ cutover: { state: 'failed', code: 'insufficient-capacity' } });
  expect(JSON.parse(readFileSync(join(target.profile.deployRoot, 'maintenance', 'deployment-journal.json'), 'utf8'))).toMatchObject({
    operation: 'cutover', phase: 'failed', candidateId: prepared,
  });
  await expect(new SshHostTransport({ profile: target.profile, runner: target.runner.run }).execute({ kind: 'gate-status' })).resolves.toMatchObject({
    kind: 'gate-status', value: { kind: 'available', response: { state: 'open', barrier: false } },
  });

  target.runner.setSnapshotAvailableBytes(undefined);
  const retried = await cli(target, source, 'deploy', '--candidate', prepared, '--json');

  expect(retried.code, `${retried.out}\n${retried.err}`).toBe(0);
  expect(JSON.parse(retried.out)).toMatchObject({
    reconciliation: true,
    cutover: { state: 'verified', candidateId: prepared },
  });
}, 120_000);

it('reconciles an interrupted pre-access switch through the CLI without taking a second snapshot', async () => {
  const target = await createTarget();
  const releaseA = installManagedCurrentRelease(target, 'release-a');
  const source = candidateRepository(target, 'candidate-interrupted-switch');
  const prepared = await prepareCandidate(target, source);
  target.runner.interruptNextCutoverAtPhase = 'candidate-switched';

  const interrupted = await cli(target, source, 'deploy', '--candidate', prepared, '--json');

  expect(interrupted.code).toBe(3);
  await waitFor(() => {
    const journal = join(target.profile.deployRoot, 'maintenance', 'deployment-journal.json');
    return existsSync(journal) && (JSON.parse(readFileSync(journal, 'utf8')) as { operation?: string; phase?: string }).operation === 'cutover'
      && (JSON.parse(readFileSync(journal, 'utf8')) as { phase?: string }).phase === 'candidate-switched';
  });
  const snapshotsBeforeReconciliation = verifiedSnapshots(target).length;

  const reconciled = await cli(target, source, 'deploy', '--candidate', prepared, '--json');

  expect(reconciled.code).toBe(1);
  expect(JSON.parse(reconciled.out)).toMatchObject({ reconciliation: true, cutover: { state: 'restored', candidateId: prepared } });
  expect(readlinkSync(target.current)).toBe(`releases/${releaseA}`);
  expect(verifiedSnapshots(target)).toHaveLength(snapshotsBeforeReconciliation);
  expect((await fetch(`${target.controller.publicUrl}/api/session`)).status).toBeLessThan(500);
}, 120_000);

it('hands post-access uncertainty to an operator without restoring post-reopen SQLite or blob writes', async () => {
  const target = await createTarget();
  installManagedCurrentRelease(target, 'release-a');
  const source = candidateRepository(target, 'candidate-post-access-mutation', { mutateAfterReopen: true });
  const prepared = await prepareCandidate(target, source);
  const postAccessBlob = createHash('sha256').update('candidate post-access blob mutation\n').digest('hex');

  const interrupted = await cli(target, source, 'deploy', '--candidate', prepared, '--json');

  expect(interrupted.code).toBe(1);
  expect(JSON.parse(interrupted.out)).toMatchObject({
    cutover: { state: 'post-access-handoff', candidateId: prepared, code: 'maintenance-gate-unavailable' },
  });
  expect(readlinkSync(target.current)).toBe(`releases/${prepared}`);
  expect(existsSync(join(target.barrier, 'post-reopen-mutation-applied'))).toBe(true);
  expect(sqliteTablePresent(target.dataDir, 'cutover_test_post_access_mutation')).toBe(true);
  expect(existsSync(join(target.dataDir, 'files', 'sha256', postAccessBlob.slice(0, 2), postAccessBlob))).toBe(true);
  expect((await fetch(`${target.controller.publicUrl}/api/session`)).status).toBeLessThan(500);
  expect(JSON.parse(readFileSync(join(target.profile.deployRoot, 'maintenance', 'deployment-journal.json'), 'utf8'))).toMatchObject({
    operation: 'cutover', phase: 'post-access-handoff',
  });

  const reconciled = await cli(target, source, 'deploy', '--candidate', prepared, '--json');

  expect(reconciled.code).toBe(0);
  expect(JSON.parse(reconciled.out)).toMatchObject({ reconciliation: true, cutover: { state: 'verified', candidateId: prepared } });
  expect(readlinkSync(target.current)).toBe(`releases/${prepared}`);
  expect(sqliteTablePresent(target.dataDir, 'cutover_test_post_access_mutation')).toBe(true);
  expect(existsSync(join(target.dataDir, 'files', 'sha256', postAccessBlob.slice(0, 2), postAccessBlob))).toBe(true);
}, 120_000);

it('lets a cutover continue after a transport-only disconnect and reconciles the completed result without a second snapshot', async () => {
  const target = await createTarget();
  installManagedCurrentRelease(target, 'release-a');
  const source = candidateRepository(target, 'candidate-disconnect');
  const candidateId = await prepareCandidate(target, source);
  target.runner.disconnectNextCutoverTransportOnly = true;

  const interrupted = await cli(target, source, 'deploy', '--candidate', candidateId, '--json');

  expect(interrupted.code).toBe(3);
  await waitFor(() => {
    if (readlinkSync(target.current) !== `releases/${candidateId}`) return false;
    if (!target.controller.commands().includes('start baox-caddy.service')) return false;
    const journal = join(target.profile.deployRoot, 'maintenance', 'deployment-journal.json');
    if (!existsSync(journal)) return false;
    const value = JSON.parse(readFileSync(journal, 'utf8')) as { operation?: string; phase?: string };
    return value.operation === 'cutover' && value.phase === 'completed'
      && !existsSync(join(target.profile.deployRoot, 'maintenance', 'deployment.lock'));
  });
  const snapshotsBeforeReconcile = verifiedSnapshots(target).length;

  const reconciled = await cli(target, source, 'deploy', '--candidate', candidateId, '--json');

  expect(reconciled.code, `${reconciled.out}\n${reconciled.err}`).toBe(0);
  expect(JSON.parse(reconciled.out)).toMatchObject({ cutover: { state: 'verified', candidateId } });
  expect(verifiedSnapshots(target)).toHaveLength(snapshotsBeforeReconcile);
}, 120_000);

async function createTarget(options: Parameters<typeof createSnapshotIsolatedTarget>[0] = {}): Promise<SnapshotIsolatedTarget> {
  const target = await createSnapshotIsolatedTarget(options);
  cleanup.push(() => target.close());
  return target;
}

function candidateRepository(target: SnapshotIsolatedTarget, marker: string, options: { failStart?: boolean; failRecoveryStart?: boolean; mutateBeforeFailure?: boolean; mutateAfterReopen?: boolean } = {}): string {
  const repository = mkdtempSync(join(tmpdir(), 'baox-cutover-source-'));
  cleanup.push(() => rmSync(repository, { recursive: true, force: true }));
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'user.name', 'cutover test']);
  git(repository, ['config', 'user.email', 'cutover@example.test']);
  mkdirSync(join(repository, 'deploy', 'intranet'), { recursive: true });
  writeFileSync(join(repository, '.nvmrc'), process.versions.node);
  writeFileSync(join(repository, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.17.1', name: marker }) + '\n');
  writeFileSync(join(repository, '.baox-test-use-real-server'), 'use controlled real server output\n');
  if (options.failStart) writeFileSync(join(repository, '.baox-test-fail-start'), 'fail candidate start\n');
  if (options.failRecoveryStart) writeFileSync(join(repository, '.baox-test-fail-recovery-start'), 'fail restored original start\n');
  if (options.mutateBeforeFailure) writeFileSync(join(repository, '.baox-test-mutate-before-failure'), 'mutate live SQLite and blob data\n');
  if (options.mutateBeforeFailure) writeFileSync(join(repository, '.baox-test-mutate-runtime-before-failure'), 'mutate runtime link\n');
  if (options.mutateAfterReopen) writeFileSync(join(repository, '.baox-test-mutate-after-reopen'), 'mutate live SQLite and blob data after reopening\n');
  for (const file of target.activeConfiguration) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    writeFileSync(join(repository, 'deploy', 'intranet', name), Buffer.concat([readFileSync(file), Buffer.from(`\n# candidate ${marker}\n`)]));
  }
  git(repository, ['add', '.']);
  git(repository, ['commit', '--quiet', '-m', marker]);
  git(repository, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return repository;
}

async function prepareCandidate(target: SnapshotIsolatedTarget, repository: string): Promise<string> {
  const source = await createSourceRepository(repository).archive();
  const prepared = await new SshCandidateTransport({ profile: target.profile, runner: target.runner.run }).prepare({
    source,
    artifact: source.archive,
    artifactOrigin: 'direct',
  });
  if (prepared.state !== 'prepared') {
    const candidate = `${source.plan.commit.slice(0, 12)}-${source.plan.archiveSha256.slice(0, 12)}`;
    const log = join(target.profile.deployRoot, 'candidates', candidate, 'worker.log');
    throw new Error(`candidate did not prepare: ${JSON.stringify(prepared)}\n${existsSync(log) ? readFileSync(log, 'utf8') : ''}`);
  }
  return prepared.candidateId;
}

async function cli(target: SnapshotIsolatedTarget, repository: string, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runOperatorCli(
    argv,
    {
      source: createSourceRepository(repository),
      host: new SshHostTransport({ profile: target.profile, runner: target.runner.run }),
      candidate: new SshCandidateTransport({ profile: target.profile, runner: target.runner.run }),
      cutover: new SshCutoverTransport({ profile: target.profile, runner: target.runner.run }),
    },
    { out: (line) => out.push(line), err: (line) => err.push(line) },
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function installManagedCurrentRelease(target: SnapshotIsolatedTarget, releaseId: string): string {
  const releaseRoot = join(target.profile.deployRoot, 'releases');
  const activeReference = readlinkSync(target.current);
  const active = join(target.profile.deployRoot, activeReference);
  const release = join(releaseRoot, releaseId);
  mkdirSync(release, { recursive: true });
  for (const name of ['server', 'web', 'extension', 'deploy']) symlinkSync(join(active, name), join(release, name), 'dir');
  unlinkSync(target.current);
  symlinkSync(`releases/${releaseId}`, target.current);
  return releaseId;
}

function verifiedSnapshots(target: SnapshotIsolatedTarget): string[] {
  const root = join(target.profile.deployRoot, 'recovery-snapshots');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^snapshot-[a-f0-9-]{29,80}$/iu.test(entry.name) && existsSync(join(root, entry.name, 'manifest.json')))
    .map((entry) => entry.name);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for cutover coordinator');
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function sqliteTablePresent(dataDir: string, tableName: string): boolean {
  const betterSqlite = fileURLToPath(new URL('../../../server/node_modules/better-sqlite3', import.meta.url));
  const script = `const Database = require(${JSON.stringify(betterSqlite)});
const database = new Database(process.argv[1], { readonly: true });
const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(process.argv[2]);
database.close();
process.stdout.write(table ? 'present' : 'absent');`;
  return execFileSync(process.execPath, ['-e', script, join(dataDir, 'baox.sqlite'), tableName], { encoding: 'utf8' }).trim() === 'present';
}
