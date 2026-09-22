import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SshCandidateTransport } from './candidate.js';
import { SshHostTransport } from './host.js';
import { SshSnapshotTransport } from './snapshot.js';
import { createSourceRepository } from './source.js';
import { createSnapshotIsolatedTarget, type SnapshotIsolatedTarget } from './testing/isolated-target.js';
import { blobPath, writeBlob } from '../../../server/src/data-dir.js';

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const remove of cleanup.splice(0).reverse()) await remove();
});

it('creates a complete external recovery snapshot, rehearses its isolated reopening, and restores the unchanged original service', async () => {
  const target = await createTarget();
  const candidateId = await prepareCandidate(target);
  const blob = blobPath(target.dataDir, writeBlob(target.dataDir, Buffer.from('snapshot invoice original\n')));
  const commandsBefore = target.controller.commands().length;

  const result = await new SshSnapshotTransport({ profile: target.profile, runner: target.runner.run }).snapshot({ candidateId });

  if (result.state !== 'verified') throw new Error(`snapshot did not verify: ${JSON.stringify(result)}`);
  expect(result).toMatchObject({ state: 'verified', completion: 'reopen' });
  const manifest = JSON.parse(readFileSync(result.manifest, 'utf8')) as RecoveryManifest;
  const archivedPaths = manifest.inventory.files.map((entry) => entry.path);
  expect(manifest).toMatchObject({
    schema: 1,
    kind: 'recovery-snapshot',
    candidateId,
    archive: { result: 'ok' },
    database: { result: 'ok' },
    rehearsal: {
      state: 'verified',
      isolatedGate: { durableWrites: ['reopen', 'admit', 'reopen'], finalState: 'open' },
    },
  });
  expect(archivedPaths).toContain('baox.sqlite');
  expect(archivedPaths).toContain(relative(target.dataDir, blob));
  expect(readFileSync(join(result.manifest, '..', 'data', relative(target.dataDir, blob)))).toEqual(readFileSync(blob));
  expect(manifest.recovery.configuration).toHaveLength(3);
  expect(manifest.recovery.configuration.map((entry) => entry.path)).toEqual([
    'recovery/configuration/caddyfile',
    'recovery/configuration/baox-service',
    'recovery/configuration/baox-caddy-service',
  ]);
  expect(statSync(result.manifest).mode & 0o777).toBe(0o600);
  expect(statSync(join(result.manifest, '..', 'recovery')).mode & 0o777).toBe(0o700);
  expect(statSync(join(result.manifest, '..', 'recovery', 'runtime-state.json')).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(manifest)).not.toContain('candidate-test-maintenance-token');
  for (const entry of manifest.recovery.configuration) {
    expect(statSync(join(result.manifest, '..', entry.path)).mode & 0o777).toBe(0o600);
  }

  const commands = target.controller.commands().slice(commandsBefore);
  expect(commands).toEqual(expect.arrayContaining([
    'stop baox-caddy.service',
    'stop baox.service',
    'start baox.service',
    'start baox-caddy.service',
  ]));
  expect((await fetch(`${target.controller.serviceUrl}/api/session`)).status).toBeLessThan(500);
  expect((await fetch(`${target.controller.publicUrl}/api/session`)).status).toBeLessThan(500);
  await expect(new SshHostTransport({ profile: target.profile, runner: target.runner.run }).execute({ kind: 'gate-status' })).resolves.toMatchObject({
    kind: 'gate-status',
    value: { kind: 'available', response: { state: 'open', barrier: false, activeWrites: 0, activeErpAttempt: false } },
  });
}, 90_000);

it('refuses a snapshot root symlink that aliases the live data directory before maintenance admission', async () => {
  const target = await createTarget();
  const candidateId = await prepareCandidate(target);
  const snapshotRoot = join(target.profile.deployRoot, 'recovery-snapshots');
  symlinkSync(target.dataDir, snapshotRoot, 'dir');
  const commandsBefore = target.controller.commands().length;

  const result = await new SshSnapshotTransport({ profile: target.profile, runner: target.runner.run }).snapshot({ candidateId });

  expect(result).toEqual({ state: 'failed', code: 'snapshot-location-symlink' });
  expect(target.controller.commands().slice(commandsBefore)).not.toContain('stop baox-caddy.service');
  await expect(new SshHostTransport({ profile: target.profile, runner: target.runner.run }).execute({ kind: 'gate-status' })).resolves.toMatchObject({
    kind: 'gate-status',
    value: { kind: 'available', response: { state: 'open', barrier: false } },
  });
}, 90_000);

it('refuses insufficient external capacity before maintenance admission or retention deletion', async () => {
  const target = await createTarget({ snapshotAvailableBytes: 0 });
  const candidateId = await prepareCandidate(target);
  const commandsBefore = target.controller.commands().length;

  const result = await new SshSnapshotTransport({ profile: target.profile, runner: target.runner.run }).snapshot({ candidateId });

  expect(result).toEqual({ state: 'failed', code: 'insufficient-capacity' });
  expect(target.controller.commands().slice(commandsBefore)).not.toContain('stop baox-caddy.service');
  await expect(new SshHostTransport({ profile: target.profile, runner: target.runner.run }).execute({ kind: 'gate-status' })).resolves.toMatchObject({
    kind: 'gate-status',
    value: { kind: 'available', response: { state: 'open', barrier: false } },
  });
}, 90_000);

it('retains the current and most recent recoverable managed release pairs when retention is one', async () => {
  const target = await createTarget();
  const currentReleaseId = installManagedCurrentRelease(target, 'release-current');
  const candidateId = await prepareCandidate(target);
  const currentSnapshotId = managedSnapshotId(candidateId, '0000000000000001');
  const recoverableSnapshotId = managedSnapshotId(candidateId, '0000000000000002');
  const obsoleteSnapshotId = managedSnapshotId(candidateId, '0000000000000003');
  seedManagedRecoveryPair(target, {
    releaseId: currentReleaseId,
    candidateId,
    snapshotId: currentSnapshotId,
    completedAt: '2026-01-03T00:00:00.000Z',
  });
  seedManagedRecoveryPair(target, {
    releaseId: 'release-recoverable',
    candidateId,
    snapshotId: recoverableSnapshotId,
    completedAt: '2026-01-02T00:00:00.000Z',
  });
  seedManagedRecoveryPair(target, {
    releaseId: 'release-obsolete',
    candidateId,
    snapshotId: obsoleteSnapshotId,
    completedAt: '2026-01-01T00:00:00.000Z',
  });

  const result = await new SshSnapshotTransport({ profile: target.profile, runner: target.runner.run }).snapshot({ candidateId, retention: 1 });

  expect(result).toMatchObject({ state: 'verified', completion: 'reopen' });
  const releaseRoot = join(target.profile.deployRoot, 'releases');
  const snapshotRoot = join(target.profile.deployRoot, 'recovery-snapshots');
  expect(existsSync(join(releaseRoot, currentReleaseId))).toBe(true);
  expect(existsSync(join(snapshotRoot, currentSnapshotId))).toBe(true);
  expect(existsSync(join(releaseRoot, 'release-recoverable'))).toBe(true);
  expect(existsSync(join(snapshotRoot, recoverableSnapshotId))).toBe(true);
  expect(existsSync(join(releaseRoot, 'release-obsolete'))).toBe(false);
  expect(existsSync(join(snapshotRoot, obsoleteSnapshotId))).toBe(false);
}, 90_000);

it('keeps public access closed and requires reconciliation after the coordinator dies during admission', async () => {
  const target = await createTarget();
  const candidateId = await prepareCandidate(target);
  const snapshotId = managedSnapshotId(candidateId, '0000000000000010');
  const transport = new SshSnapshotTransport({ profile: target.profile, runner: target.runner.run });
  const commandsBeforeInterruption = target.controller.commands().length;
  target.runner.disconnectNextSnapshot = true;

  await expect(transport.snapshot({ candidateId, snapshotId })).rejects.toThrow('恢复快照无法完成');
  await waitForCondition(() => target.controller.commands().includes('stop baox.service'));
  const stopCountBeforeReconcile = target.controller.commands().filter((command) => command === 'stop baox.service').length;
  const journalPath = join(target.profile.deployRoot, 'maintenance', 'deployment-journal.json');
  const journalBeforeInspection = readFileSync(journalPath, 'utf8');

  // `report` must not resolve an interrupted maintenance window or mutate its journal.
  await new SshCandidateTransport({ profile: target.profile, runner: target.runner.run }).inspect();
  expect(readFileSync(journalPath, 'utf8')).toBe(journalBeforeInspection);

  const reconciled = await transport.snapshot({ candidateId, snapshotId });

  expect(reconciled).toEqual({ state: 'reconcile-needed', code: 'snapshot-interrupted-with-maintenance-barrier' });
  expect(target.controller.commands().filter((command) => command === 'stop baox.service')).toHaveLength(stopCountBeforeReconcile);
  const interruptionCommands = target.controller.commands().slice(commandsBeforeInterruption);
  expect(interruptionCommands).toContain('stop baox-caddy.service');
  expect(interruptionCommands).not.toContain('start baox-caddy.service');
  expect(JSON.parse(readFileSync(journalPath, 'utf8'))).toMatchObject({
    schema: 1,
    operation: 'recovery-snapshot',
    phase: 'recovery-required',
    failure: 'snapshot-interrupted-requires-reconciliation',
  });
}, 90_000);

async function createTarget(options: Parameters<typeof createSnapshotIsolatedTarget>[0] = {}): Promise<SnapshotIsolatedTarget> {
  const target = await createSnapshotIsolatedTarget(options);
  cleanup.push(() => target.close());
  return target;
}

async function prepareCandidate(target: SnapshotIsolatedTarget): Promise<string> {
  const repository = mkdtempSync(join(tmpdir(), 'baox-snapshot-source-'));
  cleanup.push(() => rmSync(repository, { recursive: true, force: true }));
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'user.name', 'snapshot test']);
  git(repository, ['config', 'user.email', 'snapshot@example.test']);
  writeCandidateSource(repository);
  git(repository, ['add', '.']);
  git(repository, ['commit', '--quiet', '-m', 'snapshot source']);
  git(repository, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  const source = await createSourceRepository(repository).archive();
  const prepared = await new SshCandidateTransport({ profile: target.profile, runner: target.runner.run }).prepare({
    source,
    artifact: source.archive,
    artifactOrigin: 'direct',
  });
  expect(prepared.state).toBe('prepared');
  if (prepared.state !== 'prepared') throw new Error('candidate preparation failed');
  return prepared.candidateId;
}

function writeCandidateSource(repository: string): void {
  mkdirSync(join(repository, 'deploy', 'intranet'), { recursive: true });
  writeFileSync(join(repository, '.nvmrc'), process.versions.node);
  writeFileSync(join(repository, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.17.1', name: 'snapshot-source' }) + '\n');
  writeFileSync(join(repository, 'deploy', 'intranet', 'Caddyfile'), 'http://10.250.0.222 {\n  respond "candidate"\n}\n');
  writeFileSync(join(repository, 'deploy', 'intranet', 'baox.service'), '[Service]\nEnvironment=BAOX_PUBLIC_ORIGIN=http://10.250.0.222\n');
  writeFileSync(join(repository, 'deploy', 'intranet', 'baox-caddy.service'), '[Service]\n');
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function installManagedCurrentRelease(target: SnapshotIsolatedTarget, releaseId: string): string {
  const releaseRoot = join(target.profile.deployRoot, 'releases');
  const activeRelease = readlinkSync(target.current);
  const activePath = join(target.profile.deployRoot, activeRelease);
  const release = join(releaseRoot, releaseId);
  mkdirSync(release, { recursive: true });
  for (const name of ['server', 'web', 'extension', 'deploy']) symlinkSync(join(activePath, name), join(release, name), 'dir');
  unlinkSync(target.current);
  symlinkSync(`releases/${releaseId}`, target.current);
  return releaseId;
}

function seedManagedRecoveryPair(target: SnapshotIsolatedTarget, pair: {
  releaseId: string;
  candidateId: string;
  snapshotId: string;
  completedAt: string;
}): void {
  const release = join(target.profile.deployRoot, 'releases', pair.releaseId);
  const snapshot = join(target.profile.deployRoot, 'recovery-snapshots', pair.snapshotId);
  mkdirSync(release, { recursive: true });
  mkdirSync(snapshot, { recursive: true });
  writeFileSync(join(release, 'recovery.json'), JSON.stringify({
    schema: 1,
    kind: 'managed-release-recovery',
    releaseId: pair.releaseId,
    candidateId: pair.candidateId,
    snapshotId: pair.snapshotId,
    completedAt: pair.completedAt,
  }, null, 2) + '\n');
  writeFileSync(join(snapshot, 'manifest.json'), JSON.stringify({
    schema: 1,
    kind: 'recovery-snapshot',
    snapshotId: pair.snapshotId,
    candidateId: pair.candidateId,
    createdAt: pair.completedAt,
    original: { release: `releases/${pair.releaseId}` },
    inventory: { files: [] },
    archive: { result: 'ok' },
    database: { result: 'ok' },
    rehearsal: { state: 'verified' },
  }, null, 2) + '\n');
}

function managedSnapshotId(candidateId: string, suffix: string): string {
  return `snapshot-${candidateId}-${suffix}`;
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for the interrupted snapshot command');
}

type RecoveryManifest = {
  inventory: { files: Array<{ path: string }> };
  recovery: { configuration: Array<{ path: string }> };
};
