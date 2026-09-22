'use strict';

// This file is copied next to the bundled operator CLI and executed on the
// target's isolated Node runtime. It intentionally has no project imports.
const { createHash, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const SCHEMA = 1;
const ALLOWED_BUILD_ENV = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'npm_config_registry',
  'NODE_MIRROR',
  'CADDY_DOWNLOAD',
]);

main().catch((error) => {
  const code = error instanceof CandidateFailure ? error.code : 'internal-error';
  process.stdout.write(JSON.stringify({ state: 'failed', code }) + '\n');
  process.exitCode = 1;
});

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
  throw new Error('unsupported coordinator mode');
}

function readRequest() {
  const encoded = process.env.BAOX_CANDIDATE_REQUEST_BASE64;
  if (!encoded) throw new Error('missing request');
  let request;
  try {
    request = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
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
  if (!request.source || typeof request.source !== 'object') throw new Error('invalid source');
  if (!/^[0-9a-f]{40}$/i.test(request.source.commit)) throw new Error('invalid source commit');
  if (!/^[0-9a-f]{64}$/i.test(request.source.archiveSha256)) throw new Error('invalid archive checksum');
  if (request.source.artifactOrigin !== 'direct' && request.source.artifactOrigin !== 'relay') throw new Error('invalid artifact origin');
  if (!/^[a-f0-9]{12}-[a-f0-9]{12}$/i.test(request.candidateId)) throw new Error('invalid candidate id');
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
        BAOX_CANDIDATE_REQUEST_BASE64: Buffer.from(JSON.stringify(request)).toString('base64'),
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
  return Boolean(journal && journal.schema === SCHEMA && journal.operation === 'candidate-prepare'
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
  const encoded = process.env.BAOX_COORDINATOR_SOURCE_BASE64;
  if (!encoded) throw new CandidateFailure('missing-coordinator-source');
  const source = Buffer.from(encoded, 'base64');
  if (!source.length || source.length > 1_000_000) throw new CandidateFailure('invalid-coordinator-source');
  await writeCandidateFile(paths, lease, paths.coordinator, source, 0o700);
}

async function writeJournal(request, paths, lease, phase, extra) {
  await requireLease(paths, lease);
  const existing = await readJson(paths.journal);
  const journal = {
    schema: SCHEMA,
    operation: 'candidate-prepare',
    candidateId: request.candidateId,
    source: request.source,
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
    operation: 'candidate-prepare',
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
  return Boolean(journal && journal.schema === SCHEMA && journal.operation === 'candidate-prepare'
    && journal.candidateId === request.candidateId && journal.source && journal.source.commit === request.source.commit
    && journal.source.archiveSha256 === request.source.archiveSha256);
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
