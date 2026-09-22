'use strict';

// This file is copied next to the bundled operator CLI and executed on the
// target's isolated Node runtime. It intentionally has no project imports.
const { createHash, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCHEMA = 1;
const SNAPSHOT_OPERATION = 'recovery-snapshot';
const CANDIDATE_OPERATION = 'candidate-prepare';
const SNAPSHOT_SCHEMA = 1;
const SNAPSHOT_RETENTION = 3;
const MAX_SNAPSHOT_RETENTION = 20;
const SNAPSHOT_MARGIN_BYTES = 64 * 1024 * 1024;
const ALLOWED_BUILD_ENV = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'npm_config_registry',
  'NODE_MIRROR',
  'CADDY_DOWNLOAD',
]);

if (process.env.BAOX_COORDINATOR_LIBRARY !== '1') {
  main().catch((error) => {
    const code = error instanceof CandidateFailure ? error.code : 'internal-error';
    process.stdout.write(JSON.stringify({ state: 'failed', code }) + '\n');
    process.exitCode = 1;
  });
}

async function main() {
  // `node -e <source> receive` has no script filename in argv, whereas the
  // detached worker runs `node coordinator.cjs worker` and does have one.
  const mode = process.argv[2] || process.argv[1];
  const request = readRequest();
  if (mode === 'report') {
    writeResult(await inspect(request));
    return;
  }
  if (mode === 'receive') {
    writeResult(await receive(request));
    return;
  }
  if (mode === 'worker') {
    await worker(request);
    return;
  }
  if (mode === 'snapshot') {
    writeResult(await snapshot(request));
    return;
  }
  throw new Error('unsupported coordinator mode');
}

function readRequest() {
  const inMemory = globalThis.__BAOX_COORDINATOR_REQUEST;
  if (inMemory !== undefined) {
    validateRequest(inMemory);
    return inMemory;
  }

  const requestFile = process.env.BAOX_CANDIDATE_REQUEST_FILE;
  if (typeof requestFile !== 'string' || !path.isAbsolute(requestFile)) throw new Error('missing request');
  let request;
  try {
    request = JSON.parse(fsSync.readFileSync(requestFile, 'utf8'));
  } catch {
    throw new Error('invalid request');
  }
  validateRequest(request);
  return request;
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || request.schema !== SCHEMA) throw new Error('invalid request schema');
  for (const name of ['deployRoot', 'systemdDir', 'buildEnvironment', 'buildPython']) {
    if (typeof request[name] !== 'string' || !path.isAbsolute(request[name])) throw new Error('invalid target path');
  }
  if (request.inspect === true) return;
  if (request.kind === 'snapshot') {
    validateSnapshotRequest(request);
    return;
  }
  if (!request.source || typeof request.source !== 'object') throw new Error('invalid source');
  if (!/^[0-9a-f]{40}$/i.test(request.source.commit)) throw new Error('invalid source commit');
  if (!/^[0-9a-f]{64}$/i.test(request.source.archiveSha256)) throw new Error('invalid archive checksum');
  if (request.source.artifactOrigin !== 'direct' && request.source.artifactOrigin !== 'relay') throw new Error('invalid artifact origin');
  if (!/^[a-f0-9]{12}-[a-f0-9]{12}$/i.test(request.candidateId)) throw new Error('invalid candidate id');
}

function validateSnapshotRequest(request) {
  for (const name of ['dataDir', 'maintenanceWrapper']) {
    if (typeof request[name] !== 'string' || !path.isAbsolute(request[name])) throw new Error('invalid snapshot path');
  }
  if (!/^[a-f0-9]{12}-[a-f0-9]{12}$/i.test(request.candidateId)) throw new Error('invalid candidate id');
  if (typeof request.snapshotId !== 'string' || !/^snapshot-[a-f0-9-]{29,80}$/i.test(request.snapshotId)) throw new Error('invalid snapshot id');
  if (request.completion !== 'reopen' && request.completion !== 'hold') throw new Error('invalid snapshot completion');
  if (request.retention !== undefined && (!Number.isSafeInteger(request.retention) || request.retention < 1 || request.retention > MAX_SNAPSHOT_RETENTION)) {
    throw new Error('invalid snapshot retention');
  }
}

function targetPaths(request) {
  const maintenance = path.join(request.deployRoot, 'maintenance');
  const candidateId = typeof request.candidateId === 'string' ? request.candidateId : 'inspection';
  const candidate = path.join(request.deployRoot, 'candidates', candidateId);
  return {
    maintenance,
    lock: path.join(maintenance, 'deployment.lock'),
    journal: path.join(maintenance, 'deployment-journal.json'),
    coordinator: path.join(maintenance, 'candidate-coordinator.cjs'),
    candidate,
    request: path.join(candidate, 'request.json'),
    archive: path.join(candidate, 'source.tar'),
    partialArchive: path.join(candidate, 'source.tar.part'),
    source: path.join(candidate, 'source'),
    manifest: path.join(candidate, 'manifest.json'),
    prepared: path.join(candidate, '.prepared'),
    workerStartGate: path.join(candidate, 'worker-start'),
    log: path.join(candidate, 'worker.log'),
    recoveryConfig: path.join(candidate, 'recovery-config'),
    snapshotRoot: path.join(request.deployRoot, 'recovery-snapshots'),
    releaseRoot: path.join(request.deployRoot, 'releases'),
  };
}

async function receive(request) {
  const paths = targetPaths(request);
  const lock = await acquire(request, paths);
  if (lock.kind === 'prepared' || lock.kind === 'busy' || lock.kind === 'recovery-required' || lock.kind === 'reconcile-needed') {
    process.stdin.resume();
    return lock.result;
  }
  if (lock.kind === 'in-progress') {
    process.stdin.resume();
    return waitForTerminal(request, paths);
  }
  const lease = lock.lease;

  await requireLease(paths, lease);
  await fs.mkdir(paths.candidate, { recursive: true, mode: 0o700 });
  await fsyncDirectory(path.dirname(paths.candidate));
  await writeCoordinator(request, paths, lease);
  await writeCandidateFile(paths, lease, paths.request, JSON.stringify(request) + '\n', 0o600);

  if (lock.resumeStaged) {
    return startAndWait(request, paths, lease);
  }

  const readiness = await verifyBaseReadiness(request);
  if (!readiness.ok) {
    await writeJournal(request, paths, lease, 'failed', { readinessIssues: readiness.issues });
    await release(paths, lease);
    return { state: 'not-ready', issues: readiness.issues };
  }

  await writeJournal(request, paths, lease, 'receiving', { readiness: readiness.public });
  const received = await receiveArchive(paths.partialArchive);
  await requireLease(paths, lease);
  if (received.sha256 !== request.source.archiveSha256) {
    await removeIfPresent(paths.partialArchive);
    await writeJournal(request, paths, lease, 'failed', { failure: 'archive-checksum-mismatch' });
    await release(paths, lease);
    return { state: 'failed', code: 'archive-checksum-mismatch' };
  }
  await fs.rename(paths.partialArchive, paths.archive);
  await fsyncDirectory(paths.candidate);
  await writeJournal(request, paths, lease, 'staged', { archiveBytes: received.bytes, verifiedArchiveSha256: received.sha256 });
  return startAndWait(request, paths, lease);
}

async function startAndWait(request, paths, lease) {
  const sourceMatches = await hashFile(paths.archive).catch(() => null);
  if (sourceMatches !== request.source.archiveSha256) {
    await writeJournal(request, paths, lease, 'recovery-required', { failure: 'staged-archive-not-verifiable' });
    await release(paths, lease);
    return recoveryResult(request);
  }

  // Mark build activity before spawning. A crash in this narrow window is
  // deliberately conservative: a later prepare will not repeat an uncertain build.
  await writeJournal(request, paths, lease, 'building', { worker: null });
  await requireLease(paths, lease);
  await removeIfPresent(paths.workerStartGate);
  const logFd = fsSync.openSync(paths.log, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [paths.coordinator, 'worker'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        BAOX_CANDIDATE_REQUEST_FILE: paths.request,
        BAOX_CANDIDATE_START_GATE: paths.workerStartGate,
        BAOX_CANDIDATE_LOCK_TOKEN: lease.token,
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      },
    });
  } finally {
    fsSync.closeSync(logFd);
  }
  child.unref();
  const identity = await waitForProcessIdentity(child.pid);
  await writeOwner(paths, request, child.pid, identity, lease, true);
  await writeJournal(request, paths, lease, 'building', { worker: { pid: child.pid, startIdentity: identity } });
  // The detached worker waits for this fsync-backed gate. It cannot finish and
  // remove the lock while this receiver is still publishing its durable owner.
  await writeCandidateFile(paths, lease, paths.workerStartGate, 'ready\n', 0o600);
  return waitForTerminal(request, paths);
}

async function worker(request) {
  const paths = targetPaths(request);
  // If the receiver vanished before publishing the gate, leave its journal and
  // lock untouched. A later coordinator observes the dead owner and records the
  // conservative recovery-required result; this orphan must never remove a newer lock.
  if (!await waitForStartGate(process.env.BAOX_CANDIDATE_START_GATE)) return;
  const lease = leaseFromEnvironment();
  await requireLease(paths, lease);
  const journal = await readJson(paths.journal);
  if (!isJournalFor(journal, request) || journal.phase !== 'building') return;
  const identity = await waitForProcessIdentity(process.pid);
  await writeOwner(paths, request, process.pid, identity, lease, true);

  try {
    await writeJournal(request, paths, lease, 'extracting', { worker: { pid: process.pid, startIdentity: identity } });
    const archiveHash = await hashFile(paths.archive);
    if (archiveHash !== request.source.archiveSha256) throw new CandidateFailure('archive-checksum-mismatch');
    await requireLease(paths, lease);
    await removeIfPresent(paths.source);
    await fs.mkdir(paths.source, { recursive: true, mode: 0o700 });
    await runLogged('tar', ['-xf', paths.archive, '-C', paths.source, '--no-same-owner'], paths.candidate, {}, paths.log);
    await requireLease(paths, lease);

    const sourceInfo = await readSourceMetadata(paths.source);
    const readiness = await verifyCandidateReadiness(request, sourceInfo);
    if (!readiness.ok) throw new CandidateFailure('missing-prerequisites', readiness.issues);
    await writeJournal(request, paths, lease, 'building', {
      worker: { pid: process.pid, startIdentity: identity },
      readiness: readiness.public,
    });
    await buildCandidate(request, paths, sourceInfo, readiness.environment, lease);
    const recovery = await captureRecoveryConfiguration(request, paths, lease);
    const manifest = {
      schema: SCHEMA,
      candidateId: request.candidateId,
      preparedAt: new Date().toISOString(),
      source: {
        ref: request.source.ref,
        commit: request.source.commit,
        archiveSha256: request.source.archiveSha256,
        artifactOrigin: request.source.artifactOrigin,
        verifiedArchiveSha256: archiveHash,
      },
      runtime: readiness.public.runtime,
      buildEnvironment: readiness.public.buildEnvironment,
      recovery,
      candidateConfiguration: await candidateConfiguration(paths.source),
    };
    await writeCandidateFile(paths, lease, paths.manifest, JSON.stringify(manifest, null, 2) + '\n', 0o600);
    await writeCandidateFile(paths, lease, paths.prepared, manifest.source.archiveSha256 + '\n', 0o600);
    await writeJournal(request, paths, lease, 'prepared', { manifestSha256: await hashFile(paths.manifest) });
    await release(paths, lease);
  } catch (error) {
    const failure = error instanceof CandidateFailure ? error.code : 'build-failed';
    const issues = error instanceof CandidateFailure ? error.issues : undefined;
    await writeJournal(request, paths, lease, 'failed', { failure, ...(issues ? { readinessIssues: issues } : {}) }).catch(() => undefined);
    await release(paths, lease).catch(() => undefined);
  }
}

async function inspect(request) {
  const paths = targetPaths(request);
  const [journal, owner, lockExists] = await Promise.all([
    readJson(paths.journal),
    readJson(path.join(paths.lock, 'owner.json')),
    fs.access(paths.lock).then(() => true).catch(() => false),
  ]);
  const lock = lockExists ? lockInspection(owner) : { state: 'unlocked' };
  let manifest = null;
  if (journal && typeof journal.candidateId === 'string' && /^[a-f0-9]{12}-[a-f0-9]{12}$/i.test(journal.candidateId)) {
    manifest = await readJson(path.join(request.deployRoot, 'candidates', journal.candidateId, 'manifest.json'));
  }
  return { state: 'inspection', lock, journal: journal && journal.schema === SCHEMA && journal.operation === 'candidate-prepare' ? journal : null, manifest };
}

async function acquire(request, paths) {
  await fs.mkdir(paths.maintenance, { recursive: true, mode: 0o700 });
  if (await hasOutstandingClaim(paths)) {
    return { kind: 'reconcile-needed', result: { state: 'reconcile-needed', code: 'stale-lock-claim-needs-recovery' } };
  }

  const freshLease = await createLease(request, paths);
  if (freshLease) return reconcileOwnedLock(request, paths, freshLease);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const owner = await readJson(path.join(paths.lock, 'owner.json'));
    const journal = await readJson(paths.journal);
    const inspected = lockInspection(owner);
    if (inspected.state === 'unknown-owner') {
      return { kind: 'reconcile-needed', result: { state: 'reconcile-needed', code: 'lock-owner-not-durable' } };
    }
    if (inspected.state === 'active') {
      if (isJournalFor(journal, request) && journal.candidateId === request.candidateId) return { kind: 'in-progress' };
      return { kind: 'busy', result: { state: 'busy', operation: owner.operation, candidateId: owner.candidateId } };
    }

    const lease = await claimInactiveLock(request, paths, owner);
    if (lease) return reconcileOwnedLock(request, paths, lease);
  }
  return { kind: 'reconcile-needed', result: { state: 'reconcile-needed', code: 'lock-transition-raced' } };
}

async function snapshot(request) {
  if (request.completion === 'hold') return { state: 'failed', code: 'held-snapshot-requires-library-caller' };
  const paths = targetPaths(request);
  const lock = await acquireSnapshot(request, paths);
  if (lock.kind === 'busy' || lock.kind === 'reconcile-needed' || lock.kind === 'verified' || lock.kind === 'held') return lock.result;
  if (lock.kind === 'in-progress') return waitForSnapshotTerminal(request, paths);
  return runSnapshotLifecycle(request, paths, lock.lease, { completion: request.completion });
}

async function acquireSnapshot(request, paths) {
  await fs.mkdir(paths.maintenance, { recursive: true, mode: 0o700 });
  if (await hasOutstandingClaim(paths)) {
    return { kind: 'reconcile-needed', result: { state: 'reconcile-needed', code: 'stale-lock-claim-needs-recovery' } };
  }

  const freshLease = await createLease(request, paths);
  if (freshLease) return reconcileSnapshotLock(request, paths, freshLease);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const owner = await readJson(path.join(paths.lock, 'owner.json'));
    const journal = await readJson(paths.journal);
    const inspected = lockInspection(owner);
    if (inspected.state === 'unknown-owner') {
      return { kind: 'reconcile-needed', result: { state: 'reconcile-needed', code: 'lock-owner-not-durable' } };
    }
    if (inspected.state === 'active') {
      if (isJournalFor(journal, request)) return { kind: 'in-progress' };
      return { kind: 'busy', result: { state: 'busy', operation: owner.operation, candidateId: owner.candidateId } };
    }
    if (isSnapshotHeldJournal(journal)) {
      return { kind: 'reconcile-needed', result: { state: 'reconcile-needed', code: 'held-snapshot-requires-cutover-continuation' } };
    }
    const lease = await claimInactiveLock(request, paths, owner);
    if (lease) return reconcileSnapshotLock(request, paths, lease);
  }
  return { kind: 'reconcile-needed', result: { state: 'reconcile-needed', code: 'lock-transition-raced' } };
}

async function reconcileSnapshotLock(request, paths, lease) {
  const journal = await readJson(paths.journal);
  if (!journal) return { kind: 'acquired', lease };
  if (!isJournalFor(journal, request)) {
    if (isTerminalCandidateJournal(journal)) return { kind: 'acquired', lease };
    await release(paths, lease);
    return { kind: 'reconcile-needed', result: { state: 'reconcile-needed', code: 'lock-without-matching-journal' } };
  }
  if (journal.phase === 'reopened' && await snapshotManifestMatches(paths, journal)) {
    const gate = await observeGate(request);
    await release(paths, lease);
    if (isOpenGate(gate)) return { kind: 'verified', result: verifiedSnapshotResult(journal, paths) };
    return { kind: 'reconcile-needed', result: { state: 'reconcile-needed', code: 'snapshot-reopened-journal-with-closed-gate' } };
  }
  if (isTerminalJournal(journal)) return { kind: 'acquired', lease };
  const gate = await observeGate(request);
  const barrierMayBeClosed = !isDefinitelyOpenGate(gate);
  let publicBarrier = 'not-required';
  if (barrierMayBeClosed) {
    try {
      await systemctl('stop', 'baox-caddy.service');
      publicBarrier = 'stopped';
    } catch {
      publicBarrier = 'unconfirmed';
    }
  }
  await writeJournal(request, paths, lease, 'recovery-required', {
    failure: journal.phase === 'admission-intent' ? 'snapshot-admission-outcome-uncertain' : 'snapshot-interrupted-requires-reconciliation',
    admission: gate || { state: 'unavailable', barrier: 'unknown' },
    ...(barrierMayBeClosed ? { publicBarrier } : {}),
  }).catch(() => undefined);
  await release(paths, lease);
  return {
    kind: 'reconcile-needed',
    result: { state: 'reconcile-needed', code: barrierMayBeClosed ? 'snapshot-interrupted-with-maintenance-barrier' : 'snapshot-interrupted-before-admission-confirmed' },
  };
}

async function waitForSnapshotTerminal(request, paths) {
  for (;;) {
    const journal = await readJson(paths.journal);
    if (!isJournalFor(journal, request)) return { state: 'reconcile-needed', code: 'journal-changed' };
    if (journal.phase === 'reopened' && await snapshotManifestMatches(paths, journal)) return verifiedSnapshotResult(journal, paths);
    if (journal.phase === 'snapshot-verified-held' && await snapshotManifestMatches(paths, journal)) return heldSnapshotResult(journal, paths);
    if (journal.phase === 'recovery-required') return { state: 'reconcile-needed', code: journal.failure || 'snapshot-recovery-required' };
    await delay(100);
  }
}

function isSnapshotHeldJournal(journal) {
  return Boolean(journal && journal.schema === SCHEMA && journal.operation === SNAPSHOT_OPERATION
    && journal.phase === 'snapshot-verified-held');
}

function isTerminalJournal(journal) {
  return isTerminalCandidateJournal(journal) || Boolean(journal && journal.schema === SCHEMA && journal.operation === SNAPSHOT_OPERATION
    && (journal.phase === 'reopened' || journal.phase === 'failed' || journal.phase === 'refused'));
}

async function reconcileOwnedLock(request, paths, lease) {
  const journal = await readJson(paths.journal);
  if (!journal) return { kind: 'acquired', lease, resumeStaged: false };
  if (!isJournalFor(journal, request)) {
    if (isTerminalCandidateJournal(journal)) return { kind: 'acquired', lease, resumeStaged: false };
    await release(paths, lease);
    return { kind: 'reconcile-needed', result: { state: 'reconcile-needed', code: 'lock-without-matching-journal' } };
  }
  if (journal.phase === 'prepared' && await preparedManifestMatches(paths, request)) {
    await release(paths, lease);
    return { kind: 'prepared', result: preparedResult(request, paths) };
  }
  if (journal.phase === 'receiving') {
    await requireLease(paths, lease);
    await removeIfPresent(paths.partialArchive);
    await writeJournal(request, paths, lease, 'interrupted-before-verification', {});
    return { kind: 'acquired', lease, resumeStaged: false };
  }
  if (journal.phase === 'staged' && await hashFile(paths.archive).catch(() => null) === request.source.archiveSha256) {
    return { kind: 'acquired', lease, resumeStaged: true };
  }
  if (journal.phase === 'building' || journal.phase === 'extracting') {
    await writeJournal(request, paths, lease, 'recovery-required', { failure: 'worker-stopped-during-build' });
    await release(paths, lease);
    return { kind: 'recovery-required', result: recoveryResult(request) };
  }
  if (journal.phase === 'recovery-required') {
    await release(paths, lease);
    return { kind: 'recovery-required', result: recoveryResult(request) };
  }
  if (journal.phase === 'failed') return { kind: 'acquired', lease, resumeStaged: false };
  await release(paths, lease);
  return { kind: 'reconcile-needed', result: { state: 'reconcile-needed', code: 'unrecognized-journal-phase' } };
}

async function createLease(request, paths) {
  try {
    await fs.mkdir(paths.lock, { mode: 0o700 });
  } catch (error) {
    if (error && error.code === 'EEXIST') return null;
    throw error;
  }
  await fsyncDirectory(paths.maintenance);
  const lease = newLease();
  const identity = await waitForProcessIdentity(process.pid);
  await writeOwner(paths, request, process.pid, identity, lease);
  return lease;
}

async function claimInactiveLock(request, paths, owner) {
  const claimed = `${paths.lock}.claim-${owner.token.slice(0, 16)}-${randomBytes(8).toString('hex')}`;
  try {
    await fs.rename(paths.lock, claimed);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'EEXIST')) return null;
    throw error;
  }
  await fsyncDirectory(paths.maintenance);
  const claimedOwner = await readJson(path.join(claimed, 'owner.json'));
  if (!sameOwner(claimedOwner, owner)) {
    await restoreClaim(paths, claimed);
    return null;
  }

  try {
    await fs.mkdir(paths.lock, { mode: 0o700 });
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      await discardClaim(paths, claimed);
      return null;
    }
    throw error;
  }
  await fsyncDirectory(paths.maintenance);
  const lease = newLease();
  const identity = await waitForProcessIdentity(process.pid);
  await writeOwner(paths, request, process.pid, identity, lease);
  await discardClaim(paths, claimed);
  return lease;
}

async function restoreClaim(paths, claimed) {
  try {
    await fs.rename(claimed, paths.lock);
    await fsyncDirectory(paths.maintenance);
  } catch (error) {
    if (!error || (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY')) throw error;
  }
}

async function discardClaim(paths, claimed) {
  await fs.rm(claimed, { recursive: true, force: true });
  await fsyncDirectory(paths.maintenance);
}

async function hasOutstandingClaim(paths) {
  const prefix = `${path.basename(paths.lock)}.claim-`;
  const entries = await fs.readdir(paths.maintenance).catch(() => []);
  return entries.some((entry) => entry.startsWith(prefix));
}

function isTerminalCandidateJournal(journal) {
  return Boolean(journal && journal.schema === SCHEMA && journal.operation === CANDIDATE_OPERATION
    && (journal.phase === 'prepared' || journal.phase === 'failed'));
}

async function waitForTerminal(request, paths) {
  for (;;) {
    const journal = await readJson(paths.journal);
    if (!isJournalFor(journal, request)) return { state: 'reconcile-needed', code: 'journal-changed' };
    if (journal.phase === 'prepared') return preparedResult(request, paths);
    if (journal.phase === 'failed') return { state: 'failed', code: journal.failure || 'build-failed', ...(journal.readinessIssues ? { issues: journal.readinessIssues } : {}) };
    if (journal.phase === 'recovery-required') return recoveryResult(request);
    await delay(100);
  }
}

function preparedResult(request, paths) {
  return { state: 'prepared', candidateId: request.candidateId, manifest: paths.manifest };
}

function recoveryResult(request) {
  return {
    state: 'recovery-required',
    candidateId: request.candidateId,
    action: 'preserve-candidate-and-run-recovery-before-another-prepare',
  };
}

/**
 * Creates a recovery image while the caller owns the shared deployment lease.
 * A cutover coordinator can call this with `completion: 'hold'` and keep that
 * lease through its own switch; the standalone operator uses `reopen`.
 */
async function runSnapshotLifecycle(request, paths, lease, { completion }) {
  let admissionIntent = false;
  let barrierClosed = false;
  let proxyStopped = false;
  let serviceStopped = false;
  let original = null;
  let snapshot = null;
  try {
    original = await verifySnapshotOriginal(request, paths);
    const preflight = await preflightSnapshot(request, paths, original);
    snapshot = snapshotPaths(paths, request.snapshotId);
    await writeJournal(request, paths, lease, 'preflight', {
      preflight,
      original: snapshotOriginalSummary(original),
      snapshot: { id: request.snapshotId, manifest: snapshot.manifest },
    });

    // The gate call can persist a closed boundary even when the SSH command
    // loses its response. This checkpoint makes that ambiguity recoverable.
    await writeJournal(request, paths, lease, 'admission-intent', {});
    admissionIntent = true;
    const admission = await admitAndDrain(request);
    if (admission.kind === 'refused') {
      if (!isDefinitelyOpenGate(admission.status)) throw new CandidateFailure('maintenance-gate-refused-with-closed-barrier');
      await writeJournal(request, paths, lease, 'refused', { gate: admission.status });
      await release(paths, lease);
      return { state: 'refused', code: admission.code, gate: admission.status };
    }
    barrierClosed = true;
    await writeJournal(request, paths, lease, 'admitted', { gate: admission.status });

    await systemctl('stop', 'baox-caddy.service');
    proxyStopped = true;
    await writeJournal(request, paths, lease, 'proxy-stopped', {});

    await systemctl('stop', 'baox.service');
    serviceStopped = true;
    await writeJournal(request, paths, lease, 'service-stopped', {});

    const inventory = await collectDataInventory(request.dataDir);
    const capacity = await capacityForSnapshot(paths.snapshotRoot, inventory.bytes);
    if (!capacity.ok) throw new CandidateFailure('insufficient-capacity-after-drain');
    await writeJournal(request, paths, lease, 'snapshot-copying', { inventory: inventorySummary(inventory), capacity });
    const recovery = await createSnapshotCopy(request, paths, lease, snapshot, inventory, original);
    const archive = await verifySnapshotArchive(snapshot.data, inventory);
    await writeJournal(request, paths, lease, 'snapshot-copied', { archive, recovery: recoverySummary(recovery) });

    await writeJournal(request, paths, lease, 'rehearsal-started', {});
    const rehearsal = await rehearseSnapshot(snapshot, inventory, original);
    const archiveAfterRehearsal = await verifySnapshotArchive(snapshot.data, inventory);
    const manifest = await writeSnapshotManifest(request, paths, lease, snapshot, original, inventory, recovery, archiveAfterRehearsal, rehearsal);
    await publishSnapshot(snapshot);
    await writeJournal(request, paths, lease, 'rehearsal-verified', { manifest: snapshot.manifest, manifestSha256: await hashFile(snapshot.manifest) });

    await systemctl('start', 'baox.service');
    serviceStopped = false;
    await waitForHttp(original.loopback);
    await writeJournal(request, paths, lease, 'original-verified', {});

    const retention = await pruneVerifiedSnapshots(paths, request);
    await writeJournal(request, paths, lease, 'retention-pruned', { retention });

    if (completion === 'hold') {
      await writeJournal(request, paths, lease, 'snapshot-verified-held', { manifest: snapshot.manifest, retention });
      return { state: 'held', snapshotId: request.snapshotId, manifest: snapshot.manifest, completion: 'hold' };
    }

    await writeJournal(request, paths, lease, 'reopening', {});
    const reopened = await commandGate(request, 'reopen');
    if (!isOpenGate(reopened)) throw new CandidateFailure('maintenance-gate-did-not-reopen');
    barrierClosed = false;
    await systemctl('start', 'baox-caddy.service');
    proxyStopped = false;
    await waitForHttp(original.public);
    await writeJournal(request, paths, lease, 'reopened', { manifest: snapshot.manifest, retention, gate: reopened, verifiedAt: new Date().toISOString() });
    await release(paths, lease);
    return { state: 'verified', snapshotId: request.snapshotId, manifest: snapshot.manifest, completion: 'reopen' };
  } catch (error) {
    const failure = error instanceof CandidateFailure ? error.code : 'snapshot-failed';
    const observedGate = admissionIntent ? await observeGate(request) : null;
    const barrierMayBeClosed = barrierClosed || (admissionIntent && !isDefinitelyOpenGate(observedGate));
    if (barrierMayBeClosed && !proxyStopped) {
      try {
        await systemctl('stop', 'baox-caddy.service');
        proxyStopped = true;
      } catch {
        // The journal records an unconfirmed public barrier and leaves recovery
        // closed rather than deciding that an interrupted admission was open.
      }
    }
    const restored = barrierMayBeClosed && serviceStopped ? await restoreOriginalService(original).catch(() => false) : false;
    const phase = barrierMayBeClosed ? 'recovery-required' : 'failed';
    await writeJournal(request, paths, lease, phase, {
      failure,
      ...(admissionIntent ? { admission: observedGate || { state: 'unavailable', barrier: 'unknown' } } : {}),
      ...(barrierMayBeClosed ? { publicBarrier: proxyStopped ? 'stopped' : 'unconfirmed' } : {}),
      ...(restored ? { originalService: 'restored-with-public-barrier' } : {}),
    }).catch(() => undefined);
    // A normal snapshot never reopens from an error path. The proxy remains
    // stopped whenever admission completed, even if the original service was restored.
    if (completion !== 'hold') await release(paths, lease).catch(() => undefined);
    return { state: 'failed', code: failure, ...(barrierMayBeClosed ? { recoveryRequired: true } : {}) };
  }
}

async function admitAndDrain(request) {
  let status = await commandGate(request, 'admit');
  if (status.state === 'refused') return { kind: 'refused', code: status.reason || 'maintenance-admission-refused', status };
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (isAdmittedGate(status)) return { kind: 'admitted', status };
    if (status.state !== 'admitting' || status.barrier !== true || status.activeWrites === 'unknown' || status.activeErpAttempt === 'unknown') {
      throw new CandidateFailure('maintenance-gate-did-not-admit');
    }
    await delay(250);
    status = await commandGate(request, 'status');
    if (status.state === 'refused') return { kind: 'refused', code: status.reason || 'maintenance-admission-refused', status };
  }
  throw new CandidateFailure('maintenance-drain-timeout');
}

async function restoreOriginalService(original) {
  if (!original) return false;
  await systemctl('start', 'baox.service');
  await waitForHttp(original.loopback);
  return true;
}

async function observeGate(request) {
  try {
    return await commandGate(request, 'status');
  } catch {
    return null;
  }
}

async function verifySnapshotOriginal(request, paths) {
  const candidate = await readPreparedCandidate(paths, request.candidateId);
  const recovery = candidate.recovery;
  const current = await fs.readlink(path.join(request.deployRoot, 'current')).catch(() => null);
  if (!current || current !== recovery.activeRelease) throw new CandidateFailure('original-release-changed');

  const expectedConfiguration = new Map([
    ['caddyfile', path.join(request.deployRoot, 'etc', 'Caddyfile')],
    ['baox-service', path.join(request.systemdDir, 'baox.service')],
    ['baox-caddy-service', path.join(request.systemdDir, 'baox-caddy.service')],
  ]);
  const configuration = [];
  for (const entry of recovery.activeConfiguration) {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || typeof entry.source !== 'string' || typeof entry.sha256 !== 'string') {
      throw new CandidateFailure('candidate-recovery-configuration-invalid');
    }
    const stat = await fs.lstat(entry.source).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw new CandidateFailure('original-configuration-protection-invalid');
    if (expectedConfiguration.get(entry.name) !== entry.source || !path.isAbsolute(entry.source) || !/^[a-f0-9]{64}$/i.test(entry.sha256)
      || await hashFile(entry.source).catch(() => null) !== entry.sha256) {
      throw new CandidateFailure('original-configuration-changed');
    }
    configuration.push({ name: entry.name, source: entry.source, sha256: entry.sha256, mode: stat.mode & 0o777, owner: { uid: stat.uid, gid: stat.gid } });
  }
  if (configuration.length !== expectedConfiguration.size || new Set(configuration.map((entry) => entry.name)).size !== expectedConfiguration.size) {
    throw new CandidateFailure('candidate-recovery-configuration-incomplete');
  }
  const service = configuration.find((entry) => entry.name === 'baox-service');
  if (!service || service.source !== path.join(request.systemdDir, 'baox.service')) throw new CandidateFailure('candidate-recovery-service-missing');
  const environment = parseServiceEnvironment(await fs.readFile(service.source, 'utf8'));
  if (path.resolve(environment.BAOX_DATA_DIR || '') !== path.resolve(request.dataDir)) throw new CandidateFailure('service-data-directory-mismatch');
  const port = parsePort(environment.BAOX_PORT);
  const origin = parseOrigin(environment.BAOX_PUBLIC_ORIGIN);
  if (port === null || origin === null) throw new CandidateFailure('service-runtime-configuration-invalid');

  const executable = path.join(request.deployRoot, 'current', 'server', 'dist', 'main.mjs');
  const node = path.join(request.deployRoot, 'runtime', 'node', 'bin', 'node');
  if (!await isRegularFile(executable) || !await isExecutable(node)) throw new CandidateFailure('original-runtime-missing');
  const runtimeReference = await fs.readlink(path.join(request.deployRoot, 'runtime', 'node')).catch(() => null);
  if (recovery.runtimeReferences && typeof recovery.runtimeReferences === 'object'
    && typeof recovery.runtimeReferences.node === 'string' && recovery.runtimeReferences.node !== runtimeReference) {
    throw new CandidateFailure('original-runtime-changed');
  }
  const host = origin.host;
  const publicPort = origin.port ? Number.parseInt(origin.port, 10) : origin.protocol === 'https:' ? 443 : 80;
  return {
    release: current,
    executable: { path: executable, sha256: await hashFile(executable) },
    runtime: { nodePath: node, reference: runtimeReference, sha256: await hashFile(node), version: await commandOutput(node, ['--version']) },
    configuration,
    serviceEnvironment: environment,
    loopback: { port, host },
    public: { port: publicPort, host },
  };
}

function snapshotOriginalSummary(original) {
  return {
    release: original.release,
    executable: { sha256: original.executable.sha256 },
    runtime: { reference: original.runtime.reference, sha256: original.runtime.sha256, version: original.runtime.version },
    configuration: original.configuration.map((entry) => ({ name: entry.name, sha256: entry.sha256, mode: entry.mode, owner: entry.owner })),
  };
}

async function readPreparedCandidate(paths, candidateId) {
  const candidate = path.join(paths.maintenance, '..', 'candidates', candidateId);
  const [manifest, marker] = await Promise.all([
    readJson(path.join(candidate, 'manifest.json')),
    fs.readFile(path.join(candidate, '.prepared'), 'utf8').catch(() => null),
  ]);
  if (!manifest || manifest.schema !== SCHEMA || manifest.candidateId !== candidateId || !manifest.source
    || typeof manifest.source.archiveSha256 !== 'string' || marker?.trim() !== manifest.source.archiveSha256
    || !manifest.recovery || typeof manifest.recovery !== 'object' || !Array.isArray(manifest.recovery.activeConfiguration)
    || typeof manifest.recovery.activeRelease !== 'string') {
    throw new CandidateFailure('candidate-not-prepared');
  }
  return manifest;
}

async function preflightSnapshot(request, paths, original) {
  const storage = await prepareExternalSnapshotStorage(request.dataDir, paths.snapshotRoot);
  const inventory = await collectDataInventory(request.dataDir);
  const capacity = await capacityForSnapshot(storage.snapshotRoot, inventory.bytes);
  if (!capacity.ok) throw new CandidateFailure('insufficient-capacity');
  const snapshots = await listVerifiedSnapshots(storage.snapshotRoot);
  const pairs = await listManagedRecoveryPairs(paths, snapshots);
  const currentReleaseId = await currentManagedReleaseId(request, paths);
  return {
    storage: { location: 'verified-external' },
    capacity,
    inventory: inventorySummary(inventory),
    retention: retentionPlan(pairs, currentReleaseId, snapshotRetention(request), request.snapshotId),
  };
}

async function prepareExternalSnapshotStorage(dataDir, snapshotRoot) {
  const dataPhysical = await realDirectory(dataDir, 'snapshot-data-directory-invalid');
  const configuredRoot = path.resolve(snapshotRoot);
  const parent = path.dirname(configuredRoot);
  const parentPhysical = await realDirectory(parent, 'snapshot-parent-directory-invalid');
  let rootStat = await fs.lstat(configuredRoot).catch((error) => {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (rootStat?.isSymbolicLink()) throw new CandidateFailure('snapshot-location-symlink');
  if (rootStat && !rootStat.isDirectory()) throw new CandidateFailure('snapshot-location-invalid');

  // `recovery-snapshots` is a direct child of the deployment root. Resolve its
  // existing parent before creating it, so a parent symlink cannot turn an
  // apparently external path into a directory inside the live data root.
  const projectedRoot = path.join(parentPhysical, path.basename(configuredRoot));
  if (pathsOverlap(dataPhysical, projectedRoot)) throw new CandidateFailure('snapshot-location-recursive');
  if (!rootStat) {
    await fs.mkdir(configuredRoot, { mode: 0o700 });
    rootStat = await fs.lstat(configuredRoot);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new CandidateFailure('snapshot-location-invalid');
  const snapshotPhysical = await fs.realpath(configuredRoot);
  if (pathsOverlap(dataPhysical, snapshotPhysical)) throw new CandidateFailure('snapshot-location-recursive');
  return { dataRoot: dataPhysical, snapshotRoot: snapshotPhysical };
}

async function realDirectory(directory, failure) {
  try {
    if (!(await fs.stat(directory)).isDirectory()) throw new CandidateFailure(failure);
    return await fs.realpath(directory);
  } catch (error) {
    if (error instanceof CandidateFailure) throw error;
    throw new CandidateFailure(failure);
  }
}

function pathsOverlap(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}

function snapshotRetention(request) {
  return request.retention === undefined ? SNAPSHOT_RETENTION : request.retention;
}

function parseServiceEnvironment(content) {
  const values = {};
  for (const line of content.split(/\r?\n/u)) {
    if (!line.startsWith('Environment=')) continue;
    const value = line.slice('Environment='.length);
    const separator = value.indexOf('=');
    if (separator <= 0) continue;
    const key = value.slice(0, separator);
    const setting = value.slice(separator + 1);
    if (/^[A-Z][A-Z0-9_]*$/u.test(key) && setting && !/[\r\n\0]/u.test(setting)) values[key] = setting;
  }
  return values;
}

function parsePort(value) {
  if (!/^\d+$/u.test(value || '')) return null;
  const port = Number.parseInt(value, 10);
  return port >= 1 && port <= 65_535 ? port : null;
}

function parseOrigin(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password
      && parsed.pathname === '/' && !parsed.search && !parsed.hash && parsed.hostname ? parsed : null;
  } catch {
    return null;
  }
}

async function collectDataInventory(root) {
  const files = [];
  const excluded = ['server.lock', 'maintenance-gate.sock', 'files/tmp/**'];
  await visit('', root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, bytes: files.reduce((total, entry) => total + entry.size, 0), excluded };

  async function visit(relative, directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(directory, entry.name);
      if (isSnapshotTransient(childRelative)) continue;
      if (entry.isDirectory()) {
        await visit(childRelative, child);
        continue;
      }
      if (!entry.isFile()) throw new CandidateFailure('unsupported-data-entry');
      const stat = await fs.stat(child);
      files.push({ path: childRelative, size: stat.size, sha256: await hashFile(child), mode: stat.mode & 0o777 });
    }
  }
}

function isSnapshotTransient(relative) {
  return relative === 'server.lock' || relative === 'maintenance-gate.sock'
    || relative === 'files/tmp' || relative.startsWith('files/tmp/');
}

function inventorySummary(inventory) {
  return { files: inventory.files.length, bytes: inventory.bytes, excluded: inventory.excluded };
}

async function capacityForSnapshot(snapshotRoot, bytes) {
  let filesystem;
  try {
    filesystem = await fs.statfs(snapshotRoot);
  } catch {
    throw new CandidateFailure('snapshot-storage-unavailable');
  }
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  // A complete external image and an independent restore rehearsal coexist. The
  // margin leaves room for manifests, journal updates, and filesystem metadata.
  const requiredBytes = bytes * 2 + SNAPSHOT_MARGIN_BYTES;
  return { availableBytes, requiredBytes, ok: Number.isSafeInteger(availableBytes) && Number.isSafeInteger(requiredBytes) && availableBytes >= requiredBytes };
}

function snapshotPaths(paths, snapshotId) {
  const root = path.join(paths.snapshotRoot, snapshotId);
  return {
    root,
    staging: `${root}.staging`,
    data: path.join(`${root}.staging`, 'data'),
    recovery: path.join(`${root}.staging`, 'recovery'),
    manifest: path.join(root, 'manifest.json'),
    stagingManifest: path.join(`${root}.staging`, 'manifest.json'),
    rehearsal: path.join(paths.snapshotRoot, `${snapshotId}.rehearsal`),
  };
}

async function createSnapshotCopy(request, paths, lease, snapshot, inventory, original) {
  if (await pathExists(snapshot.root) || await pathExists(snapshot.staging)) throw new CandidateFailure('snapshot-id-already-exists');
  await fs.mkdir(snapshot.data, { recursive: true, mode: 0o700 });
  const recovery = await captureSnapshotRecovery(snapshot, original);
  await requireLease(paths, lease);
  await copyInventory(request.dataDir, snapshot.data, inventory, paths, lease);
  await fsyncDirectory(snapshot.data);
  await fsyncDirectory(snapshot.staging);
  return recovery;
}

async function captureSnapshotRecovery(snapshot, original) {
  const configurationRoot = path.join(snapshot.recovery, 'configuration');
  await fs.mkdir(configurationRoot, { recursive: true, mode: 0o700 });
  const configuration = [];
  for (const entry of original.configuration) {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(entry.name)) throw new CandidateFailure('invalid-recovery-configuration-name');
    const destination = path.join(configurationRoot, entry.name);
    await fs.copyFile(entry.source, destination, fsSync.constants.COPYFILE_EXCL);
    await fs.chmod(destination, 0o600);
    const handle = await fs.open(destination, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const copiedSha256 = await hashFile(destination);
    if (copiedSha256 !== entry.sha256) throw new CandidateFailure('recovery-configuration-copy-verification-failed');
    configuration.push({
      name: entry.name,
      path: `recovery/configuration/${entry.name}`,
      sha256: copiedSha256,
      mode: entry.mode,
      owner: entry.owner,
    });
  }
  await fsyncDirectory(configurationRoot);

  const runtimeState = {
    schema: SNAPSHOT_SCHEMA,
    currentReference: original.release,
    executable: { sha256: original.executable.sha256 },
    runtime: { reference: original.runtime.reference, sha256: original.runtime.sha256, version: original.runtime.version },
  };
  const runtimeStatePath = path.join(snapshot.recovery, 'runtime-state.json');
  await writeAtomic(runtimeStatePath, JSON.stringify(runtimeState, null, 2) + '\n', 0o600);
  await fsyncDirectory(snapshot.recovery);
  return {
    configuration,
    runtimeState: { path: 'recovery/runtime-state.json', sha256: await hashFile(runtimeStatePath) },
  };
}

async function copyInventory(sourceRoot, destinationRoot, inventory, paths = null, lease = null) {
  for (const entry of inventory.files) {
    if (paths && lease) await requireLease(paths, lease);
    const source = safeSnapshotChild(sourceRoot, entry.path);
    const destination = safeSnapshotChild(destinationRoot, entry.path);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.copyFile(source, destination, fsSync.constants.COPYFILE_EXCL);
    await fs.chmod(destination, entry.mode || 0o600);
    const handle = await fs.open(destination, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (await hashFile(destination) !== entry.sha256) throw new CandidateFailure('snapshot-copy-verification-failed');
  }
}

async function verifySnapshotArchive(dataRoot, expected) {
  const actual = await collectDataInventory(dataRoot);
  if (actual.files.length !== expected.files.length || actual.bytes !== expected.bytes) throw new CandidateFailure('snapshot-archive-verification-failed');
  for (let index = 0; index < expected.files.length; index += 1) {
    const source = expected.files[index];
    const copied = actual.files[index];
    if (!copied || copied.path !== source.path || copied.size !== source.size || copied.mode !== source.mode || copied.sha256 !== source.sha256) {
      throw new CandidateFailure('snapshot-archive-verification-failed');
    }
  }
  return {
    result: 'ok',
    files: expected.files.length,
    bytes: expected.bytes,
    sha256: inventoryDigest(expected),
    verifiedAt: new Date().toISOString(),
  };
}

function inventoryDigest(inventory) {
  const hash = createHash('sha256');
  for (const entry of inventory.files) hash.update(`${entry.path}\0${entry.size}\0${entry.mode}\0${entry.sha256}\n`);
  return hash.digest('hex');
}

function recoverySummary(recovery) {
  return {
    configuration: recovery.configuration.map((entry) => ({ name: entry.name, path: entry.path, sha256: entry.sha256, mode: entry.mode, owner: entry.owner })),
    runtimeState: recovery.runtimeState,
  };
}

function safeSnapshotChild(root, relative) {
  if (!relative || path.isAbsolute(relative) || relative.split('/').some((segment) => segment === '..' || segment === '')) {
    throw new CandidateFailure('invalid-snapshot-inventory');
  }
  const result = path.resolve(root, relative);
  const expectedRoot = path.resolve(root);
  if (!result.startsWith(expectedRoot + path.sep)) throw new CandidateFailure('invalid-snapshot-inventory');
  return result;
}

async function pathExists(file) {
  return fs.access(file).then(() => true).catch(() => false);
}

async function verifySnapshotDatabase(dataDir, original) {
  const database = path.join(dataDir, 'baox.sqlite');
  if (!await isRegularFile(database)) throw new CandidateFailure('snapshot-database-missing');
  let Sqlite;
  try {
    Sqlite = require(path.join(path.dirname(path.dirname(original.executable.path)), 'node_modules', 'better-sqlite3'));
  } catch {
    throw new CandidateFailure('snapshot-sqlite-runtime-unavailable');
  }
  let sqlite = null;
  try {
    sqlite = new Sqlite(database, { readonly: true, fileMustExist: true });
    const rows = sqlite.prepare('PRAGMA integrity_check').all();
    if (!rows.length || !rows.every((row) => Object.values(row).includes('ok'))) throw new CandidateFailure('snapshot-database-integrity-failed');
  } catch (error) {
    if (error instanceof CandidateFailure) throw error;
    throw new CandidateFailure('snapshot-database-integrity-failed');
  } finally {
    sqlite?.close();
  }
  return { result: 'ok', checkedAt: new Date().toISOString() };
}

async function rehearseSnapshot(snapshot, inventory, original) {
  const data = path.join(snapshot.rehearsal, 'data');
  const tokenFile = path.join(snapshot.rehearsal, 'etc', 'maintenance-gate.token');
  const controlDirectory = path.join(os.tmpdir(), `baox-snapshot-${randomBytes(12).toString('hex')}`);
  const socket = path.join(controlDirectory, 'gate.sock');
  let child = null;
  try {
    await fs.mkdir(data, { recursive: true, mode: 0o700 });
    await copyInventory(snapshot.data, data, inventory);
    const restoredArchive = await verifySnapshotArchive(data, inventory);
    const databaseBefore = await committedDatabaseEvidence(data);
    const database = await verifySnapshotDatabase(data, original);
    await fs.mkdir(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
    await writeAtomic(tokenFile, randomBytes(48).toString('base64url') + '\n', 0o600);
    await fs.mkdir(controlDirectory, { mode: 0o700 });
    child = spawn(original.runtime.nodePath, [original.executable.path], {
      cwd: path.dirname(original.executable.path),
      env: rehearsalEnvironment(data, tokenFile, socket, original.serviceEnvironment),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const port = await waitForRehearsalPort(child);
    await waitForHttp({ port, host: null });
    await waitForRehearsalGate(socket, tokenFile);
    const reopened = await localGateCommand(socket, tokenFile, 'reopen');
    if (!isOpenGate(reopened)) throw new CandidateFailure('snapshot-rehearsal-gate-did-not-reopen');
    const admitted = await localGateCommand(socket, tokenFile, 'admit');
    if (!isAdmittedGate(admitted)) throw new CandidateFailure('snapshot-rehearsal-gate-did-not-admit');
    const reopenedAgain = await localGateCommand(socket, tokenFile, 'reopen');
    if (!isOpenGate(reopenedAgain)) throw new CandidateFailure('snapshot-rehearsal-gate-write-round-trip-failed');
    await stopChild(child);
    child = null;
    return {
      state: 'verified',
      originalExecutable: { sha256: original.executable.sha256 },
      runtime: { reference: original.runtime.reference, sha256: original.runtime.sha256, version: original.runtime.version },
      archive: restoredArchive,
      database: { ...database, committedFiles: databaseBefore.files },
      isolatedGate: { durableWrites: ['reopen', 'admit', 'reopen'], finalState: reopenedAgain.state },
      isolatedData: 'removed-after-verification',
    };
  } catch (error) {
    throw error instanceof CandidateFailure ? error : new CandidateFailure('snapshot-rehearsal-failed');
  } finally {
    if (child) await stopChild(child).catch(() => undefined);
    await fs.rm(controlDirectory, { recursive: true, force: true });
    await fs.rm(snapshot.rehearsal, { recursive: true, force: true });
  }
}

function rehearsalEnvironment(dataDir, tokenFile, socket, serviceEnvironment) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('BAOX_')) delete environment[key];
  }
  return {
    ...environment,
    HOME: path.join(path.dirname(dataDir), 'home'),
    LANG: 'C.UTF-8',
    BAOX_DATA_DIR: dataDir,
    BAOX_PORT: '0',
    BAOX_HOME: path.join(path.dirname(dataDir), 'no-legacy-import'),
    BAOX_MAINTENANCE_TOKEN_FILE: tokenFile,
    BAOX_MAINTENANCE_SOCKET_PATH: socket,
    ...(serviceEnvironment.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: serviceEnvironment.LD_LIBRARY_PATH } : {}),
  };
}

async function committedDatabaseEvidence(dataDir) {
  const files = [];
  for (const name of ['baox.sqlite', 'baox.sqlite-wal']) {
    const file = path.join(dataDir, name);
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat) {
      if (name === 'baox.sqlite') throw new CandidateFailure('snapshot-database-missing');
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new CandidateFailure('snapshot-database-entry-invalid');
    files.push({ name, size: stat.size, sha256: await hashFile(file) });
  }
  return { files };
}

async function waitForRehearsalGate(socket, tokenFile) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const status = await localGateCommand(socket, tokenFile, 'status');
      if (isGateResponse(status)) return status;
    } catch {
      // The server has bound HTTP before the local control socket in some starts.
    }
    await delay(250);
  }
  throw new CandidateFailure('snapshot-rehearsal-gate-unavailable');
}

async function localGateCommand(socket, tokenFile, command) {
  const token = (await fs.readFile(tokenFile, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{32,}$/u.test(token)) throw new CandidateFailure('snapshot-rehearsal-gate-token-invalid');
  const response = await new Promise((resolve, reject) => {
    const client = net.createConnection(socket);
    let buffer = '';
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      client.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new CandidateFailure('snapshot-rehearsal-gate-unavailable')), 5_000);
    client.once('error', () => fail(new CandidateFailure('snapshot-rehearsal-gate-unavailable')));
    client.once('connect', () => client.write(JSON.stringify({ version: 1, command, token }) + '\n'));
    client.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let parsed;
      try {
        parsed = JSON.parse(buffer.slice(0, newline));
      } catch {
        fail(new CandidateFailure('snapshot-rehearsal-gate-incompatible'));
        return;
      }
      if (!isGateResponse(parsed)) {
        fail(new CandidateFailure('snapshot-rehearsal-gate-incompatible'));
        return;
      }
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        client.end();
        resolve(parsed);
      }
    });
  });
  return response;
}

function waitForRehearsalPort(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => fail(new CandidateFailure('snapshot-rehearsal-start-timeout')), 30_000);
    child.once('error', () => fail(new CandidateFailure('snapshot-rehearsal-failed')));
    child.once('close', () => fail(new CandidateFailure('snapshot-rehearsal-failed')));
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      const match = /baox server listening on http:\/\/127\.0\.0\.1:(\d+)/u.exec(output);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Number.parseInt(match[1], 10));
    });
    child.stderr.resume();
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 10_000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function writeSnapshotManifest(request, paths, lease, snapshot, original, inventory, recovery, archive, rehearsal) {
  const manifest = {
    schema: SNAPSHOT_SCHEMA,
    kind: SNAPSHOT_OPERATION,
    snapshotId: request.snapshotId,
    candidateId: request.candidateId,
    createdAt: new Date().toISOString(),
    original: snapshotOriginalSummary(original),
    recovery: recoverySummary(recovery),
    excluded: inventory.excluded,
    inventory: { bytes: inventory.bytes, files: inventory.files, sha256: archive.sha256 },
    archive,
    database: rehearsal.database,
    rehearsal,
  };
  await writeCandidateFile(paths, lease, snapshot.stagingManifest, JSON.stringify(manifest, null, 2) + '\n', 0o600);
  return manifest;
}

async function publishSnapshot(snapshot) {
  await fs.rename(snapshot.staging, snapshot.root);
  await fsyncDirectory(path.dirname(snapshot.root));
}

async function waitForHttp({ port, host }) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = await httpStatus(port, host);
    if (status !== null && status >= 200 && status < 500) return;
    await delay(250);
  }
  throw new CandidateFailure('service-verification-failed');
}

function httpStatus(port, host) {
  return new Promise((resolve) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/session', headers: host ? { host } : {}, timeout: 2_000 }, (response) => {
      response.resume();
      resolve(response.statusCode || null);
    });
    request.once('timeout', () => request.destroy());
    request.once('error', () => resolve(null));
  });
}

async function commandGate(request, command) {
  const result = await runCommand(request.maintenanceWrapper, [command]);
  if (result.code !== 0) throw new CandidateFailure(result.code === 65 ? 'maintenance-gate-incompatible' : 'maintenance-gate-unavailable');
  const lines = result.stdout.trim().split(/\r?\n/u).filter(Boolean);
  let response;
  try {
    response = JSON.parse(lines.at(-1) || '');
  } catch {
    throw new CandidateFailure('maintenance-gate-incompatible');
  }
  if (!isGateResponse(response)) throw new CandidateFailure('maintenance-gate-incompatible');
  return response;
}

function isGateResponse(value) {
  return Boolean(value && typeof value === 'object' && value.version === 1
    && ['open', 'admitting', 'admitted', 'refused', 'unknown'].includes(value.state)
    && typeof value.barrier === 'boolean'
    && (value.activeWrites === 'unknown' || (Number.isSafeInteger(value.activeWrites) && value.activeWrites >= 0))
    && (value.activeErpAttempt === 'unknown' || typeof value.activeErpAttempt === 'boolean')
    && (value.reason === undefined || typeof value.reason === 'string'));
}

function isAdmittedGate(status) {
  return status.state === 'admitted' && status.barrier === true && status.activeWrites === 0 && status.activeErpAttempt === false;
}

function isOpenGate(status) {
  // New work can begin immediately after reopening. It does not invalidate the
  // verified transition back to an open admission boundary.
  return status.state === 'open' && status.barrier === false;
}

function isDefinitelyOpenGate(status) {
  return Boolean(status && status.barrier === false && (status.state === 'open' || status.state === 'refused'));
}

async function systemctl(action, unit) {
  const result = await runCommand('systemctl', [action, unit]);
  if (result.code !== 0) throw new CandidateFailure('service-command-failed');
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...(options.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.resume();
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout: Buffer.concat(stdout).toString('utf8') }));
  });
}

async function listVerifiedSnapshots(snapshotRoot) {
  const entries = await fs.readdir(snapshotRoot, { withFileTypes: true }).catch(() => []);
  const snapshots = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^snapshot-[a-f0-9-]{29,80}$/i.test(entry.name)) continue;
    const manifest = await readJson(path.join(snapshotRoot, entry.name, 'manifest.json'));
    if (!isVerifiedSnapshotManifest(manifest, entry.name)) continue;
    snapshots.push({ id: entry.name, manifest, timestamp: Date.parse(manifest.createdAt) || 0 });
  }
  snapshots.sort((left, right) => right.timestamp - left.timestamp || right.id.localeCompare(left.id));
  return snapshots;
}

function isVerifiedSnapshotManifest(manifest, snapshotId) {
  return Boolean(manifest && manifest.schema === SNAPSHOT_SCHEMA && manifest.kind === SNAPSHOT_OPERATION
    && manifest.snapshotId === snapshotId && typeof manifest.candidateId === 'string'
    && typeof manifest.createdAt === 'string' && manifest.original && typeof manifest.original.release === 'string'
    && manifest.inventory && Array.isArray(manifest.inventory.files)
    && manifest.archive && manifest.archive.result === 'ok'
    && manifest.database && manifest.database.result === 'ok'
    && manifest.rehearsal && manifest.rehearsal.state === 'verified');
}

async function listManagedRecoveryPairs(paths, snapshots) {
  const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const entries = await fs.readdir(paths.releaseRoot, { withFileTypes: true }).catch(() => []);
  const pairs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !safeReleaseId(entry.name)) continue;
    const release = path.join(paths.releaseRoot, entry.name);
    const manifest = await readJson(path.join(release, 'recovery.json'));
    if (!isManagedRecoveryManifest(manifest, entry.name)) continue;
    const snapshot = snapshotById.get(manifest.snapshotId);
    if (!snapshot || snapshot.manifest.candidateId !== manifest.candidateId) continue;
    pairs.push({
      release: { id: entry.name, path: release, manifest },
      snapshot,
      timestamp: Date.parse(manifest.completedAt) || snapshot.timestamp,
    });
  }
  pairs.sort((left, right) => right.timestamp - left.timestamp || right.release.id.localeCompare(left.release.id));
  return pairs;
}

function isManagedRecoveryManifest(manifest, releaseId) {
  return Boolean(manifest && manifest.schema === SNAPSHOT_SCHEMA && manifest.kind === 'managed-release-recovery'
    && manifest.releaseId === releaseId && typeof manifest.candidateId === 'string'
    && /^[a-f0-9]{12}-[a-f0-9]{12}$/i.test(manifest.candidateId)
    && typeof manifest.snapshotId === 'string' && /^snapshot-[a-f0-9-]{29,80}$/i.test(manifest.snapshotId)
    && typeof manifest.completedAt === 'string' && Number.isFinite(Date.parse(manifest.completedAt)));
}

function safeReleaseId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value);
}

async function currentManagedReleaseId(request, paths) {
  const current = await fs.readlink(path.join(request.deployRoot, 'current')).catch(() => null);
  if (typeof current !== 'string' || !/^releases\/[a-z0-9][a-z0-9._-]{0,127}$/u.test(current)) return null;
  const releaseId = current.slice('releases/'.length);
  const release = path.join(paths.releaseRoot, releaseId);
  const stat = await fs.lstat(release).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return null;
  return releaseId;
}

function retentionPlan(pairs, currentReleaseId, retention, currentSnapshotId) {
  const retainedReleaseIds = new Set(pairs.slice(0, retention).map((pair) => pair.release.id));
  if (currentReleaseId && pairs.some((pair) => pair.release.id === currentReleaseId)) retainedReleaseIds.add(currentReleaseId);
  const recoverable = pairs.find((pair) => pair.release.id !== currentReleaseId) || null;
  if (recoverable) retainedReleaseIds.add(recoverable.release.id);
  const retainedPairs = pairs.filter((pair) => retainedReleaseIds.has(pair.release.id));
  const deletePairs = pairs.filter((pair) => !retainedReleaseIds.has(pair.release.id));
  return {
    retention,
    currentReleaseId,
    mostRecentRecoverableReleaseId: recoverable?.release.id || null,
    protectedSnapshotId: currentSnapshotId,
    retainedPairs: retainedPairs.map(pairSummary),
    deletePairs: deletePairs.map(pairSummary),
  };
}

function pairSummary(pair) {
  return { releaseId: pair.release.id, snapshotId: pair.snapshot.id };
}

async function pruneVerifiedSnapshots(paths, request) {
  const snapshots = await listVerifiedSnapshots(paths.snapshotRoot);
  const pairs = await listManagedRecoveryPairs(paths, snapshots);
  const currentReleaseId = await currentManagedReleaseId(request, paths);
  const plan = retentionPlan(pairs, currentReleaseId, snapshotRetention(request), request.snapshotId);
  const deleted = [];
  const warnings = [];
  for (const pair of plan.deletePairs) {
    try {
      await retireManagedRecoveryPair(paths, pair);
      deleted.push(pair);
    } catch {
      warnings.push(pair);
    }
  }
  return { ...plan, deleted, warnings };
}

async function retireManagedRecoveryPair(paths, pair) {
  if (!safeReleaseId(pair.releaseId) || !/^snapshot-[a-f0-9-]{29,80}$/i.test(pair.snapshotId)) {
    throw new CandidateFailure('invalid-retention-pair');
  }
  const release = path.join(paths.releaseRoot, pair.releaseId);
  const snapshot = path.join(paths.snapshotRoot, pair.snapshotId);
  const [releaseStat, snapshotStat, releaseManifest, snapshotManifest] = await Promise.all([
    fs.lstat(release),
    fs.lstat(snapshot),
    readJson(path.join(release, 'recovery.json')),
    readJson(path.join(snapshot, 'manifest.json')),
  ]);
  if (!releaseStat.isDirectory() || releaseStat.isSymbolicLink() || !snapshotStat.isDirectory() || snapshotStat.isSymbolicLink()
    || !isManagedRecoveryManifest(releaseManifest, pair.releaseId) || releaseManifest.snapshotId !== pair.snapshotId
    || !isVerifiedSnapshotManifest(snapshotManifest, pair.snapshotId) || snapshotManifest.candidateId !== releaseManifest.candidateId) {
    throw new CandidateFailure('retention-pair-no-longer-verifiable');
  }
  const nonce = randomBytes(8).toString('hex');
  const retiredRelease = path.join(paths.releaseRoot, `${pair.releaseId}.retired-${nonce}`);
  const retiredSnapshot = path.join(paths.snapshotRoot, `${pair.snapshotId}.retired-${nonce}`);
  await fs.rename(release, retiredRelease);
  await fsyncDirectory(paths.releaseRoot);
  try {
    await fs.rename(snapshot, retiredSnapshot);
    await fsyncDirectory(paths.snapshotRoot);
  } catch (error) {
    await fs.rename(retiredRelease, release).catch(() => undefined);
    await fsyncDirectory(paths.releaseRoot).catch(() => undefined);
    throw error;
  }
  await fs.rm(retiredRelease, { recursive: true, force: true });
  await fsyncDirectory(paths.releaseRoot);
  await fs.rm(retiredSnapshot, { recursive: true, force: true });
  await fsyncDirectory(paths.snapshotRoot);
}

async function snapshotManifestMatches(paths, journal) {
  if (!journal || typeof journal.snapshotId !== 'string') return false;
  const manifest = await readJson(path.join(paths.snapshotRoot, journal.snapshotId, 'manifest.json'));
  return isVerifiedSnapshotManifest(manifest, journal.snapshotId) && manifest.candidateId === journal.candidateId;
}

function verifiedSnapshotResult(journal, paths) {
  return { state: 'verified', snapshotId: journal.snapshotId, manifest: path.join(paths.snapshotRoot, journal.snapshotId, 'manifest.json'), completion: 'reopen' };
}

function heldSnapshotResult(journal, paths) {
  return { state: 'held', snapshotId: journal.snapshotId, manifest: path.join(paths.snapshotRoot, journal.snapshotId, 'manifest.json'), completion: 'hold' };
}

async function verifyBaseReadiness(request) {
  const issues = [];
  const node = path.join(request.deployRoot, 'runtime', 'node', 'bin', 'node');
  const gcc = path.join(request.deployRoot, 'runtime', 'gcc-12.5.0', 'bin', 'g++');
  const gccLib = path.join(request.deployRoot, 'runtime', 'gcc-12.5.0', 'lib64');
  const python = request.buildPython;
  const caddy = path.join(request.deployRoot, 'bin', 'caddy');
  for (const [code, file] of [
    ['missing-node-runtime', node],
    ['missing-gcc-runtime', gcc],
    ['missing-gcc-library', gccLib],
    ['missing-build-python', python],
    ['missing-caddy-runtime', caddy],
  ]) {
    if (!await isExecutable(file)) issues.push(code);
  }
  if (!await commandSucceeds('id', ['baox'])) issues.push('missing-service-account');
  const buildEnvironment = await readBuildEnvironment(request.buildEnvironment).catch(() => ({ ok: false, issues: ['invalid-build-environment'] }));
  issues.push(...buildEnvironment.issues);
  return {
    ok: issues.length === 0,
    issues: unique(issues),
    environment: buildEnvironment.environment || {},
    public: {
      runtime: { node: null, pnpm: null, gcc: null, buildPython: null, caddy: null },
      buildEnvironment: buildEnvironment.public || null,
    },
  };
}

async function verifyCandidateReadiness(request, source) {
  const base = await verifyBaseReadiness(request);
  const issues = [...base.issues];
  const node = path.join(request.deployRoot, 'runtime', 'node', 'bin', 'node');
  const gcc = path.join(request.deployRoot, 'runtime', 'gcc-12.5.0', 'bin', 'g++');
  const python = request.buildPython;
  const caddy = path.join(request.deployRoot, 'bin', 'caddy');
  const pnpm = path.join(request.deployRoot, 'runtime', 'pnpm-' + source.pnpmVersion, 'bin', 'pnpm');
  if (!await isExecutable(pnpm)) issues.push('missing-pnpm-runtime');
  const [nodeVersion, gccVersion, pythonVersion, caddyVersion, pnpmVersion] = await Promise.all([
    commandOutput(node, ['--version']),
    commandOutput(gcc, ['-dumpfullversion', '-dumpversion'], { LD_LIBRARY_PATH: path.join(request.deployRoot, 'runtime', 'gcc-12.5.0', 'lib64') }),
    commandOutput(python, ['--version']),
    commandOutput(caddy, ['version']),
    commandOutput(pnpm, ['--version']),
  ]);
  if (normalizeVersion(nodeVersion) !== normalizeVersion(source.nodeVersion)) issues.push('node-version-mismatch');
  if (normalizeVersion(pnpmVersion) !== normalizeVersion(source.pnpmVersion)) issues.push('pnpm-version-mismatch');
  if (!gccVersion) issues.push('unusable-gcc-runtime');
  if (!pythonVersion) issues.push('unusable-build-python');
  if (!caddyVersion) issues.push('unusable-caddy-runtime');
  return {
    ok: unique(issues).length === 0,
    issues: unique(issues),
    environment: base.environment,
    public: {
      runtime: {
        node: nodeVersion || null,
        pnpm: pnpmVersion || null,
        gcc: gccVersion || null,
        buildPython: pythonVersion || null,
        caddy: caddyVersion || null,
      },
      buildEnvironment: base.public.buildEnvironment,
    },
  };
}

async function readSourceMetadata(source) {
  const [nvmrc, packageJson] = await Promise.all([
    fs.readFile(path.join(source, '.nvmrc'), 'utf8'),
    fs.readFile(path.join(source, 'package.json'), 'utf8'),
  ]);
  let packageInfo;
  try {
    packageInfo = JSON.parse(packageJson);
  } catch {
    throw new CandidateFailure('invalid-package-json');
  }
  const nodeVersion = nvmrc.trim().replace(/^v/u, '');
  const packageManager = typeof packageInfo.packageManager === 'string' ? packageInfo.packageManager : '';
  const match = /^pnpm@([0-9]+(?:\.[0-9]+){1,2})$/u.exec(packageManager);
  if (!/^\d+(?:\.\d+){1,2}$/u.test(nodeVersion) || !match) throw new CandidateFailure('invalid-runtime-pins');
  return { nodeVersion, pnpmVersion: match[1] };
}

async function buildCandidate(request, paths, source, explicitEnvironment, lease) {
  const runtime = path.join(request.deployRoot, 'runtime');
  const gcc = path.join(runtime, 'gcc-12.5.0');
  const pnpm = path.join(runtime, 'pnpm-' + source.pnpmVersion, 'bin', 'pnpm');
  const env = {
    HOME: path.join(request.deployRoot, 'cache', 'home'),
    PATH: path.join(runtime, 'node', 'bin') + ':' + path.join(runtime, 'pnpm-' + source.pnpmVersion, 'bin') + ':/usr/local/bin:/usr/bin:/bin',
    PNPM_HOME: path.join(request.deployRoot, 'cache', 'pnpm-home'),
    npm_config_store_dir: path.join(request.deployRoot, 'cache', 'pnpm-store'),
    npm_config_python: request.buildPython,
    CC: path.join(gcc, 'bin', 'gcc'),
    CXX: path.join(gcc, 'bin', 'g++'),
    LDFLAGS: '-Wl,-rpath,' + path.join(gcc, 'lib64'),
    LD_LIBRARY_PATH: path.join(gcc, 'lib64'),
    LANG: 'C.UTF-8',
    ...explicitEnvironment,
  };
  await requireLease(paths, lease);
  await runLogged('chown', ['-R', 'baox:baox', paths.source], paths.candidate, {}, paths.log);
  await requireLease(paths, lease);
  await runAsBaox(pnpm, ['install', '--frozen-lockfile'], paths.source, env, paths.log);
  await requireLease(paths, lease);
  await runAsBaox(pnpm, ['build'], paths.source, env, paths.log);
  await requireLease(paths, lease);
  for (const file of [
    path.join(paths.source, 'server', 'dist', 'main.mjs'),
    path.join(paths.source, 'server', 'dist', 'baox.mjs'),
    path.join(paths.source, 'web', 'dist', 'index.html'),
    path.join(paths.source, 'extension', 'dist', 'manifest.json'),
  ]) {
    if (!await isRegularFile(file)) throw new CandidateFailure('candidate-build-output-missing');
  }
  const candidateCaddyfile = path.join(paths.source, 'deploy', 'intranet', 'Caddyfile');
  if (!await isRegularFile(candidateCaddyfile)) throw new CandidateFailure('candidate-caddyfile-missing');
  await runAsBaox(path.join(request.deployRoot, 'bin', 'caddy'), ['validate', '--config', candidateCaddyfile, '--adapter', 'caddyfile'], paths.source, { HOME: env.HOME }, paths.log);
  await requireLease(paths, lease);
}

async function runAsBaox(program, args, cwd, env, log) {
  const assignments = Object.entries(env).map(([key, value]) => key + '=' + value);
  await runLogged('runuser', ['-u', 'baox', '--', 'env', '-i', ...assignments, program, ...args], cwd, {}, log);
}

async function captureRecoveryConfiguration(request, paths, lease) {
  await requireLease(paths, lease);
  await fs.mkdir(paths.recoveryConfig, { recursive: true, mode: 0o700 });
  const active = [
    ['caddyfile', path.join(request.deployRoot, 'etc', 'Caddyfile')],
    ['baox-service', path.join(request.systemdDir, 'baox.service')],
    ['baox-caddy-service', path.join(request.systemdDir, 'baox-caddy.service')],
  ];
  const configuration = [];
  for (const [name, source] of active) {
    if (!await isRegularFile(source)) throw new CandidateFailure('missing-active-configuration');
    const copy = path.join(paths.recoveryConfig, name);
    await writeCandidateFile(paths, lease, copy, await fs.readFile(source), 0o600);
    configuration.push({ name, source, copy: path.relative(paths.candidate, copy), sha256: await hashFile(source) });
  }
  const nodeRuntime = path.join(request.deployRoot, 'runtime', 'node');
  return {
    activeRelease: await fs.readlink(path.join(request.deployRoot, 'current')).catch(() => null),
    runtimeReferences: {
      node: await fs.readlink(nodeRuntime).catch(() => null),
      nodePath: nodeRuntime,
    },
    activeConfiguration: configuration,
  };
}

async function candidateConfiguration(source) {
  const entries = [
    ['caddyfile', path.join(source, 'deploy', 'intranet', 'Caddyfile')],
    ['baox-service', path.join(source, 'deploy', 'intranet', 'baox.service')],
    ['baox-caddy-service', path.join(source, 'deploy', 'intranet', 'baox-caddy.service')],
  ];
  const result = [];
  for (const [name, file] of entries) {
    if (await isRegularFile(file)) result.push({ name, sha256: await hashFile(file) });
  }
  return result;
}

async function readBuildEnvironment(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) return { ok: false, issues: ['invalid-build-environment-permissions'] };
  if (process.platform === 'linux' && stat.uid !== 0) return { ok: false, issues: ['invalid-build-environment-owner'] };
  const content = await fs.readFile(file, 'utf8');
  const environment = {};
  for (const line of content.split('\n')) {
    if (line === '') continue;
    const separator = line.indexOf('=');
    const key = separator > 0 ? line.slice(0, separator) : '';
    const value = separator > 0 ? line.slice(separator + 1) : '';
    if (!ALLOWED_BUILD_ENV.has(key) || Object.prototype.hasOwnProperty.call(environment, key) || !validBuildValue(key, value)) {
      return { ok: false, issues: ['invalid-build-environment'] };
    }
    environment[key] = value;
  }
  for (const required of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    if (!Object.prototype.hasOwnProperty.call(environment, required)) return { ok: false, issues: ['missing-build-environment-value'] };
  }
  return {
    ok: true,
    issues: [],
    environment,
    public: { path: file, sha256: sha256(Buffer.from(content)), keys: Object.keys(environment).sort() },
  };
}

function validBuildValue(key, value) {
  if (!value || /[\r\n\0]/u.test(value)) return false;
  if (key === 'NO_PROXY') return value === '127.0.0.1,localhost';
  if (key === 'HTTP_PROXY' || key === 'HTTPS_PROXY') {
    try {
      const parsed = new URL(value);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password && Boolean(parsed.hostname);
    } catch {
      return false;
    }
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

async function writeCoordinator(request, paths, lease) {
  const inMemory = globalThis.__BAOX_COORDINATOR_SOURCE;
  if (typeof inMemory !== 'string') throw new CandidateFailure('missing-coordinator-source');
  const source = Buffer.from(inMemory, 'utf8');
  if (!source.length || source.length > 1_000_000) throw new CandidateFailure('invalid-coordinator-source');
  await writeCandidateFile(paths, lease, paths.coordinator, source, 0o700);
}

async function writeJournal(request, paths, lease, phase, extra) {
  await requireLease(paths, lease);
  const existing = await readJson(paths.journal);
  const journal = {
    schema: SCHEMA,
    operation: operationFor(request),
    candidateId: request.candidateId,
    ...(request.source ? { source: request.source } : {}),
    ...(isSnapshotRequest(request) ? { snapshotId: request.snapshotId, completion: request.completion } : {}),
    phase,
    updatedAt: new Date().toISOString(),
    ...(isJournalFor(existing, request) ? existing : {}),
    ...extra,
  };
  journal.phase = phase;
  journal.updatedAt = new Date().toISOString();
  await writeAtomic(paths.journal, JSON.stringify(journal, null, 2) + '\n', 0o600);
  await requireLease(paths, lease);
}

async function writeOwner(paths, request, pid, startIdentity, lease, replace = false) {
  if (replace) await requireLease(paths, lease);
  const owner = {
    schema: SCHEMA,
    operation: operationFor(request),
    candidateId: request.candidateId,
    pid,
    startIdentity,
    token: lease.token,
    createdAt: new Date().toISOString(),
  };
  await writeAtomic(path.join(paths.lock, 'owner.json'), JSON.stringify(owner) + '\n', 0o600);
  if (replace) await requireLease(paths, lease);
}

async function release(paths, lease) {
  if (!await hasLease(paths, lease)) return false;
  const retired = `${paths.lock}.retired-${lease.token.slice(0, 16)}-${randomBytes(8).toString('hex')}`;
  try {
    await fs.rename(paths.lock, retired);
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
  await fsyncDirectory(paths.maintenance);
  const owner = await readJson(path.join(retired, 'owner.json'));
  if (!ownerHasLease(owner, lease)) {
    await restoreClaim(paths, retired);
    return false;
  }
  await fs.rm(retired, { recursive: true, force: true });
  await fsyncDirectory(paths.maintenance);
  return true;
}

function lockInspection(owner) {
  if (!validOwner(owner)) return { state: 'unknown-owner' };
  const current = processStartIdentity(owner.pid);
  if (process.platform === 'linux' && current === null) return { state: 'inactive', owner };
  if (process.platform === 'linux' && current !== owner.startIdentity) return { state: 'inactive', owner };
  try {
    process.kill(owner.pid, 0);
    return { state: 'active', owner };
  } catch {
    return { state: 'inactive', owner };
  }
}

function validOwner(owner) {
  if (!owner || typeof owner !== 'object') return false;
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.startIdentity !== 'string' || !owner.startIdentity) return false;
  if (typeof owner.operation !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(owner.operation)) return false;
  if (typeof owner.candidateId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/u.test(owner.candidateId)) return false;
  if (!isLeaseToken(owner.token)) return false;
  if (process.platform === 'linux' && !/^linux:[0-9]+$/u.test(owner.startIdentity)) return false;
  return true;
}

function newLease() {
  return { token: randomBytes(32).toString('hex') };
}

function leaseFromEnvironment() {
  const token = process.env.BAOX_CANDIDATE_LOCK_TOKEN;
  if (!isLeaseToken(token)) throw new CandidateFailure('invalid-worker-lock-token');
  return { token };
}

function isLeaseToken(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function ownerHasLease(owner, lease) {
  return validOwner(owner) && lease && owner.token === lease.token;
}

function sameOwner(left, right) {
  return validOwner(left) && validOwner(right) && left.token === right.token
    && left.pid === right.pid && left.startIdentity === right.startIdentity;
}

async function hasLease(paths, lease) {
  return ownerHasLease(await readJson(path.join(paths.lock, 'owner.json')), lease);
}

async function requireLease(paths, lease) {
  if (!await hasLease(paths, lease)) throw new CandidateFailure('deployment-lock-lost');
}

function processStartIdentity(pid) {
  if (process.platform !== 'linux') return 'nonlinux:' + pid;
  try {
    const value = fsSync.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const afterCommand = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/u);
    const startTime = afterCommand[19];
    return /^\d+$/u.test(startTime || '') ? 'linux:' + startTime : null;
  } catch {
    return null;
  }
}

async function waitForProcessIdentity(pid) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const identity = processStartIdentity(pid);
    if (identity) return identity;
    await delay(10);
  }
  throw new CandidateFailure('worker-identity-unavailable');
}

function isJournalFor(journal, request) {
  if (isSnapshotRequest(request)) {
    return Boolean(journal && journal.schema === SCHEMA && journal.operation === SNAPSHOT_OPERATION
      && journal.candidateId === request.candidateId && journal.snapshotId === request.snapshotId);
  }
  return Boolean(journal && journal.schema === SCHEMA && journal.operation === CANDIDATE_OPERATION
    && journal.candidateId === request.candidateId && journal.source && journal.source.commit === request.source.commit
    && journal.source.archiveSha256 === request.source.archiveSha256);
}

function isSnapshotRequest(request) {
  return Boolean(request && request.kind === 'snapshot');
}

function operationFor(request) {
  return isSnapshotRequest(request) ? SNAPSHOT_OPERATION : CANDIDATE_OPERATION;
}

async function preparedManifestMatches(paths, request) {
  const [manifest, marker] = await Promise.all([readJson(paths.manifest), fs.readFile(paths.prepared, 'utf8').catch(() => null)]);
  return Boolean(manifest && manifest.source && manifest.source.commit === request.source.commit
    && manifest.source.archiveSha256 === request.source.archiveSha256 && marker && marker.trim() === request.source.archiveSha256);
}

async function receiveArchive(destination) {
  const handle = await fs.open(destination, 'w', 0o600);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of process.stdin) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(value);
      bytes += value.length;
      await handle.write(value);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { bytes, sha256: hash.digest('hex') };
}

async function writeAtomic(file, contents, mode) {
  const temporary = file + '.tmp-' + process.pid + '-' + randomBytes(8).toString('hex');
  const handle = await fs.open(temporary, 'wx', mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  await fsyncDirectory(path.dirname(file));
}

async function writeCandidateFile(paths, lease, file, contents, mode) {
  await requireLease(paths, lease);
  await writeAtomic(file, contents, mode);
  await requireLease(paths, lease);
}

async function fsyncDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function hashFile(file) {
  const hash = createHash('sha256');
  const stream = fsSync.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function removeIfPresent(file) {
  await fs.rm(file, { recursive: true, force: true });
}

async function isExecutable(file) {
  try {
    await fs.access(file, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isRegularFile(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function commandSucceeds(command, args) {
  return (await commandOutput(command, args)) !== null;
}

function commandOutput(command, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] });
    const output = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? Buffer.concat(output).toString('utf8').trim() : null));
  });
}

function runLogged(command, args, cwd, env, log) {
  return new Promise((resolve, reject) => {
    const fd = fsSync.openSync(log, 'a', 0o600);
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', fd, fd] });
    child.on('error', (error) => {
      fsSync.closeSync(fd);
      reject(error);
    });
    child.on('close', (code) => {
      fsSync.closeSync(fd);
      if (code === 0) resolve();
      else reject(new CandidateFailure('build-command-failed'));
    });
  });
}

function normalizeVersion(value) {
  return (value || '').trim().replace(/^v/u, '');
}

function unique(values) {
  return [...new Set(values)];
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForStartGate(gate) {
  if (!gate || !path.isAbsolute(gate)) return false;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await isRegularFile(gate)) return true;
    await delay(100);
  }
  return false;
}

function writeResult(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

class CandidateFailure extends Error {
  constructor(code, issues) {
    super(code);
    this.code = code;
    this.issues = issues;
  }
}

module.exports = {
  runSnapshotLifecycle,
  snapshotPaths,
  targetPaths,
  collectDataInventory,
  capacityForSnapshot,
  CandidateFailure,
};
