import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
const require = createRequire(import.meta.url);

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
  const dataMetadata = JSON.parse(readFileSync(join(result.manifest, '..', 'recovery', 'data-metadata.json'), 'utf8')) as DataMetadata;
  const sourceData = statSync(target.dataDir);
  const sourceBlob = statSync(blob);
  const blobRelative = relative(target.dataDir, blob);
  expect(manifest.recovery.dataMetadata).toMatchObject({ path: 'recovery/data-metadata.json' });
  expect(dataMetadata.root).toEqual({ path: '.', mode: sourceData.mode & 0o777, owner: { uid: sourceData.uid, gid: sourceData.gid } });
  expect(dataMetadata.directories).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: 'files' }),
  ]));
  expect(dataMetadata.files).toEqual(expect.arrayContaining([
    { path: blobRelative, mode: sourceBlob.mode & 0o777, owner: { uid: sourceBlob.uid, gid: sourceBlob.gid } },
  ]));
  expect(manifest.recovery.configuration).toHaveLength(3);
  expect(manifest.recovery.configuration.map((entry) => entry.path)).toEqual([
    'recovery/configuration/caddyfile',
    'recovery/configuration/baox-service',
    'recovery/configuration/baox-caddy-service',
  ]);
  expect(statSync(result.manifest).mode & 0o777).toBe(0o600);
  expect(statSync(join(result.manifest, '..', 'data')).mode & 0o777).toBe(0o700);
  expect(statSync(join(result.manifest, '..', 'data', blobRelative)).mode & 0o777).toBe(0o600);
  expect(statSync(join(result.manifest, '..', 'recovery')).mode & 0o777).toBe(0o700);
  expect(statSync(join(result.manifest, '..', 'recovery', 'runtime-state.json')).mode & 0o777).toBe(0o600);
  expect(statSync(join(result.manifest, '..', 'recovery', 'data-metadata.json')).mode & 0o777).toBe(0o600);
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

it('pairs each snapshot with its original release and retains current plus recoverable releases across A to B to C', async () => {
  const target = await createTarget();
  const releaseA = installManagedCurrentRelease(target, 'release-a');
  const candidateB = await prepareCandidate(target, 'b');
  const snapshotA = await new SshSnapshotTransport({ profile: target.profile, runner: target.runner.run }).snapshot({ candidateId: candidateB, retention: 1 });
  if (snapshotA.state !== 'verified') throw new Error(`A snapshot did not verify: ${JSON.stringify(snapshotA)}`);
  expect((JSON.parse(readFileSync(snapshotA.manifest, 'utf8')) as RecoveryManifest).original.release).toBe(`releases/${releaseA}`);
  expect(readManagedRecoveryPair(target, releaseA)).toMatchObject({
    releaseId: releaseA,
    originalRelease: `releases/${releaseA}`,
    candidateId: candidateB,
    snapshotId: snapshotA.snapshotId,
  });

  installManagedCurrentRelease(target, candidateB);
  const candidateC = await prepareCandidate(target, 'c');
  const snapshotB = await new SshSnapshotTransport({ profile: target.profile, runner: target.runner.run }).snapshot({ candidateId: candidateC, retention: 1 });
  if (snapshotB.state !== 'verified') throw new Error(`B snapshot did not verify: ${JSON.stringify(snapshotB)}`);
  expect((JSON.parse(readFileSync(snapshotB.manifest, 'utf8')) as RecoveryManifest).original.release).toBe(`releases/${candidateB}`);
  expect(readManagedRecoveryPair(target, candidateB)).toMatchObject({
    releaseId: candidateB,
    originalRelease: `releases/${candidateB}`,
    candidateId: candidateC,
    snapshotId: snapshotB.snapshotId,
  });

  installManagedCurrentRelease(target, candidateC);
  const candidateD = await prepareCandidate(target, 'd');
  const snapshotC = await new SshSnapshotTransport({ profile: target.profile, runner: target.runner.run }).snapshot({ candidateId: candidateD, retention: 1 });
  if (snapshotC.state !== 'verified') throw new Error(`C snapshot did not verify: ${JSON.stringify(snapshotC)}`);
  expect(readManagedRecoveryPair(target, candidateC)).toMatchObject({
    releaseId: candidateC,
    originalRelease: `releases/${candidateC}`,
    candidateId: candidateD,
    snapshotId: snapshotC.snapshotId,
  });

  const releaseRoot = join(target.profile.deployRoot, 'releases');
  const snapshotRoot = join(target.profile.deployRoot, 'recovery-snapshots');
  expect(readlinkSync(target.current)).toBe(`releases/${candidateC}`);
  expect(existsSync(join(releaseRoot, candidateC))).toBe(true);
  expect(existsSync(join(snapshotRoot, snapshotC.snapshotId))).toBe(true);
  expect(existsSync(join(releaseRoot, candidateB))).toBe(true);
  expect(existsSync(join(snapshotRoot, snapshotB.snapshotId))).toBe(true);
  expect(existsSync(join(releaseRoot, releaseA))).toBe(false);
  expect(existsSync(join(snapshotRoot, snapshotA.snapshotId))).toBe(false);
}, 120_000);

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

it('keeps a cutover caller lease after a held snapshot admission is refused', async () => {
  const target = await createTarget();
  const candidateId = await prepareCandidate(target);
  const refusalWrapper = join(target.root, 'refuse-maintenance-gate');
  writeFileSync(refusalWrapper, [
    '#!/bin/sh',
    'printf \'%s\\n\' \'{"version":1,"state":"refused","barrier":false,"activeWrites":0,"activeErpAttempt":false,"reason":"test-refusal"}\'',
  ].join('\n'), { mode: 0o755 });
  const request = {
    schema: 1,
    kind: 'snapshot',
    deployRoot: target.profile.deployRoot,
    dataDir: target.profile.dataDir,
    systemdDir: target.profile.systemdDir,
    buildEnvironment: target.profile.buildEnvironment,
    buildPython: target.profile.buildPython,
    maintenanceWrapper: refusalWrapper,
    candidateId,
    snapshotId: managedSnapshotId(candidateId, '0000000000000020'),
    completion: 'hold',
    retention: 1,
  };
  const coordinator = coordinatorLibrary();
  const paths = coordinator.targetPaths(request);
  const lock = await coordinator.acquireDeploymentLease({ ...request, externalLock: true, operation: 'cutover' }, paths);
  if (lock.kind !== 'acquired' || !lock.lease) throw new Error(`cutover lease did not acquire: ${JSON.stringify(lock)}`);

  const result = await coordinator.runSnapshotLifecycle(request, paths, lock.lease, { completion: 'hold' });

  expect(result).toMatchObject({ state: 'refused', code: 'test-refusal' });
  await expect(coordinator.requireLease(paths, lock.lease)).resolves.toBeUndefined();
  expect(target.controller.commands()).not.toContain('stop baox-caddy.service');
}, 90_000);

async function createTarget(options: Parameters<typeof createSnapshotIsolatedTarget>[0] = {}): Promise<SnapshotIsolatedTarget> {
  const target = await createSnapshotIsolatedTarget(options);
  cleanup.push(() => target.close());
  return target;
}

async function prepareCandidate(target: SnapshotIsolatedTarget, marker = 'source'): Promise<string> {
  const repository = mkdtempSync(join(tmpdir(), 'baox-snapshot-source-'));
  cleanup.push(() => rmSync(repository, { recursive: true, force: true }));
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'user.name', 'snapshot test']);
  git(repository, ['config', 'user.email', 'snapshot@example.test']);
  writeCandidateSource(repository, marker);
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

function writeCandidateSource(repository: string, marker: string): void {
  mkdirSync(join(repository, 'deploy', 'intranet'), { recursive: true });
  writeFileSync(join(repository, '.nvmrc'), process.versions.node);
  writeFileSync(join(repository, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.17.1', name: 'snapshot-source' }) + '\n');
  writeFileSync(join(repository, 'snapshot-marker.txt'), `${marker}\n`);
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

function readManagedRecoveryPair(target: SnapshotIsolatedTarget, releaseId: string): ManagedRecoveryPair {
  return JSON.parse(readFileSync(join(target.profile.deployRoot, 'releases', releaseId, 'recovery.json'), 'utf8')) as ManagedRecoveryPair;
}

function coordinatorLibrary(): CoordinatorLibrary {
  const coordinatorPath = require.resolve('./candidate-coordinator.cjs');
  const previous = process.env.BAOX_COORDINATOR_LIBRARY;
  process.env.BAOX_COORDINATOR_LIBRARY = '1';
  delete require.cache[coordinatorPath];
  try {
    return require('./candidate-coordinator.cjs') as CoordinatorLibrary;
  } finally {
    if (previous === undefined) delete process.env.BAOX_COORDINATOR_LIBRARY;
    else process.env.BAOX_COORDINATOR_LIBRARY = previous;
  }
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

type Ownership = { uid: number; gid: number };

type DataMetadata = {
  root: { path: '.'; mode: number; owner: Ownership };
  directories: Array<{ path: string; mode: number; owner: Ownership }>;
  files: Array<{ path: string; mode: number; owner: Ownership }>;
};

type ManagedRecoveryPair = {
  releaseId: string;
  originalRelease: string;
  candidateId: string;
  snapshotId: string;
};

type RecoveryManifest = {
  original: { release: string };
  inventory: { files: Array<{ path: string }> };
  recovery: { configuration: Array<{ path: string }>; dataMetadata: { path: string; sha256: string } };
};

type CoordinatorRequest = {
  candidateId: string;
};

type CoordinatorPaths = Record<string, string>;

type CoordinatorLease = { token: string };

type CoordinatorLibrary = {
  targetPaths: (request: CoordinatorRequest) => CoordinatorPaths;
  acquireDeploymentLease: (request: CoordinatorRequest & { externalLock: true; operation: string }, paths: CoordinatorPaths) => Promise<{ kind: string; lease?: CoordinatorLease }>;
  runSnapshotLifecycle: (request: CoordinatorRequest, paths: CoordinatorPaths, lease: CoordinatorLease, options: { completion: 'hold' }) => Promise<unknown>;
  requireLease: (paths: CoordinatorPaths, lease: CoordinatorLease) => Promise<void>;
};
