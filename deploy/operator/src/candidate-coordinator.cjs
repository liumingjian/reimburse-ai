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
const CUTOVER_OPERATION = 'cutover';
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
  if (mode === 'external-bootstrap') {
    await externalBootstrap(request);
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
  if (mode === 'cutover') {
    writeResult(await cutover(request));
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
  for (const name of ['deployRoot', 'serviceHome', 'systemdDir', 'buildEnvironment', 'buildPython']) {
    if (typeof request[name] !== 'string' || !path.isAbsolute(request[name])) throw new Error('invalid target path');
  }
  if (request.externalLock === true && request.kind !== 'cutover') {
    if (typeof request.operation !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(request.operation)) throw new Error('invalid external lock operation');
    if (typeof request.candidateId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/u.test(request.candidateId)) throw new Error('invalid external lock identity');
    if (typeof request.bootstrapScript !== 'string' || !request.bootstrapScript || Buffer.byteLength(request.bootstrapScript, 'utf8') > 256 * 1024) {
      throw new Error('invalid external bootstrap script');
    }
    return;
  }
  if (request.inspect === true) return;
  if (request.kind === 'snapshot') {
    validateSnapshotRequest(request);
    return;
  }
  if (request.kind === 'cutover') {
    validateCutoverRequest(request);
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

function validateCutoverRequest(request) {
  validateSnapshotRequest({ ...request, kind: 'snapshot', completion: 'hold' });
  if (request.externalLock !== true || request.operation !== CUTOVER_OPERATION) throw new Error('invalid cutover lease');
}

function targetPaths(request) {
  const maintenance = path.join(request.deployRoot, 'maintenance');
  const candidateId = typeof request.candidateId === 'string' ? request.candidateId : 'inspection';
  const candidateRoot = path.join(request.deployRoot, 'candidates');
  const candidate = path.join(candidateRoot, candidateId);
  return {
    maintenance,
    lock: path.join(maintenance, 'deployment.lock'),
    journal: path.join(maintenance, 'deployment-journal.json'),
    coordinator: path.join(maintenance, 'candidate-coordinator.cjs'),
    candidateRoot,
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
    proxyProbeRoot: path.join(request.deployRoot, 'proxy-probes'),
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
  await prepareCandidateBuildPaths(paths, lease);
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

  // A retried candidate reuses its journal; a fresh upload starts a fresh timing list.
  await writeJournal(request, paths, lease, 'receiving', { readiness: readiness.public, phaseTimings: [] });
  const received = await timePhase(request, paths, lease, 'upload', () => receiveArchive(paths.partialArchive));
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
    await timePhase(request, paths, lease, 'extract', async () => {
      await removeIfPresent(paths.source);
      await fs.mkdir(paths.source, { recursive: true, mode: 0o700 });
      await runLogged('tar', ['-xf', paths.archive, '-C', paths.source, '--no-same-owner'], paths.candidate, {}, paths.log);
    });
    await requireLease(paths, lease);

    const sourceInfo = await readSourceMetadata(paths.source);
    const readiness = await verifyCandidateReadiness(request, sourceInfo);
    if (!readiness.ok) throw new CandidateFailure('missing-prerequisites', readiness.issues);
    await writeJournal(request, paths, lease, 'building', {
      worker: { pid: process.pid, startIdentity: identity },
      readiness: readiness.public,
    });
    const plan = await incrementalBuildPlan(request, paths, readiness.public.runtime);
    await buildCandidate(request, paths, sourceInfo, readiness.environment, lease, plan);
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
      ...(plan.inputs ? { buildInputs: plan.inputs } : {}),
      phaseTimings: phaseTimingsOf(await readJson(paths.journal)),
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
  return {
    state: 'inspection',
    lock,
    journal: journal && journal.schema === SCHEMA && [CANDIDATE_OPERATION, SNAPSHOT_OPERATION, CUTOVER_OPERATION].includes(journal.operation) ? journal : null,
    manifest,
  };
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

/**
 * Acquires the shared deployment lease for a lifecycle that owns its own
 * journal protocol. It never claims through an incomplete or corrupt journal.
 */
async function acquireDeploymentLease(request, paths) {
  await fs.mkdir(paths.maintenance, { recursive: true, mode: 0o700 });
  if (await hasOutstandingClaim(paths)) {
    return { kind: 'reconcile-needed', result: { state: 'reconcile-needed', code: 'stale-lock-claim-needs-recovery' } };
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!await hasReusableDeploymentJournal(paths)) {
      return { kind: 'reconcile-needed', result: { state: 'reconcile-needed', code: 'deployment-journal-needs-reconciliation' } };
    }
    const freshLease = await createLease(request, paths);
    if (freshLease) return confirmReusableDeploymentLease(paths, freshLease);

    const owner = await readJson(path.join(paths.lock, 'owner.json'));
    const inspected = lockInspection(owner);
    if (inspected.state === 'unknown-owner') {
      return { kind: 'reconcile-needed', result: { state: 'reconcile-needed', code: 'lock-owner-not-durable' } };
    }
    if (inspected.state === 'active') {
      return { kind: 'busy', result: { state: 'busy', operation: owner.operation, candidateId: owner.candidateId } };
    }
    const lease = await claimInactiveLock(request, paths, owner);
    if (lease) return confirmReusableDeploymentLease(paths, lease);
  }
  return { kind: 'reconcile-needed', result: { state: 'reconcile-needed', code: 'lock-transition-raced' } };
}

async function confirmReusableDeploymentLease(paths, lease) {
  if (await hasReusableDeploymentJournal(paths)) return { kind: 'acquired', lease };
  await release(paths, lease).catch(() => undefined);
  return { kind: 'reconcile-needed', result: { state: 'reconcile-needed', code: 'deployment-journal-needs-reconciliation' } };
}

async function hasReusableDeploymentJournal(paths) {
  let contents;
  try {
    contents = await fs.readFile(paths.journal, 'utf8');
  } catch (error) {
    return Boolean(error && error.code === 'ENOENT');
  }
  let journal;
  try {
    journal = JSON.parse(contents);
  } catch {
    return false;
  }
  return isTerminalJournal(journal);
}

async function snapshot(request) {
  if (request.completion === 'hold') return { state: 'failed', code: 'held-snapshot-requires-library-caller' };
  const paths = targetPaths(request);
  const lock = await acquireSnapshot(request, paths);
  if (lock.kind === 'busy' || lock.kind === 'reconcile-needed' || lock.kind === 'verified' || lock.kind === 'held') return lock.result;
  if (lock.kind === 'in-progress') return waitForSnapshotTerminal(request, paths);
  return runSnapshotLifecycle(request, paths, lock.lease, { completion: request.completion });
}

/**
 * Finishes a prepared release while retaining one lease from a newly rehearsed
 * snapshot through the candidate check and the public-access boundary.
 */
async function cutover(request) {
  const paths = targetPaths(request);
  const lock = await acquireCutover(request, paths);
  if (lock.kind === 'busy' || lock.kind === 'reconcile-needed' || lock.kind === 'verified'
    || lock.kind === 'restored' || lock.kind === 'recovery-required' || lock.kind === 'post-access-handoff') return lock.result;

  if (lock.kind === 'resume-public') return resumePublicAccess(request, paths, lock.lease, lock.journal);
  if (lock.kind === 'recover-pre-access') return restoreCutoverBeforeAccess(request, paths, lock.lease, lock.journal, 'interrupted-cutover');
  if (lock.kind === 'resume-held') return continueCutover(request, paths, lock.lease, lock.held);

  // The snapshot runs under its own journal operation, so its timing is carried
  // into the cutover journal rather than recorded in place.
  const snapshotStartedAt = new Date();
  const snapshotRequest = snapshotRequestForCutover(request);
  const held = await runSnapshotLifecycle(snapshotRequest, paths, lock.lease, { completion: 'hold' });
  if (held.state === 'held') return continueCutover(request, paths, lock.lease, held, [phaseTiming('snapshot', snapshotStartedAt)]);
  if (held.state === 'refused') {
    await writeJournal(request, paths, lock.lease, 'refused', { gate: held.gate, failure: held.code });
    await release(paths, lock.lease);
    return { state: 'refused', code: held.code };
  }
  const code = held.code || 'snapshot-failed';
  const phase = held.recoveryRequired ? 'recovery-required' : 'failed';
  await writeJournal(request, paths, lock.lease, phase, { failure: code, snapshotId: request.snapshotId }).catch(() => undefined);
  await release(paths, lock.lease).catch(() => undefined);
  return held.recoveryRequired
    ? recoveryRequiredResult(request, code)
    : { state: 'failed', code };
}

function snapshotRequestForCutover(request) {
  const { externalLock, operation, ...snapshot } = request;
  return { ...snapshot, kind: 'snapshot', completion: 'hold' };
}

async function acquireCutover(request, paths) {
  await fs.mkdir(paths.maintenance, { recursive: true, mode: 0o700 });
  if (await hasOutstandingClaim(paths)) {
    return { kind: 'reconcile-needed', result: { state: 'reconcile-needed', code: 'stale-lock-claim-needs-recovery' } };
  }
  const freshLease = await createLease(request, paths);
  if (freshLease) return reconcileCutoverLease(request, paths, freshLease);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const owner = await readJson(path.join(paths.lock, 'owner.json'));
    const inspected = lockInspection(owner);
    if (inspected.state === 'unknown-owner') {
      return { kind: 'reconcile-needed', result: { state: 'reconcile-needed', code: 'lock-owner-not-durable' } };
    }
    if (inspected.state === 'active') {
      return { kind: 'busy', result: { state: 'busy', operation: owner.operation, candidateId: owner.candidateId } };
    }
    const lease = await claimInactiveLock(request, paths, owner);
    if (lease) return reconcileCutoverLease(request, paths, lease);
  }
  return { kind: 'reconcile-needed', result: { state: 'reconcile-needed', code: 'lock-transition-raced' } };
}

async function reconcileCutoverLease(request, paths, lease) {
  const journal = await readJson(paths.journal);
  if (!journal || isTerminalJournal(journal) && !isCutoverJournalFor(journal, request)) return { kind: 'acquired', lease };
  if (isCutoverJournalFor(journal, request)) {
    if (journal.phase === 'completed') {
      const completed = await completedCutoverResult(request, paths, journal);
      await release(paths, lease);
      return completed ? { kind: 'verified', result: completed } : { kind: 'post-access-handoff', result: postAccessResult(request, 'completed-cutover-needs-verification') };
    }
    if (journal.phase === 'restored') {
      await release(paths, lease);
      return { kind: 'restored', result: restoredResult(request, journal.snapshotId, journal.failure || 'candidate-not-verified') };
    }
    if (journal.phase === 'refused' || journal.phase === 'failed') {
      // Cutover writes these terminal phases only before a held snapshot can
      // reach candidate activation. A fresh attempt is safe only when the
      // durable maintenance barrier is observably open now. Any admitted or
      // uncertain path is recorded as recovery-required instead.
      const gate = await observeGate(request);
      if (isOpenGate(gate)) return { kind: 'acquired', lease };
      await release(paths, lease);
      return {
        kind: 'reconcile-needed',
        result: {
          state: 'reconcile-needed',
          code: journal.phase === 'refused'
            ? 'cutover-refusal-needs-open-gate'
            : 'cutover-pre-admission-failure-needs-open-gate',
        },
      };
    }
    if (journal.phase === 'recovery-required') {
      await release(paths, lease);
      return { kind: 'recovery-required', result: recoveryRequiredResult(request, journal.failure || 'cutover-recovery-required') };
    }
    if (journal.phase === 'public-access-intent' || journal.phase === 'reopening' || journal.phase === 'post-access-handoff') {
      return { kind: 'resume-public', lease, journal };
    }
    return { kind: 'recover-pre-access', lease, journal };
  }
  if (isSnapshotHeldJournal(journal) && journal.candidateId === request.candidateId && typeof journal.snapshotId === 'string' && typeof journal.manifest === 'string') {
    return {
      kind: 'resume-held',
      lease,
      held: { state: 'held', snapshotId: journal.snapshotId, manifest: journal.manifest, completion: 'hold', recoveryPair: journal.recoveryPair },
    };
  }
  if (journal && journal.schema === SCHEMA && journal.operation === SNAPSHOT_OPERATION && journal.candidateId === request.candidateId) {
    await writeJournal(request, paths, lease, 'recovery-required', { failure: 'snapshot-interrupted-before-held-cutover' }).catch(() => undefined);
    await release(paths, lease).catch(() => undefined);
    return { kind: 'recovery-required', result: recoveryRequiredResult(request, 'snapshot-interrupted-before-held-cutover') };
  }
  await release(paths, lease);
  return { kind: 'reconcile-needed', result: { state: 'reconcile-needed', code: 'cutover-journal-not-recognized' } };
}

async function continueCutover(request, paths, lease, held, measured = []) {
  if (!held || held.state !== 'held' || held.completion !== 'hold' || !isRecoveryPair(held.recoveryPair)) {
    await writeJournal(request, paths, lease, 'recovery-required', { failure: 'held-snapshot-not-verifiable' }).catch(() => undefined);
    await release(paths, lease).catch(() => undefined);
    return recoveryRequiredResult(request, 'held-snapshot-not-verifiable');
  }
  const snapshot = await readPublishedSnapshot(paths, held.snapshotId, request.candidateId);
  if (!snapshot) {
    await writeJournal(request, paths, lease, 'recovery-required', { failure: 'held-snapshot-not-verifiable' }).catch(() => undefined);
    await release(paths, lease).catch(() => undefined);
    return recoveryRequiredResult(request, 'held-snapshot-not-verifiable');
  }
  try {
    await recoverCandidateProxyProbes(paths);
  } catch (error) {
    const code = failureCode(error, 'candidate-proxy-probe-recovery-required');
    await writeJournal(request, paths, lease, 'recovery-required', { failure: code }).catch(() => undefined);
    await release(paths, lease).catch(() => undefined);
    return recoveryRequiredResult(request, code);
  }

  try {
    const candidate = await verifyCutoverCandidate(request, paths, snapshot.manifest);
    await writeJournal(request, paths, lease, 'snapshot-held', {
      snapshotId: held.snapshotId,
      manifest: snapshot.manifestPath,
      recoveryPair: held.recoveryPair,
      phaseTimings: [...phaseTimingsOf(candidate.manifest), ...measured],
    });
    await timePhase(request, paths, lease, 'cutover', async () => {
      await systemctl('stop', 'baox.service');
      await writeJournal(request, paths, lease, 'candidate-service-stopped', { snapshotId: held.snapshotId });
      await promoteCandidate(request, paths, lease, candidate);
      await activateCandidate(request, paths, lease, candidate, snapshot.manifest, held.snapshotId);
    });
    await timePhase(request, paths, lease, 'verify', () => verifyActivatedCandidate(request, paths, lease, candidate, held.snapshotId));
    await writeJournal(request, paths, lease, 'candidate-verified', {
      snapshotId: held.snapshotId,
      release: candidate.releaseReference,
      executableSha256: candidate.executableSha256,
    });

    // Once this record is durable, recovery must never replace data or private
    // runtime/configuration state, even if the reopen response is lost.
    await writeJournal(request, paths, lease, 'public-access-intent', {
      snapshotId: held.snapshotId,
      release: candidate.releaseReference,
      access: 'candidate',
    });
    return reopenCandidate(request, paths, lease, candidate, held.snapshotId);
  } catch (error) {
    const code = failureCode(error, 'candidate-cutover-failed');
    return restoreCutoverBeforeAccess(request, paths, lease, { snapshotId: held.snapshotId, failure: code }, code);
  }
}

async function resumePublicAccess(request, paths, lease, journal) {
  const snapshotId = typeof journal.snapshotId === 'string' ? journal.snapshotId : request.snapshotId;
  try {
    if (journal.access === 'restored-original') {
      const snapshot = await readPublishedSnapshot(paths, snapshotId, request.candidateId);
      if (!snapshot) throw new CandidateFailure('cutover-snapshot-not-verifiable');
      const original = await snapshotOriginalState(request, snapshot.manifest, snapshot.root);
      await verifyRestoredOriginal(request, paths, snapshot, original);
      return reopenRestoredOriginal(request, paths, lease, original, snapshotId, journal.failure || 'candidate-not-verified');
    }
    const candidate = await verifyActiveCutoverCandidate(request, paths);
    return reopenCandidate(request, paths, lease, candidate, snapshotId);
  } catch (error) {
    const code = failureCode(error, 'public-access-reconciliation-failed');
    await writeJournal(request, paths, lease, 'post-access-handoff', { snapshotId, failure: code }).catch(() => undefined);
    await release(paths, lease).catch(() => undefined);
    return postAccessResult(request, code);
  }
}

async function reopenCandidate(request, paths, lease, candidate, snapshotId) {
  try {
    await writeJournal(request, paths, lease, 'reopening', { snapshotId, release: candidate.releaseReference });
    const observed = await timePhase(request, paths, lease, 'reopen', async () => {
      const gate = await commandGate(request, 'reopen');
      if (!isOpenGate(gate)) throw new CandidateFailure('maintenance-gate-did-not-reopen');
      await systemctl('start', 'baox-caddy.service');
      await waitForHttp(candidate.public);
      const status = await commandGate(request, 'status');
      if (!isOpenGate(status)) throw new CandidateFailure('maintenance-gate-not-open-after-candidate-verification');
      return status;
    });
    const completed = await writeJournal(request, paths, lease, 'completed', {
      snapshotId,
      manifest: path.join(paths.snapshotRoot, snapshotId, 'manifest.json'),
      release: candidate.releaseReference,
      gate: observed,
      verifiedAt: new Date().toISOString(),
    });
    await release(paths, lease);
    return {
      state: 'verified',
      candidateId: request.candidateId,
      release: candidate.releaseReference,
      snapshotId,
      manifest: path.join(paths.snapshotRoot, snapshotId, 'manifest.json'),
      ...phaseTimingsField(completed),
    };
  } catch (error) {
    const code = failureCode(error, 'public-access-reopen-failed');
    await writeJournal(request, paths, lease, 'post-access-handoff', { snapshotId, failure: code }).catch(() => undefined);
    await release(paths, lease).catch(() => undefined);
    return postAccessResult(request, code);
  }
}

async function restoreCutoverBeforeAccess(request, paths, lease, journal, failure) {
  const snapshotId = typeof journal.snapshotId === 'string' ? journal.snapshotId : request.snapshotId;
  try {
    await recoverCandidateProxyProbes(paths);
    const snapshot = await readPublishedSnapshot(paths, snapshotId, request.candidateId);
    if (!snapshot) throw new CandidateFailure('cutover-snapshot-not-verifiable');
    await writeJournal(request, paths, lease, 'restoring', { snapshotId, failure });
    await systemctl('stop', 'baox-caddy.service');
    await systemctl('stop', 'baox.service');
    const original = await restoreOriginalOperatingSet(request, paths, lease, snapshot);
    await systemctl('daemon-reload');
    await systemctl('start', 'baox.service');
    await waitForHttp(original.loopback);
    await verifyRestoredOriginal(request, paths, snapshot, original);
    await writeJournal(request, paths, lease, 'original-restored', { snapshotId, failure, release: original.release });
    await writeJournal(request, paths, lease, 'public-access-intent', {
      snapshotId,
      release: original.release,
      access: 'restored-original',
      failure,
    });
    return reopenRestoredOriginal(request, paths, lease, original, snapshotId, failure);
  } catch (error) {
    const code = failureCode(error, 'prior-state-recovery-failed');
    await writeJournal(request, paths, lease, 'recovery-required', { snapshotId, failure: code }).catch(() => undefined);
    await release(paths, lease).catch(() => undefined);
    return recoveryRequiredResult(request, code);
  }
}

async function reopenRestoredOriginal(request, paths, lease, original, snapshotId, failure) {
  try {
    await writeJournal(request, paths, lease, 'reopening', { snapshotId, release: original.release, access: 'restored-original' });
    const gate = await commandGate(request, 'reopen');
    if (!isOpenGate(gate)) throw new CandidateFailure('maintenance-gate-did-not-reopen');
    await systemctl('start', 'baox-caddy.service');
    await waitForHttp(original.public);
    const observed = await commandGate(request, 'status');
    if (!isOpenGate(observed)) throw new CandidateFailure('maintenance-gate-not-open-after-original-restoration');
    await writeJournal(request, paths, lease, 'restored', { snapshotId, failure, release: original.release, gate: observed, verifiedAt: new Date().toISOString() });
    await release(paths, lease);
    return restoredResult(request, snapshotId, failure);
  } catch (error) {
    const code = failureCode(error, 'restored-original-reopen-failed');
    await writeJournal(request, paths, lease, 'post-access-handoff', { snapshotId, failure: code }).catch(() => undefined);
    await release(paths, lease).catch(() => undefined);
    return postAccessResult(request, code);
  }
}

function recoveryRequiredResult(request, code) {
  return {
    state: 'recovery-required',
    candidateId: request.candidateId,
    code,
    action: '维护屏障保持关闭。请先核对恢复快照、原发布和数据目录，确认后再执行受控恢复。',
  };
}

function postAccessResult(request, code) {
  return {
    state: 'post-access-handoff',
    candidateId: request.candidateId,
    code,
    action: '已持久记录开放访问意图。命令不会自动覆盖数据；请核对闸门、反向代理和当前发布后再继续。',
  };
}

function restoredResult(request, snapshotId, code) {
  return { state: 'restored', candidateId: request.candidateId, snapshotId, code };
}

function failureCode(error, fallback) {
  return error instanceof CandidateFailure ? error.code : fallback;
}

function isRecoveryPair(value) {
  return Boolean(value && value.state === 'recorded' && typeof value.releaseId === 'string' && typeof value.snapshotId === 'string');
}

async function readPublishedSnapshot(paths, snapshotId, candidateId) {
  if (typeof snapshotId !== 'string' || !/^snapshot-[a-f0-9-]{29,80}$/i.test(snapshotId)) return null;
  const root = path.join(paths.snapshotRoot, snapshotId);
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = await readJson(manifestPath);
  if (!isVerifiedSnapshotManifest(manifest, snapshotId) || manifest.candidateId !== candidateId) return null;
  return {
    root,
    data: path.join(root, 'data'),
    recovery: path.join(root, 'recovery'),
    manifestPath,
    manifest,
  };
}

async function completedCutoverResult(request, paths, journal) {
  const release = `releases/${request.candidateId}`;
  const [current, gate, snapshot] = await Promise.all([
    fs.readlink(path.join(request.deployRoot, 'current')).catch(() => null),
    observeGate(request),
    readPublishedSnapshot(paths, journal.snapshotId, request.candidateId),
  ]);
  if (current !== release || !isOpenGate(gate) || !snapshot) return null;
  return { state: 'verified', candidateId: request.candidateId, release, snapshotId: journal.snapshotId, manifest: snapshot.manifestPath, ...phaseTimingsField(journal) };
}

function cutoverConfigurationTargets(request) {
  return new Map([
    ['caddyfile', path.join(request.deployRoot, 'etc', 'Caddyfile')],
    ['baox-service', path.join(request.systemdDir, 'baox.service')],
    ['baox-caddy-service', path.join(request.systemdDir, 'baox-caddy.service')],
  ]);
}

function candidateConfigurationSources(root) {
  return new Map([
    ['caddyfile', path.join(root, 'deploy', 'intranet', 'Caddyfile')],
    ['baox-service', path.join(root, 'deploy', 'intranet', 'baox.service')],
    ['baox-caddy-service', path.join(root, 'deploy', 'intranet', 'baox-caddy.service')],
  ]);
}

async function verifyCutoverCandidate(request, paths, snapshotManifest) {
  const manifest = await readPreparedCandidate(paths, request.candidateId);
  const source = await candidateReleaseSource(paths, request.candidateId);
  if (!source) throw new CandidateFailure('candidate-source-missing');
  const current = await fs.readlink(path.join(request.deployRoot, 'current')).catch(() => null);
  if (current === `releases/${request.candidateId}`) throw new CandidateFailure('candidate-already-current');
  const expected = candidateConfigurationSources(source);
  const advertised = new Map();
  if (!Array.isArray(manifest.candidateConfiguration)) throw new CandidateFailure('candidate-configuration-incomplete');
  for (const entry of manifest.candidateConfiguration) {
    if (!entry || typeof entry.name !== 'string' || typeof entry.sha256 !== 'string' || advertised.has(entry.name)) {
      throw new CandidateFailure('candidate-configuration-invalid');
    }
    advertised.set(entry.name, entry.sha256);
  }
  for (const [name, file] of expected) {
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || !/^[a-f0-9]{64}$/i.test(advertised.get(name) || '')
      || await hashFile(file).catch(() => null) !== advertised.get(name)) {
      throw new CandidateFailure('candidate-configuration-invalid');
    }
  }
  if (advertised.size !== expected.size) throw new CandidateFailure('candidate-configuration-incomplete');
  const executable = path.join(source, 'server', 'dist', 'main.mjs');
  if (!await isRegularFile(executable)) throw new CandidateFailure('candidate-build-output-missing');
  const service = await serviceConfiguration(fileForConfiguration(expected, 'baox-service'));
  const original = await snapshotOriginalState(request, snapshotManifest, path.join(paths.snapshotRoot, snapshotManifest.snapshotId));
  return {
    source,
    manifest,
    executableSha256: await hashFile(executable),
    configuration: expected,
    loopback: service.loopback,
    public: service.public,
    original,
    releaseReference: `releases/${request.candidateId}`,
  };
}

async function verifyActiveCutoverCandidate(request, paths) {
  const releaseReference = `releases/${request.candidateId}`;
  const current = await fs.readlink(path.join(request.deployRoot, 'current')).catch(() => null);
  if (current !== releaseReference) throw new CandidateFailure('candidate-release-not-current');
  const source = path.join(paths.releaseRoot, request.candidateId);
  const stat = await fs.lstat(source).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new CandidateFailure('candidate-release-missing');
  const executable = path.join(source, 'server', 'dist', 'main.mjs');
  if (!await isRegularFile(executable)) throw new CandidateFailure('candidate-build-output-missing');
  const service = await serviceConfiguration(path.join(request.systemdDir, 'baox.service'));
  return {
    source,
    executableSha256: await hashFile(executable),
    loopback: service.loopback,
    public: service.public,
    releaseReference,
  };
}

async function candidateReleaseSource(paths, candidateId) {
  const source = path.join(paths.candidate, 'source');
  const sourceStat = await fs.lstat(source).catch(() => null);
  if (sourceStat && sourceStat.isDirectory() && !sourceStat.isSymbolicLink()) return source;
  const release = path.join(paths.releaseRoot, candidateId);
  const releaseStat = await fs.lstat(release).catch(() => null);
  return releaseStat && releaseStat.isDirectory() && !releaseStat.isSymbolicLink() ? release : null;
}

async function prepareCandidateBuildPaths(paths, lease) {
  await requireLease(paths, lease);
  await ensureBaoxTraversalDirectory(paths.candidateRoot, 0o710, 'candidate-root-permissions-invalid');
  await requireLease(paths, lease);
  await ensureBaoxTraversalDirectory(paths.candidate, 0o710, 'candidate-build-permissions-invalid');
  await fsyncDirectory(path.dirname(paths.candidateRoot));
  await fsyncDirectory(paths.candidateRoot);
}

async function prepareReleaseTraversal(paths, lease) {
  await requireLease(paths, lease);
  await ensureBaoxTraversalDirectory(paths.releaseRoot, 0o750, 'release-root-permissions-invalid');
  await fsyncDirectory(path.dirname(paths.releaseRoot));
}

// Root retains candidate metadata while baox can traverse only the known source
// path it owns. The release parent needs group read/traverse for the service to
// follow current into a promoted baox-owned release.
async function ensureBaoxTraversalDirectory(directory, mode, failure) {
  await fs.mkdir(directory, { recursive: true, mode });
  const before = await fs.lstat(directory).catch(() => null);
  if (!before || !before.isDirectory() || before.isSymbolicLink()) throw new CandidateFailure(failure);
  const ownership = await runCommand('chown', ['root:baox', directory]);
  if (ownership.code !== 0) throw new CandidateFailure(failure);
  await fs.chmod(directory, mode);
  const verified = await fs.lstat(directory).catch(() => null);
  if (!verified || !verified.isDirectory() || verified.isSymbolicLink() || (verified.mode & 0o777) !== mode) {
    throw new CandidateFailure(failure);
  }
}

function fileForConfiguration(configuration, name) {
  const file = configuration.get(name);
  if (!file) throw new CandidateFailure('candidate-configuration-incomplete');
  return file;
}

async function serviceConfiguration(serviceFile) {
  const environment = parseServiceEnvironment(await fs.readFile(serviceFile, 'utf8'));
  const port = parsePort(environment.BAOX_PORT);
  const origin = parseOrigin(environment.BAOX_PUBLIC_ORIGIN);
  if (port === null || origin === null) throw new CandidateFailure('service-runtime-configuration-invalid');
  const publicPort = origin.port ? Number.parseInt(origin.port, 10) : origin.protocol === 'https:' ? 443 : 80;
  return { environment, loopback: { port, host: origin.host }, public: { port: publicPort, host: origin.host } };
}

async function promoteCandidate(request, paths, lease, candidate) {
  const release = path.join(paths.releaseRoot, request.candidateId);
  await prepareReleaseTraversal(paths, lease);
  const source = path.join(paths.candidate, 'source');
  const sourceStat = await fs.lstat(source).catch(() => null);
  const releaseStat = await fs.lstat(release).catch(() => null);
  if (releaseStat) {
    if (!releaseStat.isDirectory() || releaseStat.isSymbolicLink() || sourceStat) throw new CandidateFailure('candidate-release-conflict');
  } else {
    if (!sourceStat || !sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new CandidateFailure('candidate-source-missing');
    await writeJournal(request, paths, lease, 'promotion-intent', { release: candidate.releaseReference });
    await fs.rename(source, release);
    await fsyncDirectory(paths.releaseRoot);
    await fsyncDirectory(paths.candidate);
  }
  candidate.source = release;
  candidate.configuration = candidateConfigurationSources(release);
  const executable = path.join(release, 'server', 'dist', 'main.mjs');
  if (!await isRegularFile(executable) || await hashFile(executable) !== candidate.executableSha256) throw new CandidateFailure('candidate-release-verification-failed');
  await writeJournal(request, paths, lease, 'candidate-promoted', { release: candidate.releaseReference });
}

async function activateCandidate(request, paths, lease, candidate, snapshotManifest, snapshotId) {
  await applyCandidateConfiguration(request, paths, lease, candidate.configuration, snapshotManifest);
  await validateCandidateProxyConfiguration(request);
  await replaceSymlink(path.join(request.deployRoot, 'current'), candidate.releaseReference);
  await systemctl('daemon-reload');
  await writeJournal(request, paths, lease, 'candidate-switched', { snapshotId, release: candidate.releaseReference });
  await systemctl('start', 'baox.service');
}

async function verifyActivatedCandidate(request, paths, lease, candidate, snapshotId) {
  await waitForHttp(candidate.loopback);
  const active = await verifyActiveCutoverCandidate(request, paths);
  if (active.executableSha256 !== candidate.executableSha256) throw new CandidateFailure('candidate-runtime-verification-failed');
  await requireAdmittedCandidateGate(request);
  await verifyCandidateProxyWhileAdmitted(request, paths, lease, active, snapshotId);
  await requireAdmittedCandidateGate(request);
}

async function validateCandidateProxyConfiguration(request) {
  const caddy = path.join(request.deployRoot, 'bin', 'caddy');
  const configuration = path.join(request.deployRoot, 'etc', 'Caddyfile');
  const result = await runCommand(caddy, ['validate', '--config', configuration, '--adapter', 'caddyfile']);
  if (result.code !== 0) throw new CandidateFailure('candidate-proxy-configuration-invalid');
}

async function requireAdmittedCandidateGate(request) {
  const gate = await commandGate(request, 'status');
  if (!isAdmittedGate(gate)) throw new CandidateFailure('maintenance-gate-not-held-during-candidate-verification');
}

async function verifyCandidateProxyWhileAdmitted(request, paths, lease, candidate, snapshotId) {
  const probe = await startCandidateProxyProbe(request, paths, lease);
  try {
    await writeJournal(request, paths, lease, 'candidate-proxy-probe-started', {
      snapshotId,
      probe: { portCount: probe.ports.length, pid: probe.owner.pid, startIdentity: probe.owner.startIdentity },
    });
    await waitForCandidateProxyProbe(probe, candidate.public.host);
    await requireAdmittedCandidateGate(request);
  } finally {
    await stopCandidateProxyProbe(paths, probe);
  }
}

async function startCandidateProxyProbe(request, paths, lease) {
  await recoverCandidateProxyProbes(paths);
  await requireLease(paths, lease);
  await ensureBaoxTraversalDirectory(paths.proxyProbeRoot, 0o710, 'candidate-proxy-probe-parent-permissions-invalid');
  const root = path.join(paths.proxyProbeRoot, lease.token);
  const existing = await fs.lstat(root).catch(() => null);
  if (existing) throw new CandidateFailure('candidate-proxy-probe-path-conflict');
  let child;
  let childStartIdentity = null;
  try {
    await fs.mkdir(root, { mode: 0o710 });
    await ensureBaoxTraversalDirectory(root, 0o710, 'candidate-proxy-probe-path-permissions-invalid');
    const runtime = {
      config: path.join(root, 'config'),
      data: path.join(root, 'data'),
      cache: path.join(root, 'cache'),
      storage: path.join(root, 'storage'),
    };
    for (const directory of Object.values(runtime)) await fs.mkdir(directory, { mode: 0o700 });

    const caddy = path.join(request.deployRoot, 'bin', 'caddy');
    const configuration = path.join(request.deployRoot, 'etc', 'Caddyfile');
    const adapted = await runCommand(caddy, ['adapt', '--config', configuration, '--adapter', 'caddyfile']);
    if (adapted.code !== 0) throw new CandidateFailure('candidate-proxy-configuration-invalid');
    const privateConfiguration = await loopbackCaddyConfiguration(adapted.stdout, runtime.storage);
    const configurationPath = path.join(root, 'caddy.json');
    await writeAtomic(configurationPath, JSON.stringify(privateConfiguration.config) + '\n', 0o640);
    const configurationOwnership = await runCommand('chown', ['root:baox', configurationPath]);
    if (configurationOwnership.code !== 0) throw new CandidateFailure('candidate-proxy-probe-permissions-invalid');
    await fs.chmod(configurationPath, 0o640);
    await fsyncDirectory(root);

    for (const directory of Object.values(runtime)) {
      const ownership = await runCommand('chown', ['-R', 'baox:baox', directory]);
      if (ownership.code !== 0) throw new CandidateFailure('candidate-proxy-probe-permissions-invalid');
      await fsyncDirectory(directory);
    }
    const coordinatorStartIdentity = await waitForProcessIdentity(process.pid);
    const ownerPath = path.join(root, 'owner.json');
    const starting = {
      schema: SCHEMA,
      state: 'starting',
      leaseToken: lease.token,
      coordinatorPid: process.pid,
      coordinatorStartIdentity,
    };
    await writeAtomic(ownerPath, JSON.stringify(starting) + '\n', 0o600);
    const ownerOwnership = await runCommand('chown', ['root:root', ownerPath]);
    if (ownerOwnership.code !== 0) throw new CandidateFailure('candidate-proxy-probe-permissions-invalid');
    await fs.chmod(ownerPath, 0o600);
    await fsyncDirectory(root);
    const startGate = path.join(root, 'start-gate');
    child = await startDetachedProbe(request, runtime, caddy, configurationPath, coordinatorStartIdentity, startGate);
    childStartIdentity = await waitForProcessIdentity(child.pid);
    const owner = {
      ...starting,
      state: 'running',
      pid: child.pid,
      startIdentity: childStartIdentity,
    };
    await writeAtomic(ownerPath, JSON.stringify(owner) + '\n', 0o600);
    const runningOwnerOwnership = await runCommand('chown', ['root:root', ownerPath]);
    if (runningOwnerOwnership.code !== 0) throw new CandidateFailure('candidate-proxy-probe-permissions-invalid');
    await fs.chmod(ownerPath, 0o600);
    await fsyncDirectory(root);
    await writeAtomic(startGate, `${lease.token}\n`, 0o600);
    const gateOwnership = await runCommand('chown', ['root:root', startGate]);
    if (gateOwnership.code !== 0) throw new CandidateFailure('candidate-proxy-probe-permissions-invalid');
    await fs.chmod(startGate, 0o600);
    await fsyncDirectory(root);
    return { root, ownerPath, owner, ports: privateConfiguration.ports };
  } catch (error) {
    // The supervisor cannot launch Caddy until the root-owned start gate is
    // created after this PID has a durable start identity. Before that point,
    // cleanup removes the gate path and never signals an unfenced PID.
    if (childStartIdentity && child && Number.isSafeInteger(child.pid) && child.pid > 0) {
      await terminateProbeProcess(child.pid, childStartIdentity).catch(() => undefined);
    }
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    await fsyncDirectory(paths.proxyProbeRoot);
    throw error instanceof CandidateFailure ? error : new CandidateFailure('candidate-proxy-probe-start-failed');
  }
}

async function loopbackCaddyConfiguration(stdout, storage) {
  let config;
  try {
    config = JSON.parse(stdout);
  } catch {
    throw new CandidateFailure('candidate-proxy-configuration-invalid');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config) || !config.apps || typeof config.apps !== 'object' || Array.isArray(config.apps)) {
    throw new CandidateFailure('candidate-proxy-configuration-invalid');
  }
  for (const name of Object.keys(config.apps)) {
    if (name !== 'http') throw new CandidateFailure('candidate-proxy-probe-unsupported-app');
  }
  const servers = config.apps.http && config.apps.http.servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers) || Object.keys(servers).length === 0) {
    throw new CandidateFailure('candidate-proxy-configuration-invalid');
  }
  const ports = [];
  for (const name of Object.keys(servers).sort()) {
    const server = servers[name];
    if (!server || typeof server !== 'object' || Array.isArray(server)) throw new CandidateFailure('candidate-proxy-configuration-invalid');
    const port = await allocateLoopbackPort();
    server.listen = [`127.0.0.1:${port}`];
    server.automatic_https = { disable: true };
    ports.push(port);
  }
  config.admin = { disabled: true };
  config.storage = { module: 'file_system', root: storage };
  return { config, ports };
}

function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  }).then((port) => {
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) throw new CandidateFailure('candidate-proxy-probe-port-unavailable');
    return port;
  });
}

async function startDetachedProbe(request, runtime, caddy, configuration, coordinatorStartIdentity, startGate) {
  const args = [
    '-u', 'baox', '--', 'env', '-i',
    `HOME=${request.serviceHome}`,
    `XDG_CONFIG_HOME=${runtime.config}`,
    `XDG_DATA_HOME=${runtime.data}`,
    `XDG_CACHE_HOME=${runtime.cache}`,
    'PATH=/usr/local/bin:/usr/bin:/bin',
    '/bin/sh', '-c', probeSupervisorScript(), '--',
    String(process.pid), coordinatorStartIdentity, caddy, configuration, startGate,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('runuser', args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(child);
    });
  });
}

function probeSupervisorScript() {
  return `set -eu
parent_pid="${'$'}1"
parent_identity="${'$'}2"
caddy="${'$'}3"
configuration="${'$'}4"
start_gate="${'$'}5"
parent_is_current() {
  case "${'$'}parent_identity" in
    linux:*)
      [ -r "/proc/${'$'}parent_pid/stat" ] || return 1
      start="$(awk '{print ${'$'}22}' "/proc/${'$'}parent_pid/stat")"
      [ "linux:${'$'}start" = "${'$'}parent_identity" ]
      ;;
    *) kill -0 "${'$'}parent_pid" 2>/dev/null ;;
  esac
}
attempt=0
while [ ! -f "${'$'}start_gate" ]; do
  parent_is_current || exit 0
  attempt=$((attempt + 1))
  [ "${'$'}attempt" -lt 600 ] || exit 0
  sleep 0.05
done
parent_is_current || exit 0
"${'$'}caddy" run --config "${'$'}configuration" &
caddy_pid="${'$'}!"
cleanup() {
  kill -TERM "${'$'}caddy_pid" 2>/dev/null || true
  wait "${'$'}caddy_pid" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM
while kill -0 "${'$'}caddy_pid" 2>/dev/null; do
  parent_is_current || exit 0
  sleep 0.1
done
wait "${'$'}caddy_pid"
`;
}

async function waitForCandidateProxyProbe(probe, host) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (!probeProcessMatches(probe.owner)) throw new CandidateFailure('candidate-proxy-probe-stopped');
    for (const port of probe.ports) {
      const outcome = await httpSessionOutcome(port, host);
      if (outcome === 'ready') return;
      if (outcome === 'invalid') throw new CandidateFailure('candidate-proxy-verification-failed');
    }
    await delay(250);
  }
  throw new CandidateFailure('candidate-proxy-verification-failed');
}

async function stopCandidateProxyProbe(paths, probe) {
  const owner = await readJson(probe.ownerPath);
  if (!sameProbeOwner(owner, probe.owner)) throw new CandidateFailure('candidate-proxy-probe-owner-lost');
  await terminateProbeProcess(probe.owner.pid, probe.owner.startIdentity);
  await fs.rm(probe.root, { recursive: true, force: true });
  await fsyncDirectory(paths.proxyProbeRoot);
}

async function recoverCandidateProxyProbes(paths) {
  const entries = await fs.readdir(paths.proxyProbeRoot, { withFileTypes: true }).catch((error) => {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isLeaseToken(entry.name)) throw new CandidateFailure('candidate-proxy-probe-recovery-required');
    const root = path.join(paths.proxyProbeRoot, entry.name);
    const owner = await readJson(path.join(root, 'owner.json'));
    if (!validProbeOwner(owner)) throw new CandidateFailure('candidate-proxy-probe-recovery-required');
    if (probeCoordinatorMatches(owner)) throw new CandidateFailure('candidate-proxy-probe-still-active');
    if (owner.state === 'running') await terminateProbeProcess(owner.pid, owner.startIdentity);
    else await delay(250);
    await fs.rm(root, { recursive: true, force: true });
    await fsyncDirectory(paths.proxyProbeRoot);
  }
}

function validProbeOwner(owner) {
  if (!owner || typeof owner !== 'object' || owner.schema !== SCHEMA || !isLeaseToken(owner.leaseToken)
    || !Number.isSafeInteger(owner.coordinatorPid) || owner.coordinatorPid < 1
    || typeof owner.coordinatorStartIdentity !== 'string' || !owner.coordinatorStartIdentity
    || !['starting', 'running'].includes(owner.state)) return false;
  if (owner.state === 'starting') return true;
  return Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.startIdentity === 'string' && owner.startIdentity;
}

function sameProbeOwner(left, right) {
  return validProbeOwner(left) && validProbeOwner(right) && left.state === 'running' && right.state === 'running'
    && left.leaseToken === right.leaseToken && left.pid === right.pid && left.startIdentity === right.startIdentity;
}

function probeCoordinatorMatches(owner) {
  return processMatchesIdentity(owner.coordinatorPid, owner.coordinatorStartIdentity);
}

function probeProcessMatches(owner) {
  return processMatchesIdentity(owner.pid, owner.startIdentity);
}

function processMatchesIdentity(pid, identity) {
  if (!Number.isSafeInteger(pid) || pid < 1 || typeof identity !== 'string') return false;
  if (processStartIdentity(pid) !== identity) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProbeProcess(pid, identity) {
  if (!identity || !processMatchesIdentity(pid, identity)) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { return; }
  }
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (!probeProcessStillAlive(pid, identity)) return;
    await delay(25);
  }
  if (!probeProcessStillAlive(pid, identity)) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { return; }
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!probeProcessStillAlive(pid, identity)) return;
    await delay(25);
  }
  throw new CandidateFailure('candidate-proxy-probe-cleanup-failed');
}

function probeProcessStillAlive(pid, identity) {
  return Boolean(identity) && processMatchesIdentity(pid, identity);
}

async function applyCandidateConfiguration(request, paths, lease, configuration, snapshotManifest) {
  const original = await snapshotOriginalState(request, snapshotManifest, path.join(paths.snapshotRoot, snapshotManifest.snapshotId));
  const targets = cutoverConfigurationTargets(request);
  for (const entry of original.configuration) {
    await requireLease(paths, lease);
    const source = fileForConfiguration(configuration, entry.name);
    const contents = await fs.readFile(source);
    const destination = targets.get(entry.name);
    if (!destination) throw new CandidateFailure('candidate-configuration-incomplete');
    await writeAtomic(destination, contents, entry.mode);
    await fs.chown(destination, entry.owner.uid, entry.owner.gid);
    await fs.chmod(destination, entry.mode);
  }
  await fsyncDirectory(path.dirname(fileForConfiguration(targets, 'caddyfile')));
  await fsyncDirectory(request.systemdDir);
}

async function restoreOriginalOperatingSet(request, paths, lease, snapshot) {
  const original = await snapshotOriginalState(request, snapshot.manifest, snapshot.root);
  await restoreSnapshotConfiguration(request, paths, lease, snapshot, original);
  await restoreSnapshotRuntime(request, paths, lease, original);
  await replaceLiveData(request, paths, lease, snapshot, snapshot.manifest.inventory);
  await verifyRestoredDataSnapshot(request.dataDir, snapshot.manifest.inventory);
  await replaceSymlink(path.join(request.deployRoot, 'current'), original.release);
  await fsyncDirectory(request.deployRoot);
  return original;
}

async function snapshotOriginalState(request, manifest, snapshotRoot) {
  if (!manifest || !manifest.original || !safeManagedReleaseReference(manifest.original.release)
    || !manifest.recovery || !Array.isArray(manifest.recovery.configuration)) {
    throw new CandidateFailure('snapshot-recovery-metadata-invalid');
  }
  const configuration = [];
  const targets = cutoverConfigurationTargets(request);
  for (const entry of manifest.recovery.configuration) {
    if (!entry || typeof entry.name !== 'string' || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string'
      || !validMode(entry.mode) || !validDataOwner(entry.owner) || !targets.has(entry.name)
      || entry.path !== `recovery/configuration/${entry.name}`) {
      throw new CandidateFailure('snapshot-recovery-configuration-invalid');
    }
    const copy = safeSnapshotChild(snapshotRoot, entry.path);
    if (!await isRegularFile(copy) || await hashFile(copy) !== entry.sha256) throw new CandidateFailure('snapshot-recovery-configuration-invalid');
    configuration.push({ ...entry, source: targets.get(entry.name) });
  }
  if (configuration.length !== targets.size || new Set(configuration.map((entry) => entry.name)).size !== targets.size) {
    throw new CandidateFailure('snapshot-recovery-configuration-incomplete');
  }
  const runtimeState = await readJson(safeSnapshotChild(snapshotRoot, manifest.recovery.runtimeState?.path || ''));
  if (!runtimeState || runtimeState.schema !== SNAPSHOT_SCHEMA || runtimeState.currentReference !== manifest.original.release
    || !runtimeState.runtime || runtimeState.runtime.reference !== manifest.original.runtime?.reference
    || runtimeState.runtime.sha256 !== manifest.original.runtime?.sha256 || runtimeState.runtime.version !== manifest.original.runtime?.version
    || await hashFile(safeSnapshotChild(snapshotRoot, manifest.recovery.runtimeState.path)) !== manifest.recovery.runtimeState.sha256) {
    throw new CandidateFailure('snapshot-recovery-runtime-invalid');
  }
  const service = await serviceConfiguration(fileForConfiguration(new Map(configuration.map((entry) => [entry.name, safeSnapshotChild(snapshotRoot, entry.path)])), 'baox-service'));
  return {
    release: manifest.original.release,
    configuration,
    runtime: runtimeState.runtime,
    executable: manifest.original.executable,
    loopback: service.loopback,
    public: service.public,
  };
}

function safeManagedReleaseReference(reference) {
  return typeof reference === 'string' && /^releases\/[a-z0-9][a-z0-9._-]{0,127}$/u.test(reference);
}

async function restoreSnapshotConfiguration(request, paths, lease, snapshot, original) {
  for (const entry of original.configuration) {
    await requireLease(paths, lease);
    const source = safeSnapshotChild(snapshot.root, entry.path);
    const contents = await fs.readFile(source);
    if (await hashFile(source) !== entry.sha256) throw new CandidateFailure('snapshot-recovery-configuration-invalid');
    await writeAtomic(entry.source, contents, entry.mode);
    await fs.chown(entry.source, entry.owner.uid, entry.owner.gid);
    await fs.chmod(entry.source, entry.mode);
  }
  await fsyncDirectory(path.dirname(path.join(request.deployRoot, 'etc', 'Caddyfile')));
  await fsyncDirectory(request.systemdDir);
}

async function restoreSnapshotRuntime(request, paths, lease, original) {
  await requireLease(paths, lease);
  const nodeLink = path.join(request.deployRoot, 'runtime', 'node');
  const expected = original.runtime.reference;
  if (expected !== null && typeof expected !== 'string') throw new CandidateFailure('snapshot-recovery-runtime-invalid');
  const current = await fs.readlink(nodeLink).catch(() => null);
  if (expected !== current) {
    if (typeof expected !== 'string' || !safeRelativeRuntimeReference(expected)) throw new CandidateFailure('snapshot-recovery-runtime-invalid');
    await replaceSymlink(nodeLink, expected);
  }
  const node = path.join(nodeLink, 'bin', 'node');
  if (!await isExecutable(node) || await hashFile(node) !== original.runtime.sha256 || await commandOutput(node, ['--version']) !== original.runtime.version) {
    throw new CandidateFailure('snapshot-recovery-runtime-verification-failed');
  }
  await fsyncDirectory(path.dirname(nodeLink));
}

function safeRelativeRuntimeReference(reference) {
  return !path.isAbsolute(reference) && !reference.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

async function replaceLiveData(request, paths, lease, snapshot, inventory) {
  await requireLease(paths, lease);
  const data = request.dataDir;
  const stat = await fs.lstat(data).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new CandidateFailure('restore-live-data-invalid');
  const retired = `${data}.cutover-retired-${randomBytes(8).toString('hex')}`;
  await fs.rename(data, retired);
  await fsyncDirectory(path.dirname(data));
  try {
    await restoreSnapshotData(snapshot, inventory, data, paths, lease);
    await fsyncDirectory(path.dirname(data));
    await fs.rm(retired, { recursive: true, force: true });
    await fsyncDirectory(path.dirname(data));
  } catch (error) {
    throw error instanceof CandidateFailure ? error : new CandidateFailure('snapshot-data-restoration-failed');
  }
}

async function verifyRestoredOriginal(request, paths, snapshot, original) {
  const current = await fs.readlink(path.join(request.deployRoot, 'current')).catch(() => null);
  if (current !== original.release) throw new CandidateFailure('restored-release-verification-failed');
  for (const entry of original.configuration) {
    if (!await isRegularFile(entry.source) || await hashFile(entry.source) !== entry.sha256) throw new CandidateFailure('restored-configuration-verification-failed');
    const stat = await fs.stat(entry.source);
    if ((stat.mode & 0o777) !== entry.mode || stat.uid !== entry.owner.uid || stat.gid !== entry.owner.gid) {
      throw new CandidateFailure('restored-configuration-metadata-verification-failed');
    }
  }
  // restoreOriginalOperatingSet verifies the byte-for-byte inventory before
  // starting the recovered service. Opening SQLite can legitimately recreate
  // WAL state under the still-closed maintenance barrier, so checking that
  // transient state after startup would reject a correctly restored image.
  const executable = path.join(request.deployRoot, 'current', 'server', 'dist', 'main.mjs');
  if (!await isRegularFile(executable) || await hashFile(executable) !== original.executable.sha256) throw new CandidateFailure('restored-release-verification-failed');
  void paths;
}

async function verifyRestoredDataSnapshot(dataDir, expected) {
  const inventory = await collectDataInventory(dataDir);
  if (inventoryDigest(inventory) !== inventoryDigest(expected)) throw new CandidateFailure('restored-data-verification-failed');
}

async function replaceSymlink(destination, target) {
  if (typeof target !== 'string' || !target || target.includes('\0')) throw new CandidateFailure('invalid-symlink-target');
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  await fs.symlink(target, temporary);
  await fs.rename(temporary, destination);
  await fsyncDirectory(path.dirname(destination));
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
    if (isTerminalJournal(journal)) return { kind: 'acquired', lease };
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
    && (journal.phase === 'reopened' || journal.phase === 'failed' || journal.phase === 'refused'))
    || isTerminalCutoverJournal(journal);
}

function isTerminalCutoverJournal(journal) {
  return Boolean(journal && journal.schema === SCHEMA && journal.operation === CUTOVER_OPERATION
    && (journal.phase === 'completed' || journal.phase === 'restored' || journal.phase === 'refused' || journal.phase === 'failed'));
}

// Bootstrap runs inside the generic deployment lease. The child owns the
// recorded lease while it applies the reviewed transaction.
async function externalBootstrap(request) {
  const paths = targetPaths(request);
  const acquired = await acquireDeploymentLease(request, paths);
  if (acquired.kind !== 'acquired') {
    writeResult(acquired.result);
    return;
  }
  const lease = acquired.lease;

  let child;
  let childExit;
  try {
    child = spawn('/bin/sh', ['-s'], {
      env: bootstrapChildEnvironment(paths, lease),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    childExit = waitForChild(child);
    child.stdin.on('error', () => undefined);
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    child.stdin.end(bootstrapChildScript(request.bootstrapScript));

    const identity = await waitForProcessIdentity(child.pid);
    await writeOwner(paths, request, child.pid, identity, lease, true);
    await writeCandidateFile(paths, lease, path.join(paths.lock, 'bootstrap-start'), 'ready\n', 0o600);

    const exitCode = await childExit;
    if (!await release(paths, lease)) throw new CandidateFailure('deployment-lock-lost');
    if (exitCode !== 0) process.exitCode = exitCode;
  } catch (error) {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    if (childExit) await childExit.catch(() => undefined);
    await release(paths, lease).catch(() => undefined);
    throw error;
  }
}

function bootstrapChildEnvironment(paths, lease) {
  return {
    HOME: '/root',
    PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    BAOX_BOOTSTRAP_LOCK_TOKEN: lease.token,
    BAOX_BOOTSTRAP_LOCK_PATH: paths.lock,
  };
}

function bootstrapChildScript(script) {
  return `set -eu
attempt=0
while [ ! -f "$BAOX_BOOTSTRAP_LOCK_PATH/bootstrap-start" ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 50 ] || exit 75
  sleep 0.1
done
${script}`;
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code === null ? 1 : code));
  });
}

async function reconcileOwnedLock(request, paths, lease) {
  const journal = await readJson(paths.journal);
  if (!journal) return { kind: 'acquired', lease, resumeStaged: false };
  if (!isJournalFor(journal, request)) {
    if (isTerminalJournal(journal)) return { kind: 'acquired', lease, resumeStaged: false };
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
    if (journal.phase === 'prepared') return { ...preparedResult(request, paths), ...phaseTimingsField(journal) };
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
      if (completion !== 'hold') await release(paths, lease);
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
    const recoveryPair = await recordManagedRecoveryPair(paths, lease, { candidateId: request.candidateId, snapshotId: request.snapshotId });
    await writeJournal(request, paths, lease, 'rehearsal-verified', { manifest: snapshot.manifest, manifestSha256: await hashFile(snapshot.manifest), recoveryPair });

    await systemctl('start', 'baox.service');
    serviceStopped = false;
    await waitForHttp(original.loopback);
    await writeJournal(request, paths, lease, 'original-verified', {});

    const retention = await pruneVerifiedSnapshots(paths, request);
    await writeJournal(request, paths, lease, 'retention-pruned', { retention, recoveryPair });

    if (completion === 'hold') {
      if (recoveryPair.state !== 'recorded') throw new CandidateFailure('snapshot-original-release-not-managed');
      await writeJournal(request, paths, lease, 'snapshot-verified-held', { manifest: snapshot.manifest, retention, recoveryPair });
      return { state: 'held', snapshotId: request.snapshotId, manifest: snapshot.manifest, completion: 'hold', recoveryPair };
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
  const directories = [];
  const excluded = ['server.lock', 'maintenance-gate.sock', 'files/tmp/**'];
  await visit('', root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  directories.sort((left, right) => left.path.localeCompare(right.path));
  return { files, directories, bytes: files.reduce((total, entry) => total + entry.size, 0), excluded };

  async function visit(relative, directory) {
    const directoryStat = await fs.lstat(directory).catch(() => null);
    if (!directoryStat || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new CandidateFailure('unsupported-data-entry');
    directories.push({ path: relative || '.', mode: directoryStat.mode & 0o777, owner: { uid: directoryStat.uid, gid: directoryStat.gid } });
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
      const stat = await fs.lstat(child).catch(() => null);
      if (!entry.isFile() || !stat || !stat.isFile() || stat.isSymbolicLink()) throw new CandidateFailure('unsupported-data-entry');
      files.push({
        path: childRelative,
        size: stat.size,
        sha256: await hashFile(child),
        mode: stat.mode & 0o777,
        owner: { uid: stat.uid, gid: stat.gid },
      });
    }
  }
}

function isSnapshotTransient(relative) {
  return relative === 'server.lock' || relative === 'maintenance-gate.sock'
    || relative === 'files/tmp' || relative.startsWith('files/tmp/');
}

function inventorySummary(inventory) {
  return { files: inventory.files.length, directories: inventory.directories.length, bytes: inventory.bytes, excluded: inventory.excluded };
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
  const recovery = await captureSnapshotRecovery(snapshot, original, inventory);
  await requireLease(paths, lease);
  await copyInventory(request.dataDir, snapshot.data, inventory, paths, lease);
  await fsyncDirectory(snapshot.data);
  await fsyncDirectory(snapshot.staging);
  return recovery;
}

async function captureSnapshotRecovery(snapshot, original, inventory) {
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
  const dataMetadataPath = path.join(snapshot.recovery, 'data-metadata.json');
  const dataMetadata = {
    schema: SNAPSHOT_SCHEMA,
    root: inventory.directories.find((entry) => entry.path === '.') || null,
    directories: inventory.directories,
    files: inventory.files.map((entry) => ({ path: entry.path, mode: entry.mode, owner: entry.owner })),
  };
  if (!dataMetadata.root) throw new CandidateFailure('snapshot-data-metadata-incomplete');
  await writeAtomic(dataMetadataPath, JSON.stringify(dataMetadata, null, 2) + '\n', 0o600);
  await fsyncDirectory(snapshot.recovery);
  return {
    configuration,
    runtimeState: { path: 'recovery/runtime-state.json', sha256: await hashFile(runtimeStatePath) },
    dataMetadata: { path: 'recovery/data-metadata.json', sha256: await hashFile(dataMetadataPath) },
  };
}

async function copyInventory(sourceRoot, destinationRoot, inventory, paths = null, lease = null) {
  await preparePrivateSnapshotDirectories(destinationRoot, inventory, paths, lease);
  for (const entry of inventory.files) {
    if (paths && lease) await requireLease(paths, lease);
    const source = safeSnapshotChild(sourceRoot, entry.path);
    const destination = safeSnapshotChild(destinationRoot, entry.path);
    await fs.copyFile(source, destination, fsSync.constants.COPYFILE_EXCL);
    await fs.chmod(destination, 0o600);
    const handle = await fs.open(destination, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (await hashFile(destination) !== entry.sha256) throw new CandidateFailure('snapshot-copy-verification-failed');
  }
}

/**
 * Restores a complete snapshot into an empty destination and reapplies the
 * source data-directory ownership and modes after the private archive copy.
 */
async function restoreSnapshotData(snapshot, inventory, destinationRoot, paths = null, lease = null) {
  if (!path.isAbsolute(destinationRoot)) throw new CandidateFailure('restore-destination-invalid');
  const metadata = await readSnapshotDataMetadata(snapshot.recovery);
  if (!dataMetadataMatchesInventory(metadata, inventory)) throw new CandidateFailure('snapshot-data-metadata-incomplete');
  let existing = null;
  try {
    existing = await fs.readdir(destinationRoot);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (existing && existing.length > 0) throw new CandidateFailure('restore-destination-not-empty');
  await copyInventory(snapshot.data, destinationRoot, inventory, paths, lease);
  await applyRestoredDataMetadata(destinationRoot, metadata, paths, lease);
  const restored = await collectDataInventory(destinationRoot);
  if (inventoryDigest(restored) !== inventoryDigest(inventory)) throw new CandidateFailure('restored-data-metadata-verification-failed');
}

async function readSnapshotDataMetadata(recoveryRoot) {
  const metadata = await readJson(path.join(recoveryRoot, 'data-metadata.json'));
  if (!isDataMetadata(metadata)) throw new CandidateFailure('snapshot-data-metadata-invalid');
  return metadata;
}

async function applyRestoredDataMetadata(destinationRoot, metadata, paths = null, lease = null) {
  for (const entry of [...metadata.directories].sort((left, right) => left.path.split('/').length - right.path.split('/').length || left.path.localeCompare(right.path))) {
    if (paths && lease) await requireLease(paths, lease);
    const target = safeSnapshotDirectory(destinationRoot, entry.path);
    const stat = await fs.lstat(target).catch(() => null);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new CandidateFailure('restored-data-entry-invalid');
    await fs.chown(target, entry.owner.uid, entry.owner.gid);
    await fs.chmod(target, entry.mode);
  }
  for (const entry of metadata.files) {
    if (paths && lease) await requireLease(paths, lease);
    const target = safeSnapshotChild(destinationRoot, entry.path);
    const stat = await fs.lstat(target).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new CandidateFailure('restored-data-entry-invalid');
    await fs.chown(target, entry.owner.uid, entry.owner.gid);
    await fs.chmod(target, entry.mode);
  }
}

function isDataMetadata(metadata) {
  return Boolean(metadata && metadata.schema === SNAPSHOT_SCHEMA && isDataDirectoryMetadata(metadata.root, true)
    && Array.isArray(metadata.directories) && metadata.directories.filter((entry) => entry?.path === '.').length === 1
    && metadata.directories.every((entry) => isDataDirectoryMetadata(entry, entry?.path === '.'))
    && Array.isArray(metadata.files) && metadata.files.every((entry) => isDataFileMetadata(entry)));
}

function isDataDirectoryMetadata(entry, isRoot) {
  return Boolean(entry && isDataMetadataPath(entry.path, isRoot) && validMode(entry.mode) && validDataOwner(entry.owner));
}

function isDataFileMetadata(entry) {
  return Boolean(entry && isDataMetadataPath(entry.path, false) && validMode(entry.mode) && validDataOwner(entry.owner));
}

function isDataMetadataPath(value, isRoot) {
  if (isRoot) return value === '.';
  return typeof value === 'string' && value.length > 0 && !path.isAbsolute(value)
    && !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function validMode(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0o777;
}

function validDataOwner(owner) {
  return Boolean(owner && Number.isSafeInteger(owner.uid) && owner.uid >= 0 && Number.isSafeInteger(owner.gid) && owner.gid >= 0);
}

function dataMetadataMatchesInventory(metadata, inventory) {
  if (!isDataMetadata(metadata) || !Array.isArray(inventory.directories) || metadata.directories.length !== inventory.directories.length || metadata.files.length !== inventory.files.length) {
    return false;
  }
  const directories = new Map(metadata.directories.map((entry) => [entry.path, entry]));
  const files = new Map(metadata.files.map((entry) => [entry.path, entry]));
  return sameDataMetadata(metadata.root, directories.get('.'))
    && inventory.directories.every((entry) => sameDataMetadata(directories.get(entry.path), entry))
    && inventory.files.every((entry) => sameDataMetadata(files.get(entry.path), entry));
}

function sameDataMetadata(left, right) {
  return Boolean(left && right && left.mode === right.mode && left.owner?.uid === right.owner?.uid && left.owner?.gid === right.owner?.gid);
}

async function preparePrivateSnapshotDirectories(destinationRoot, inventory, paths = null, lease = null) {
  const directories = [...inventory.directories].sort((left, right) => left.path.split('/').length - right.path.split('/').length || left.path.localeCompare(right.path));
  for (const entry of directories) {
    if (paths && lease) await requireLease(paths, lease);
    const directory = safeSnapshotDirectory(destinationRoot, entry.path);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
  }
}

async function verifySnapshotArchive(dataRoot, expected) {
  const actual = await collectDataInventory(dataRoot);
  if (actual.files.length !== expected.files.length || actual.directories.length !== expected.directories.length || actual.bytes !== expected.bytes) {
    throw new CandidateFailure('snapshot-archive-verification-failed');
  }
  for (let index = 0; index < expected.files.length; index += 1) {
    const source = expected.files[index];
    const copied = actual.files[index];
    if (!copied || copied.path !== source.path || copied.size !== source.size || copied.mode !== 0o600 || copied.sha256 !== source.sha256) {
      throw new CandidateFailure('snapshot-archive-verification-failed');
    }
  }
  for (let index = 0; index < expected.directories.length; index += 1) {
    const copied = actual.directories[index];
    if (!copied || copied.path !== expected.directories[index].path || copied.mode !== 0o700) throw new CandidateFailure('snapshot-archive-verification-failed');
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
  for (const entry of inventory.directories) hash.update(`directory\0${entry.path}\0${entry.mode}\0${entry.owner.uid}\0${entry.owner.gid}\n`);
  for (const entry of inventory.files) hash.update(`file\0${entry.path}\0${entry.size}\0${entry.mode}\0${entry.owner.uid}\0${entry.owner.gid}\0${entry.sha256}\n`);
  return hash.digest('hex');
}

function recoverySummary(recovery) {
  return {
    configuration: recovery.configuration.map((entry) => ({ name: entry.name, path: entry.path, sha256: entry.sha256, mode: entry.mode, owner: entry.owner })),
    runtimeState: recovery.runtimeState,
    dataMetadata: recovery.dataMetadata,
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

function safeSnapshotDirectory(root, relative) {
  if (relative === '.') return path.resolve(root);
  return safeSnapshotChild(root, relative);
}

async function pathExists(file) {
  return fs.access(file).then(() => true).catch(() => false);
}

async function verifySnapshotDatabase(dataDir, original) {
  const database = path.join(dataDir, 'baox.sqlite');
  if (!await isRegularFile(database)) throw new CandidateFailure('snapshot-database-missing');
  // Native addons must load with the original service's Node and loader
  // environment. Changing LD_LIBRARY_PATH inside this process is too late.
  const modulePath = path.join(path.dirname(path.dirname(original.executable.path)), 'node_modules', 'better-sqlite3');
  const script = `const Sqlite = require(process.argv[1]);
const db = new Sqlite(process.argv[2], { readonly: true, fileMustExist: true });
try { process.stdout.write(JSON.stringify(db.prepare('PRAGMA integrity_check').all())); }
finally { db.close(); }`;
  const result = await runCommand(original.runtime.nodePath, ['-e', script, modulePath, database], {
    env: original.serviceEnvironment.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: original.serviceEnvironment.LD_LIBRARY_PATH } : {},
  });
  try {
    const rows = JSON.parse(result.stdout);
    if (result.code !== 0 || !Array.isArray(rows) || !rows.length || !rows.every((row) => Object.values(row).includes('ok'))) {
      throw new CandidateFailure('snapshot-database-integrity-failed');
    }
  } catch {
    throw new CandidateFailure('snapshot-database-integrity-failed');
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
    await restoreSnapshotData(snapshot, inventory, data);
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
    inventory: { bytes: inventory.bytes, directories: inventory.directories, files: inventory.files, sha256: archive.sha256 },
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
    if (await httpSession(port, host)) return;
    await delay(250);
  }
  throw new CandidateFailure('service-verification-failed');
}

async function httpSession(port, host) {
  return (await httpSessionOutcome(port, host)) === 'ready';
}

function httpSessionOutcome(port, host) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/session', headers: host ? { host } : {}, timeout: 2_000 }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes <= 16 * 1024) chunks.push(chunk);
      });
      response.once('end', () => {
        if (response.statusCode !== 200 || bytes > 16 * 1024) return settle('invalid');
        try {
          settle(isSessionResponse(JSON.parse(Buffer.concat(chunks).toString('utf8'))) ? 'ready' : 'invalid');
        } catch {
          settle('invalid');
        }
      });
      response.once('aborted', () => settle('pending'));
      response.once('error', () => settle('pending'));
      response.once('close', () => settle('pending'));
    });
    request.once('timeout', () => {
      request.destroy();
      settle('pending');
    });
    request.once('error', () => settle('pending'));
  });
}

function isSessionResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!['setup_required', 'signed_out', 'signed_in', 'password_change_required'].includes(value.status)) return false;
  if (!Object.hasOwn(value, 'account')) return false;
  return value.account === null || (typeof value.account === 'object' && !Array.isArray(value.account));
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
  const result = await runCommand('systemctl', unit ? [action, unit] : [action]);
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
    && Array.isArray(manifest.inventory.directories)
    && manifest.recovery && manifest.recovery.dataMetadata && typeof manifest.recovery.dataMetadata.path === 'string'
    && typeof manifest.recovery.dataMetadata.sha256 === 'string'
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
    if (!snapshot || snapshot.manifest.candidateId !== manifest.candidateId || snapshot.manifest.original.release !== manifest.originalRelease) continue;
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
    && manifest.originalRelease === `releases/${releaseId}`
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

/**
 * Records the release that the verified snapshot can restore. A snapshot made
 * before promoting candidate B always belongs to the original release A.
 */
async function recordManagedRecoveryPair(paths, lease, { candidateId, snapshotId }) {
  await requireLease(paths, lease);
  const snapshot = await readJson(path.join(paths.snapshotRoot, snapshotId, 'manifest.json'));
  if (!isVerifiedSnapshotManifest(snapshot, snapshotId) || snapshot.candidateId !== candidateId) {
    throw new CandidateFailure('snapshot-recovery-pair-not-verifiable');
  }
  const releaseId = managedReleaseIdFromReference(snapshot.original.release);
  if (!releaseId) return { state: 'unmanaged-original-release', originalRelease: snapshot.original.release };
  const release = path.join(paths.releaseRoot, releaseId);
  const stat = await fs.lstat(release).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    return { state: 'unmanaged-original-release', originalRelease: snapshot.original.release };
  }
  const record = {
    schema: SNAPSHOT_SCHEMA,
    kind: 'managed-release-recovery',
    releaseId,
    originalRelease: snapshot.original.release,
    candidateId,
    snapshotId,
    completedAt: new Date().toISOString(),
  };
  const destination = path.join(release, 'recovery.json');
  const destinationStat = await fs.lstat(destination).catch((error) => {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (destinationStat && (!destinationStat.isFile() || destinationStat.isSymbolicLink())) {
    throw new CandidateFailure('snapshot-recovery-pair-invalid');
  }
  const existing = await readJson(destination);
  if (destinationStat && !existing) throw new CandidateFailure('snapshot-recovery-pair-invalid');
  if (existing && (!isManagedRecoveryManifest(existing, releaseId) || existing.originalRelease !== snapshot.original.release)) {
    throw new CandidateFailure('snapshot-recovery-pair-invalid');
  }
  if (!existing || existing.snapshotId !== snapshotId || existing.candidateId !== candidateId) {
    await writeAtomic(destination, JSON.stringify(record, null, 2) + '\n', 0o600);
  }
  await requireLease(paths, lease);
  return { state: 'recorded', releaseId, snapshotId };
}

function managedReleaseIdFromReference(reference) {
  if (typeof reference !== 'string' || !/^releases\/[a-z0-9][a-z0-9._-]{0,127}$/u.test(reference)) return null;
  return reference.slice('releases/'.length);
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
    || !isVerifiedSnapshotManifest(snapshotManifest, pair.snapshotId) || snapshotManifest.candidateId !== releaseManifest.candidateId
    || snapshotManifest.original.release !== releaseManifest.originalRelease) {
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
  return {
    state: 'held',
    snapshotId: journal.snapshotId,
    manifest: path.join(paths.snapshotRoot, journal.snapshotId, 'manifest.json'),
    completion: 'hold',
    ...(journal.recoveryPair ? { recoveryPair: journal.recoveryPair } : {}),
  };
}

async function verifyBaseReadiness(request) {
  const issues = [];
  const node = path.join(request.deployRoot, 'runtime', 'node', 'bin', 'node');
  const gcc = path.join(request.deployRoot, 'runtime', 'gcc-12.5.0', 'bin', 'g++');
  const gccLib = path.join(request.deployRoot, 'runtime', 'gcc-12.5.0', 'lib64');
  const python = request.buildPython;
  const caddy = path.join(request.deployRoot, 'bin', 'caddy');
  const executable = new Map();
  for (const [code, file] of [
    ['missing-node-runtime', node],
    ['missing-gcc-runtime', gcc],
    ['missing-gcc-library', gccLib],
    ['missing-build-python', python],
    ['missing-caddy-runtime', caddy],
  ]) {
    const available = await isExecutable(file);
    executable.set(file, available);
    if (!available) issues.push(code);
  }
  const account = await serviceAccountState(request.serviceHome);
  if (account === 'missing') issues.push('missing-service-account');
  if (account === 'mismatched') issues.push('service-account-home-mismatch');
  if (account === 'unknown') issues.push('service-account-home-unverified');
  const buildEnvironment = await readBuildEnvironment(request.buildEnvironment).catch((error) => ({
    ok: false,
    issues: [error && error.code === 'ENOENT' ? 'missing-build-environment' : 'invalid-build-environment'],
  }));
  issues.push(...buildEnvironment.issues);
  const runtime = { node: null, gcc: null, buildPython: null, caddy: null };
  const canProbeAsBaox = account === 'ready' && buildEnvironment.ok;
  if (canProbeAsBaox) {
    const environment = nativeEnvironment(request, buildEnvironment.environment, gccLib);
    const [nodeVersion, gccVersion, pythonVersion, caddyVersion] = await Promise.all([
      commandOutputAsBaox(node, ['--version'], environment),
      commandOutputAsBaox(gcc, ['-dumpfullversion', '-dumpversion'], environment),
      commandOutputAsBaox(python, ['--version'], environment),
      commandOutputAsBaox(caddy, ['version'], environment),
    ]);
    runtime.node = nodeVersion;
    runtime.gcc = gccVersion;
    runtime.buildPython = pythonVersion;
    runtime.caddy = caddyVersion;
    if (executable.get(node) && !nodeVersion) issues.push('unusable-node-runtime');
    if (executable.get(gcc) && !gccVersion) issues.push('unusable-gcc-runtime');
    if (executable.get(python) && !pythonVersion) issues.push('unusable-build-python');
    if (executable.get(caddy) && !caddyVersion) issues.push('unusable-caddy-runtime');
  }
  return {
    ok: issues.length === 0,
    issues: unique(issues),
    environment: buildEnvironment.environment || {},
    runtime,
    canProbeAsBaox,
    public: {
      runtime: { node: runtime.node, pnpm: null, gcc: runtime.gcc, buildPython: runtime.buildPython, caddy: runtime.caddy },
      buildEnvironment: buildEnvironment.public || null,
    },
  };
}

async function verifyCandidateReadiness(request, source) {
  const base = await verifyBaseReadiness(request);
  const issues = [...base.issues];
  const pnpm = path.join(request.deployRoot, 'runtime', 'pnpm-' + source.pnpmVersion, 'bin', 'pnpm');
  const pnpmExists = await isExecutable(pnpm);
  if (!pnpmExists) issues.push('missing-pnpm-runtime');
  const pnpmVersion = base.canProbeAsBaox
    ? await commandOutputAsBaox(pnpm, ['--version'], nativeEnvironment(request, base.environment, path.join(request.deployRoot, 'runtime', 'gcc-12.5.0', 'lib64')))
    : null;
  if (pnpmExists && !pnpmVersion) issues.push('unusable-pnpm-runtime');
  if (base.runtime.node && normalizeVersion(base.runtime.node) !== normalizeVersion(source.nodeVersion)) issues.push('node-version-mismatch');
  if (pnpmVersion && normalizeVersion(pnpmVersion) !== normalizeVersion(source.pnpmVersion)) issues.push('pnpm-version-mismatch');
  return {
    ok: unique(issues).length === 0,
    issues: unique(issues),
    environment: base.environment,
    public: {
      runtime: {
        node: base.runtime.node || null,
        pnpm: pnpmVersion || null,
        gcc: base.runtime.gcc || null,
        buildPython: base.runtime.buildPython || null,
        caddy: base.runtime.caddy || null,
      },
      buildEnvironment: base.public.buildEnvironment,
    },
  };
}

async function serviceAccountState(serviceHome) {
  if (!await commandSucceeds('id', ['baox'])) return 'missing';
  const entry = await commandOutput('getent', ['passwd', 'baox']);
  if (!entry) return 'unknown';
  const fields = entry.split('\n')[0].split(':');
  return fields.length >= 7 && fields[0] === 'baox' && fields[5] === serviceHome ? 'ready' : 'mismatched';
}

function nativeEnvironment(request, buildEnvironment, gccLib) {
  return {
    HOME: request.serviceHome,
    PATH: request.serviceHome + '/.local/bin:/usr/local/bin:/usr/bin:/bin',
    LD_LIBRARY_PATH: gccLib,
    ...buildEnvironment,
  };
}

function commandOutputAsBaox(command, args, environment) {
  const assignments = Object.entries(environment).map(([key, value]) => key + '=' + value);
  return commandOutput('runuser', ['-u', 'baox', '--', 'env', '-i', ...assignments, '/bin/sh', '-c', 'cd "$HOME" && exec "$@"', 'sh', command, ...args]);
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

async function buildCandidate(request, paths, source, explicitEnvironment, lease, plan) {
  const runtime = path.join(request.deployRoot, 'runtime');
  const gcc = path.join(runtime, 'gcc-12.5.0');
  const pnpm = path.join(runtime, 'pnpm-' + source.pnpmVersion, 'bin', 'pnpm');
  const cacheRoot = path.join(request.serviceHome, '.cache', 'baox-build');
  const pnpmHome = path.join(request.serviceHome, '.local', 'share', 'baox-pnpm');
  const env = {
    HOME: request.serviceHome,
    PATH: path.join(runtime, 'node', 'bin') + ':' + path.join(runtime, 'pnpm-' + source.pnpmVersion, 'bin') + ':/usr/local/bin:/usr/bin:/bin',
    PNPM_HOME: pnpmHome,
    npm_config_store_dir: path.join(cacheRoot, 'pnpm-store'),
    npm_config_python: request.buildPython,
    CC: path.join(gcc, 'bin', 'gcc'),
    CXX: path.join(gcc, 'bin', 'g++'),
    LDFLAGS: '-Wl,-rpath,' + path.join(gcc, 'lib64'),
    LD_LIBRARY_PATH: path.join(gcc, 'lib64'),
    LANG: 'C.UTF-8',
    ...explicitEnvironment,
  };
  const dependenciesReused = await timePhase(request, paths, lease, 'install', async (note) => {
    await requireLease(paths, lease);
    await runLogged('chown', ['-R', 'baox:baox', paths.source], paths.candidate, {}, paths.log);
    await requireLease(paths, lease);
    await runAsBaox('/bin/mkdir', ['-p', pnpmHome, env.npm_config_store_dir], paths.source, { HOME: env.HOME, PATH: env.PATH }, paths.log);
    await requireLease(paths, lease);
    if (await reuseDependencies(request, paths, env, lease, plan)) {
      note.reused = true;
      return true;
    }
    await runAsBaox(pnpm, ['install', '--frozen-lockfile'], paths.source, env, paths.log);
    return false;
  });
  await requireLease(paths, lease);
  await timePhase(request, paths, lease, 'build', async (note) => {
    const rebuild = await carryOverBuilds(request, paths, env, lease, plan);
    if (rebuild === null) return runAsBaox(pnpm, ['build'], paths.source, env, paths.log);
    note.rebuilt = rebuild;
    if (rebuild.length === 0) {
      note.reused = true;
      return undefined;
    }
    await requireLease(paths, lease);
    return runAsBaox(pnpm, [...rebuild.flatMap((name) => ['--filter', name]), 'run', 'build'], paths.source, env, paths.log);
  });
  await requireLease(paths, lease);
  await timePhase(request, paths, lease, 'native', async (note) => {
    const native = await ensureCandidateSqlite(request, paths, env, lease);
    if (dependenciesReused && native === 'ready') note.reused = true;
  });
  await requireLease(paths, lease);
  await prepareHost(request, paths, env, lease);
  await requireLease(paths, lease);
  const builtOutputs = [
    path.join(paths.source, 'server', 'dist', 'main.mjs'),
    path.join(paths.source, 'server', 'dist', 'baox.mjs'),
    path.join(paths.source, 'web', 'dist', 'index.html'),
    path.join(paths.source, 'extension', 'dist', 'manifest.json'),
  ];
  // The 本地执行器 program the settings page's zips carry (ADR-0035): without it every download answers 503.
  if (await isRegularFile(path.join(paths.source, 'local-executor', 'package.json'))) {
    builtOutputs.push(path.join(paths.source, 'local-executor', 'dist', 'baox-local-executor.mjs'));
  }
  for (const file of builtOutputs) {
    if (!await isRegularFile(file)) throw new CandidateFailure('candidate-build-output-missing');
  }
  const candidateCaddyfile = path.join(paths.source, 'deploy', 'intranet', 'Caddyfile');
  if (!await isRegularFile(candidateCaddyfile)) throw new CandidateFailure('candidate-caddyfile-missing');
  await timePhase(request, paths, lease, 'config', async () => {
    const renderer = path.join(paths.source, 'deploy', 'intranet', 'render-config.mjs');
    if (await isRegularFile(renderer)) {
      // Routine releases retain the installed origin. A new template default must
      // not invalidate employee extension packages and pairings during an upgrade.
      const active = parseServiceEnvironment(await fs.readFile(path.join(request.systemdDir, 'baox.service'), 'utf8'));
      const origin = parseOrigin(active.BAOX_PUBLIC_ORIGIN);
      if (!origin) throw new CandidateFailure('active-public-origin-invalid');
      await runAsBaox(path.join(runtime, 'node', 'bin', 'node'), [renderer, path.dirname(renderer)], paths.source,
        { ...env, BAOX_PUBLIC_ORIGIN: origin.origin }, paths.log);
      await requireLease(paths, lease);
    }
    await runAsBaox(path.join(request.deployRoot, 'bin', 'caddy'), ['validate', '--config', candidateCaddyfile, '--adapter', 'caddyfile'], paths.source, { HOME: env.HOME }, paths.log);
  });
  await requireLease(paths, lease);
}

/**
 * What a release needs on the host outside itself, as its own baox.service names it (docs/design/erp-headless-v1.md,
 * line 2): the key the hosted ERP 凭据 are sealed with, and the Node runtimes the 本地执行器 zips carry. Both live
 * under the deploy root and outside every release, so a cutover or a rollback keeps them. A unit that names neither
 * (a release from before line 2) records no phase.
 */
async function prepareHost(request, paths, env, lease) {
  const unit = parseServiceEnvironment(await fs.readFile(path.join(paths.source, 'deploy', 'intranet', 'baox.service'), 'utf8'));
  const keyFile = hostPath(request, unit.BAOX_ERP_CREDENTIAL_KEY_FILE);
  const runtimes = hostPath(request, unit.BAOX_LOCAL_EXECUTOR_RUNTIMES);
  const fetcher = path.join(paths.source, 'local-executor', 'scripts', 'fetch-runtimes.mjs');
  const fetchRuntimes = runtimes !== null && await isRegularFile(fetcher);
  if (keyFile === null && !fetchRuntimes) return;
  const node = path.join(request.deployRoot, 'runtime', 'node', 'bin', 'node');
  await timePhase(request, paths, lease, 'host', async () => {
    if (keyFile !== null) await ensureErpCredentialKey(paths, lease, node, keyFile);
    if (fetchRuntimes) {
      await requireLease(paths, lease);
      // Fetched once per Node version through the build's mirror and proxy (build.env), each checked against the
      // release's SHASUMS256.txt; the script skips a version already there.
      await fs.mkdir(runtimes, { recursive: true, mode: 0o755 });
      await runLogged('chown', ['baox:baox', runtimes], paths.candidate, {}, paths.log);
      try {
        await runAsBaox(node, [fetcher, runtimes], paths.source, env, paths.log);
      } catch {
        throw new CandidateFailure('local-executor-runtime-fetch-failed');
      }
    }
  });
}

/** A host file the unit names: absolute and under the deploy root, or no file at all. */
function hostPath(request, value) {
  if (!value) return null;
  const relative = path.relative(request.deployRoot, value);
  if (!path.isAbsolute(value) || !relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new CandidateFailure('host-path-outside-deploy-root');
  return value;
}

const ERP_KEY_CHECK = 'const v = require("node:fs").readFileSync(process.argv[1], "utf8").trim(); process.exit(/^[0-9a-fA-F]{64}$/.test(v) || /^[A-Za-z0-9+/_-]{43}=?$/.test(v) ? 0 : 1);';

/**
 * The ERP 凭据 key (ADR-0033, server/src/erp/credential-vault.ts): 32 random bytes as hex, root:baox 0640, created
 * when missing and never replaced. Losing it loses every saved ERP 凭据, so an existing file, even a broken one, is
 * left alone and stops the deploy instead.
 */
async function ensureErpCredentialKey(paths, lease, node, keyFile) {
  await requireLease(paths, lease);
  await fs.mkdir(path.dirname(keyFile), { recursive: true, mode: 0o755 });
  if (!await pathExists(keyFile)) {
    const temporary = keyFile + '.tmp-' + process.pid + '-' + randomBytes(8).toString('hex');
    await fs.writeFile(temporary, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    try {
      // A link, not a rename: it fails rather than replace a key that appeared meanwhile.
      await fs.link(temporary, keyFile);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    } finally {
      await fs.rm(temporary, { force: true });
    }
    await fsyncDirectory(path.dirname(keyFile));
  }
  if (!(await fs.lstat(keyFile)).isFile()) throw new CandidateFailure('erp-credential-key-invalid');
  await runLogged('chown', ['root:baox', keyFile], paths.candidate, {}, paths.log);
  await fs.chmod(keyFile, 0o640);
  try {
    await runAsBaox(node, ['-e', ERP_KEY_CHECK, keyFile], paths.source, { PATH: '/usr/bin:/bin' }, paths.log);
  } catch {
    throw new CandidateFailure('erp-credential-key-invalid');
  }
}

/**
 * Incremental candidate builds. A candidate reuses what the running release
 * built when the inputs are unchanged:
 * - every `node_modules` (and the compiled better-sqlite3 inside) when the
 *   dependency key matches: lockfile, workspace file, `.npmrc` and the pinned
 *   runtimes. Any change installs fresh.
 * - a workspace package's `dist` when its build key matches: the dependency key,
 *   the repository's root files (docs-only ones excluded), and the trees of the
 *   package and of its workspace dependencies. This assumes a package build
 *   reads nothing else and writes only `<package>/dist`.
 * The keys come from the running release's root-owned candidate manifest
 * (`buildInputs`). Reused `node_modules` files are hardlinks to the release's
 * files (see COPY_TREE_SCRIPT), so the candidate must never write into an
 * existing file under `node_modules`: the native repair copies its package
 * first (detachFromRelease). Anything unexpected, including a failed cleanup of
 * a half-made reuse, falls back to the full install and build.
 */
const BUILD_INPUTS_SCHEMA = 1;
const FULL_BUILD_SCRIPT = 'pnpm -r build';

async function incrementalBuildPlan(request, paths, runtime) {
  const inputs = await buildInputs(paths.source, runtime).catch(() => null);
  if (!inputs) return { inputs: null, previous: null, incremental: false, directories: [] };
  return { ...inputs, previous: await runningReleaseBuild(request, paths) };
}

async function buildInputs(source, runtime) {
  const lockfile = path.join(source, 'pnpm-lock.yaml');
  const workspaceFile = path.join(source, 'pnpm-workspace.yaml');
  if (!await isRegularFile(lockfile) || !await isRegularFile(workspaceFile)) return null;
  const directories = workspacePackageDirectories(await fs.readFile(workspaceFile, 'utf8'));
  if (!directories) return null;
  const npmrc = path.join(source, '.npmrc');
  const dependencies = sha256(Buffer.from(JSON.stringify({
    lockfile: await hashFile(lockfile),
    workspace: await hashFile(workspaceFile),
    npmrc: await isRegularFile(npmrc) ? await hashFile(npmrc) : null,
    node: runtime.node,
    pnpm: runtime.pnpm,
    gcc: runtime.gcc,
    buildPython: runtime.buildPython,
  })));
  const root = await hashRootFiles(source);
  const workspace = new Map();
  for (const directory of directories) {
    const manifest = await readJson(path.join(source, directory, 'package.json'));
    if (!manifest || typeof manifest.name !== 'string' || workspace.has(manifest.name)) return null;
    const dependencyNames = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
      .flatMap((field) => Object.entries(manifest[field] || {}))
      .filter(([, version]) => typeof version === 'string' && version.startsWith('workspace:'))
      .map(([name]) => name);
    workspace.set(manifest.name, {
      directory,
      builds: Boolean(manifest.scripts && typeof manifest.scripts.build === 'string'),
      dependencyNames,
      tree: await hashTree(path.join(source, directory)),
    });
  }
  const packages = {};
  for (const [name, entry] of workspace) {
    if (!entry.builds) continue;
    const closure = workspaceClosure(workspace, name);
    if (!closure) return null;
    packages[name] = {
      directory: entry.directory,
      key: sha256(Buffer.from(JSON.stringify({ dependencies, root, trees: closure.map((member) => [member, workspace.get(member).tree]) }))),
    };
  }
  const rootManifest = await readJson(path.join(source, 'package.json'));
  return {
    inputs: { schema: BUILD_INPUTS_SCHEMA, dependencies, packages },
    // Only the root script that builds every package can be replaced by per-package builds.
    incremental: Boolean(rootManifest && rootManifest.scripts && rootManifest.scripts.build === FULL_BUILD_SCRIPT),
    directories: ['.', ...directories],
  };
}

// Reads the plain `packages:` list of pnpm-workspace.yaml. Globs or any other
// shape return null, which disables reuse rather than guessing.
function workspacePackageDirectories(content) {
  const directories = [];
  let inPackages = false;
  for (const line of content.split('\n')) {
    if (!inPackages) {
      if (/^packages:\s*$/u.test(line)) inPackages = true;
      continue;
    }
    if (/^\S/u.test(line)) break;
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const match = /^\s+-\s+(['"]?)([A-Za-z0-9._/-]+)\1\s*$/u.exec(line);
    if (!match || match[2].split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
    directories.push(match[2]);
  }
  return directories.length > 0 ? directories : null;
}

function workspaceClosure(workspace, name) {
  const seen = new Set();
  const pending = [name];
  while (pending.length > 0) {
    const next = pending.pop();
    if (seen.has(next)) continue;
    const entry = workspace.get(next);
    if (!entry) return null;
    seen.add(next);
    pending.push(...entry.dependencyNames);
  }
  return [...seen].sort();
}

// Root files no build reads: editing them must not rebuild every package.
const DOCS_ONLY_ROOT_FILE = /^(?:.*\.md|LICEN[CS]E(?:\..*)?)$/iu;

async function hashRootFiles(source) {
  const hash = createHash('sha256');
  for (const name of (await fs.readdir(source)).sort()) {
    if (DOCS_ONLY_ROOT_FILE.test(name)) continue;
    const file = path.join(source, name);
    if (await isRegularFile(file)) hash.update(`${name}\0${await hashFile(file)}\n`);
  }
  return hash.digest('hex');
}

async function hashTree(root) {
  const hash = createHash('sha256');
  const visit = async (directory, relative) => {
    for (const name of (await fs.readdir(directory)).sort()) {
      if (name === 'node_modules') continue;
      const file = path.join(directory, name);
      const entry = relative ? relative + '/' + name : name;
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) hash.update(`${entry}\0link\0${await fs.readlink(file)}\n`);
      else if (stat.isDirectory()) {
        hash.update(`${entry}\0dir\n`);
        await visit(file, entry);
      } else if (stat.isFile()) hash.update(`${entry}\0file\0${stat.mode & 0o111 ? 'x' : '-'}\0${await hashFile(file)}\n`);
      else throw new CandidateFailure('candidate-source-entry-unsupported');
    }
  };
  await visit(root, '');
  return hash.digest('hex');
}

async function runningReleaseBuild(request, paths) {
  const releaseId = await currentManagedReleaseId(request, paths);
  if (!releaseId || releaseId === request.candidateId || !/^[a-f0-9]{12}-[a-f0-9]{12}$/iu.test(releaseId)) return null;
  const manifest = await readPreparedCandidate(paths, releaseId).catch(() => null);
  if (!manifest || !isBuildInputs(manifest.buildInputs)) return null;
  return { releaseId, root: path.join(paths.releaseRoot, releaseId), inputs: manifest.buildInputs };
}

function isBuildInputs(value) {
  return Boolean(value && value.schema === BUILD_INPUTS_SCHEMA && typeof value.dependencies === 'string'
    && value.packages && typeof value.packages === 'object'
    && Object.values(value.packages).every((entry) => entry && typeof entry.directory === 'string' && typeof entry.key === 'string'));
}

/** Hardlinks the running release's `node_modules` trees into the candidate. */
async function reuseDependencies(request, paths, env, lease, plan) {
  const previous = plan.previous;
  if (!plan.inputs || !previous || previous.inputs.dependencies !== plan.inputs.dependencies) return false;
  const copies = [];
  for (const directory of plan.directories) {
    const from = path.join(previous.root, directory, 'node_modules');
    if (await fs.lstat(from).catch(() => null)) copies.push([from, path.join(paths.source, directory, 'node_modules')]);
  }
  if (!copies.some(([from]) => from === path.join(previous.root, 'node_modules'))) return false;
  try {
    for (const [from, to] of copies) {
      await requireLease(paths, lease);
      await copyTreeAsBaox(request, paths, env, 'link', from, to);
    }
    return true;
  } catch {
    // A lost lease throws here; any other failure falls back to a fresh install.
    await requireLease(paths, lease);
    await discardTrees(paths, env, copies.map(([, to]) => to));
    return false;
  }
}

/**
 * Removes a half-made reuse so the full path starts clean. If `rm` fails, the
 * trees are moved out of the source into the candidate's `discarded/`
 * directory instead (same filesystem, so a rename), which the candidate's own
 * cleanup removes later. Only when neither works does the phase fail.
 */
async function discardTrees(paths, env, targets) {
  try {
    await runAsBaox('/bin/rm', ['-rf', ...targets], paths.source, env, paths.log);
    return;
  } catch {
    // Fall through to moving what is left aside.
  }
  const discarded = path.join(paths.candidate, 'discarded');
  await fs.mkdir(discarded, { recursive: true, mode: 0o700 });
  for (const target of targets) {
    if (!await fs.lstat(target).catch(() => null)) continue;
    const aside = path.join(discarded, `${Date.now()}-${randomBytes(4).toString('hex')}`);
    await fs.rename(target, aside).catch(() => {
      throw new CandidateFailure('candidate-reuse-cleanup-failed');
    });
  }
}

/**
 * Copies the `dist` of every package whose build key matches the running
 * release's, and returns the names still to build. Null means a full build.
 */
async function carryOverBuilds(request, paths, env, lease, plan) {
  const previous = plan.previous;
  if (!plan.inputs || !plan.incremental || !previous) return null;
  const rebuild = [];
  for (const [name, entry] of Object.entries(plan.inputs.packages)) {
    const before = previous.inputs.packages[name];
    const from = path.join(previous.root, entry.directory, 'dist');
    const to = path.join(paths.source, entry.directory, 'dist');
    const fromStat = await fs.lstat(from).catch(() => null);
    if (!before || before.key !== entry.key || before.directory !== entry.directory || !fromStat || !fromStat.isDirectory()) {
      rebuild.push(name);
      continue;
    }
    try {
      await requireLease(paths, lease);
      await copyTreeAsBaox(request, paths, env, 'copy', from, to);
    } catch {
      await requireLease(paths, lease);
      await discardTrees(paths, env, [to]);
      rebuild.push(name);
    }
  }
  return rebuild.length === Object.keys(plan.inputs.packages).length ? null : rebuild.sort();
}

// Runs as baox, so it can only link or read what the service account already
// owns. Files are hardlinked ('link', like pnpm's own store import) or copied;
// directories and symlinks are always recreated. So creating, removing or
// renaming entries in the candidate never touches the release, but a linked
// file IS the release's file: writing into it in place changes both. Only the
// native repair would do that, and it copies its package first.
const COPY_TREE_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const [mode, from, to] = process.argv.slice(1);
const copy = (source, target) => {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) return fs.symlinkSync(fs.readlinkSync(source), target);
  if (stat.isDirectory()) {
    fs.mkdirSync(target);
    for (const name of fs.readdirSync(source)) copy(path.join(source, name), path.join(target, name));
    return fs.chmodSync(target, stat.mode & 0o7777);
  }
  if (!stat.isFile()) throw new Error('unsupported entry ' + source);
  if (mode === 'link') return fs.linkSync(source, target);
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, stat.mode & 0o7777);
};
copy(from, to);
`;

async function copyTreeAsBaox(request, paths, env, mode, from, to) {
  const node = path.join(request.deployRoot, 'runtime', 'node', 'bin', 'node');
  await runAsBaox(node, ['-e', COPY_TREE_SCRIPT, mode, from, to], paths.source, env, paths.log);
}

async function runAsBaox(program, args, cwd, env, log) {
  const assignments = Object.entries(env).map(([key, value]) => key + '=' + value);
  await runLogged('runuser', ['-u', 'baox', '--', 'env', '-i', ...assignments, program, ...args], cwd, {}, log);
}

async function ensureCandidateSqlite(request, paths, env, lease) {
  const runtime = path.join(request.deployRoot, 'runtime');
  const node = path.join(runtime, 'node', 'bin', 'node');
  const server = path.join(paths.source, 'server');
  const smoke = 'const Database = require("better-sqlite3"); const db = new Database(":memory:"); if (db.prepare("SELECT 1 AS ready").get().ready !== 1) process.exit(1); db.close();';
  try {
    await runAsBaox(node, ['-e', smoke], server, env, paths.log);
    return 'ready';
  } catch {
    await requireLease(paths, lease);
  }
  // Some upstream prebuilds require a newer glibc than the fixed Kylin host.
  // Restrict the repair to this candidate; never modify a shared or active addon.
  const resolved = await commandOutputAsBaox(node, ['-e', `process.stdout.write(require.resolve('better-sqlite3/package.json', { paths: [${JSON.stringify(server)}] }));`], env);
  const sourceRoot = await fs.realpath(paths.source);
  const packageRoot = resolved ? await fs.realpath(path.dirname(resolved)) : '';
  if (!packageRoot.startsWith(sourceRoot + path.sep)) throw new CandidateFailure('candidate-sqlite-package-outside-source');
  const source = await readJson(path.join(paths.source, 'package.json'));
  const pnpmVersion = /^pnpm@([0-9.]+)$/u.exec(source && source.packageManager || '')?.[1];
  if (!pnpmVersion) throw new CandidateFailure('invalid-runtime-pins');
  const gyp = path.join(runtime, 'pnpm-' + pnpmVersion, 'lib', 'node_modules', 'pnpm', 'dist', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
  if (!await isRegularFile(gyp)) throw new CandidateFailure('candidate-native-build-tool-missing');
  await requireLease(paths, lease);
  await detachFromRelease(request, paths, env, packageRoot);
  const prebuild = path.join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}.node`);
  if (await isRegularFile(prebuild)) await fs.rename(prebuild, prebuild + '.upstream-disabled');
  await requireLease(paths, lease);
  await runAsBaox(node, [gyp, 'rebuild', '--release', '--jobs=2', '--nodedir=' + path.join(runtime, 'node')], packageRoot, env, paths.log);
  await requireLease(paths, lease);
  await runAsBaox(node, ['-e', smoke], server, env, paths.log);
  return 'rebuilt';
}

/**
 * Replaces a candidate package directory with a plain copy of itself, so a
 * rebuild inside it writes only new inodes. The directory may hold hardlinks
 * into the running release (reused `node_modules`); node-gyp overwrites
 * `build/Release/*.node` in place, which would otherwise corrupt the release.
 */
async function detachFromRelease(request, paths, env, packageRoot) {
  const linked = packageRoot + '.linked-' + randomBytes(4).toString('hex');
  await fs.rename(packageRoot, linked);
  try {
    await copyTreeAsBaox(request, paths, env, 'copy', linked, packageRoot);
  } catch (error) {
    await runAsBaox('/bin/rm', ['-rf', packageRoot], paths.source, env, paths.log).catch(() => undefined);
    await fs.rename(linked, packageRoot).catch(() => undefined);
    throw error;
  }
  await discardTrees(paths, env, [linked]);
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
    ...(isSnapshotRequest(request) || isCutoverRequest(request) ? { snapshotId: request.snapshotId, ...(isSnapshotRequest(request) ? { completion: request.completion } : {}) } : {}),
    phase,
    updatedAt: new Date().toISOString(),
    ...(isJournalFor(existing, request) ? existing : {}),
    ...extra,
  };
  journal.phase = phase;
  journal.updatedAt = new Date().toISOString();
  await writeAtomic(paths.journal, JSON.stringify(journal, null, 2) + '\n', 0o600);
  await requireLease(paths, lease);
  return journal;
}

/**
 * Deploy phase timings live on the journal as `phaseTimings`, in completion
 * order: `{ phase, startedAt, durationMs, failed?, reused?, rebuilt? }`. They
 * only measure; no recovery decision reads them. A candidate's build phases are
 * copied into its manifest so the cutover journal can list the whole deploy.
 * The action gets a `note` object: `note.reused = true` says the phase carried
 * the running release's output over, `note.rebuilt` lists the only packages built.
 */
async function timePhase(request, paths, lease, phase, action) {
  const startedAt = new Date();
  const note = {};
  let result;
  try {
    result = await action(note);
  } catch (error) {
    await recordPhaseTiming(request, paths, lease, phaseTiming(phase, startedAt, note, true)).catch(() => undefined);
    throw error;
  }
  await recordPhaseTiming(request, paths, lease, phaseTiming(phase, startedAt, note));
  return result;
}

function phaseTiming(phase, startedAt, note = {}, failed = false) {
  return {
    phase,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    ...(failed ? { failed: true } : {}),
    ...(note.reused ? { reused: true } : {}),
    ...(Array.isArray(note.rebuilt) ? { rebuilt: note.rebuilt } : {}),
  };
}

async function recordPhaseTiming(request, paths, lease, entry) {
  await requireLease(paths, lease);
  const journal = await readJson(paths.journal);
  if (!isJournalFor(journal, request)) return;
  journal.phaseTimings = [...phaseTimingsOf(journal), entry];
  await writeAtomic(paths.journal, JSON.stringify(journal, null, 2) + '\n', 0o600);
  await requireLease(paths, lease);
}

function phaseTimingsOf(record) {
  return record && Array.isArray(record.phaseTimings)
    ? record.phaseTimings.filter((entry) => entry && typeof entry.phase === 'string' && Number.isFinite(entry.durationMs))
    : [];
}

function phaseTimingsField(record) {
  const timings = phaseTimingsOf(record);
  return timings.length > 0 ? { phaseTimings: timings } : {};
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
  if (isCutoverRequest(request)) {
    return isCutoverJournalFor(journal, request);
  }
  return Boolean(journal && journal.schema === SCHEMA && journal.operation === CANDIDATE_OPERATION
    && journal.candidateId === request.candidateId && journal.source && journal.source.commit === request.source.commit
    && journal.source.archiveSha256 === request.source.archiveSha256);
}

function isSnapshotRequest(request) {
  return Boolean(request && request.kind === 'snapshot');
}

function isCutoverRequest(request) {
  return Boolean(request && request.kind === 'cutover');
}

function isCutoverJournalFor(journal, request) {
  return Boolean(journal && journal.schema === SCHEMA && journal.operation === CUTOVER_OPERATION
    && journal.candidateId === request.candidateId);
}

function operationFor(request) {
  if (request && request.externalLock === true && typeof request.operation === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(request.operation)) {
    return request.operation;
  }
  if (isCutoverRequest(request)) return CUTOVER_OPERATION;
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
  acquireDeploymentLease,
  runSnapshotLifecycle,
  recordManagedRecoveryPair,
  restoreSnapshotData,
  snapshotPaths,
  targetPaths,
  collectDataInventory,
  capacityForSnapshot,
  requireLease,
  CandidateFailure,
};
