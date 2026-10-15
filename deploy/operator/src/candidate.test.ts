import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { SshCandidateTransport } from './candidate.js';
import { runOperatorCli } from './cli.js';
import { LINUX_MAX_ARG_STRLEN } from './coordinator-transport.js';
import { SshHostTransport } from './host.js';
import { NATIVE_PROFILE } from './profile.js';
import { createSourceRepository } from './source.js';
import { createIsolatedTarget, type IsolatedTarget } from './testing/isolated-target.js';

const REAL_SUBPROCESS_TIMEOUT_MS = 30_000;
const BARRIER_TIMEOUT_MS = 20_000;
const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const remove of cleanup.splice(0).reverse()) await remove();
});

async function createTarget(options: Parameters<typeof createIsolatedTarget>[0] = {}): Promise<IsolatedTarget> {
  const target = await createIsolatedTarget(options);
  cleanup.push(() => target.close());
  return target;
}

function createRepository(): { repository: string; first: string; second: string } {
  const repository = mkdtempSync(join(tmpdir(), 'baox-candidate-source-'));
  cleanup.push(() => rmSync(repository, { recursive: true, force: true }));
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'user.name', 'candidate test']);
  git(repository, ['config', 'user.email', 'candidate@example.test']);
  writeCandidateSource(repository, 'first');
  git(repository, ['add', '.']);
  git(repository, ['commit', '--quiet', '-m', 'first']);
  const first = git(repository, ['rev-parse', 'HEAD']).trim();
  git(repository, ['update-ref', 'refs/remotes/origin/main', first]);
  writeFileSync(join(repository, 'version.txt'), 'second\n');
  git(repository, ['add', 'version.txt']);
  git(repository, ['commit', '--quiet', '-m', 'second']);
  return { repository, first, second: git(repository, ['rev-parse', 'HEAD']).trim() };
}

function writeCandidateSource(repository: string, version: string): void {
  mkdirSync(join(repository, 'deploy', 'intranet'), { recursive: true });
  writeFileSync(join(repository, '.nvmrc'), process.versions.node);
  writeFileSync(join(repository, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.17.1', name: `candidate-${version}` }) + '\n');
  writeFileSync(join(repository, 'deploy', 'intranet', 'Caddyfile'), 'http://10.250.0.222 {\n  respond "candidate"\n}\n');
  writeFileSync(join(repository, 'deploy', 'intranet', 'baox.service'), '[Service]\nEnvironment=BAOX_PUBLIC_ORIGIN=http://10.250.0.222\n');
  writeFileSync(join(repository, 'deploy', 'intranet', 'baox-caddy.service'), '[Service]\n');
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function cli(repository: string, target: IsolatedTarget, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runOperatorCli(argv, {
    source: createSourceRepository(repository),
    host: new SshHostTransport({ profile: target.profile, runner: target.runner.run }),
    candidate: new SshCandidateTransport({ profile: target.profile, runner: target.runner.run }),
  }, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function snapshotDirectory(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  visit(root);
  return result;

  function visit(directory: string): void {
    for (const entry of readdirSync(directory)) {
      const file = join(directory, entry);
      const stat = lstatSync(file);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) result[relative(root, file)] = sha256(readFileSync(file));
      else if (stat.isSymbolicLink()) result[relative(root, file)] = `link:${readlinkSync(file)}`;
    }
  }
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function reaches(server: IsolatedTarget['server']): Promise<void> {
  const response = await fetch(`${server.url}/api/session`);
  expect(response.status).toBeLessThan(500);
}

async function waitFor(file: string): Promise<void> {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${file}`);
}

function writeStaleReceivingState(target: IsolatedTarget, source: { repository: string; first: string }): void {
  const archiveSha256 = sha256(execFileSync('git', ['archive', '--format=tar', source.first], { cwd: source.repository }));
  const candidateId = `${source.first.slice(0, 12)}-${archiveSha256.slice(0, 12)}`;
  const maintenance = join(target.profile.deployRoot, 'maintenance');
  const lock = join(maintenance, 'deployment.lock');
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({
    schema: 1,
    operation: 'candidate-prepare',
    candidateId,
    pid: 999_999,
    startIdentity: process.platform === 'linux' ? 'linux:1' : 'nonlinux:999999',
    token: 'a'.repeat(64),
    createdAt: '2000-01-01T00:00:00.000Z',
  }) + '\n', { mode: 0o600 });
  writeFileSync(join(maintenance, 'deployment-journal.json'), JSON.stringify({
    schema: 1,
    operation: 'candidate-prepare',
    candidateId,
    source: { ref: source.first, commit: source.first, archiveSha256, artifactOrigin: 'direct' },
    phase: 'receiving',
    updatedAt: '2000-01-01T00:00:00.000Z',
  }) + '\n', { mode: 0o600 });
}

it('keeps the real service, SQLite data, active release, and configuration unchanged while a disconnected prepare reconciles under one target lock', async () => {
  const target = await createTarget({ holdBuild: true });
  const source = createRepository();
  const dataBefore = snapshotDirectory(target.dataDir);
  const currentBefore = readlinkSync(target.current);
  const configurationBefore = target.activeConfiguration.map((file) => sha256(readFileSync(file)));
  await reaches(target.server);
  await expect(new SshHostTransport({ profile: target.profile, runner: target.runner.run }).execute({ kind: 'gate-status' })).resolves.toMatchObject({
    kind: 'gate-status',
    value: { kind: 'available', response: { version: 1, state: 'open', barrier: false, activeWrites: 0, activeErpAttempt: false } },
  });

  target.runner.disconnectNextReceive = true;
  const interrupted = cli(source.repository, target, 'prepare', '--json');
  await waitFor(join(target.barrier, 'started'));
  const interruptedResult = await interrupted;
  expect(interruptedResult.code).toBe(3);

  const contended = await cli(source.repository, target, 'prepare', source.second, '--json');
  expect(contended).toMatchObject({ code: 1, out: expect.stringContaining('"state":"busy"') });
  expect(readFileSync(join(target.barrier, 'counter'), 'utf8')).toBe('install');

  const resumed = cli(source.repository, target, 'prepare', '--json');
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(readFileSync(join(target.barrier, 'counter'), 'utf8')).toBe('install');
  unlinkSync(join(target.barrier, 'hold'));
  const prepared = await resumed;
  expect(prepared.code).toBe(0);
  const output = JSON.parse(prepared.out) as { candidate: { state: string; manifest: string; phaseTimings: unknown }; source: { commit: string; archiveSha256: string } };
  expect(output.candidate.state).toBe('prepared');
  const manifest = JSON.parse(readFileSync(output.candidate.manifest, 'utf8')) as { source: { commit: string; archiveSha256: string; verifiedArchiveSha256: string; artifactOrigin: string }; recovery: { activeRelease: string; activeConfiguration: unknown[] }; phaseTimings: Array<{ phase: string }> };
  // The upload was timed by the disconnected receiver; the build phases by the detached worker.
  expect(manifest.phaseTimings.map((timing) => timing.phase)).toEqual(['upload', 'extract', 'install', 'build', 'native', 'config']);
  expect(output.candidate.phaseTimings).toEqual(manifest.phaseTimings);
  expect(manifest.source).toMatchObject({ commit: source.first, archiveSha256: output.source.archiveSha256, verifiedArchiveSha256: output.source.archiveSha256, artifactOrigin: 'direct' });
  expect(manifest.recovery.activeRelease).toBe('releases/active');
  expect(manifest.recovery.activeConfiguration).toHaveLength(3);
  expect(readlinkSync(target.current)).toBe(currentBefore);
  expect(snapshotDirectory(target.dataDir)).toEqual(dataBefore);
  expect(target.activeConfiguration.map((file) => sha256(readFileSync(file)))).toEqual(configurationBefore);
  await reaches(target.server);

  const status = await cli(source.repository, target, 'status', '--json');
  expect(status).toMatchObject({ code: 0, err: '' });
  expect(JSON.parse(status.out)).toMatchObject({ candidate: { journal: { phase: 'prepared' }, manifest: { source: { commit: source.first } } } });
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('verifies a local relay against the same committed archive checksum and reports missing bootstrap prerequisites without installing them', async () => {
  const target = await createTarget();
  const source = createRepository();
  const archive = execFileSync('git', ['archive', '--format=tar', source.first], { cwd: source.repository });
  const relay = join(source.repository, 'relay.tar');
  writeFileSync(relay, archive);

  const prepared = await cli(source.repository, target, 'prepare', source.first, '--relay', relay, '--json');
  expect(prepared.code).toBe(0);
  const result = JSON.parse(prepared.out) as { source: { archiveSha256: string }; candidate: { manifest: string } };
  const manifest = JSON.parse(readFileSync(result.candidate.manifest, 'utf8')) as { source: { artifactOrigin: string; archiveSha256: string; verifiedArchiveSha256: string } };
  expect(manifest.source).toEqual(expect.objectContaining({ artifactOrigin: 'relay', archiveSha256: result.source.archiveSha256, verifiedArchiveSha256: result.source.archiveSha256 }));

  const incomplete = await createTarget({ buildEnvironment: false });
  const activeBefore = readlinkSync(incomplete.current);
  const notReady = await cli(source.repository, incomplete, 'prepare', source.first, '--json');
  expect(notReady.code).toBe(1);
  expect(notReady.out).toContain('not-ready');
  expect(readlinkSync(incomplete.current)).toBe(activeBefore);
  expect(existsSync(join(incomplete.profile.deployRoot, 'runtime', 'pnpm-10.17.1', 'bin', 'pnpm'))).toBe(true);
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('prepares a real candidate through the CLI when the coordinator source exceeds Linux argument limits', async () => {
  const target = await createTarget();
  const source = createRepository();
  const coordinator = `${readFileSync(new URL('./candidate-coordinator.cjs', import.meta.url), 'utf8')}\n/*${'streamed coordinator source '.repeat(6_000)}*/\n`;
  const commands: string[] = [];
  const out: string[] = [];
  const err: string[] = [];

  expect(Buffer.byteLength(coordinator)).toBeGreaterThan(LINUX_MAX_ARG_STRLEN);
  const code = await runOperatorCli(['prepare', source.first, '--json'], {
    source: createSourceRepository(source.repository),
    host: new SshHostTransport({ profile: target.profile, runner: target.runner.run }),
    candidate: new SshCandidateTransport({
      profile: target.profile,
      runner: async (profile, remoteCommand, input) => {
        commands.push(remoteCommand);
        return target.runner.run(profile, remoteCommand, input);
      },
      coordinatorSource: () => coordinator,
    }),
  }, { out: (line) => out.push(line), err: (line) => err.push(line) });

  expect(code).toBe(0);
  expect(err).toEqual([]);
  expect(commands).toHaveLength(1);
  expect(commands.every((command) => Buffer.byteLength(command) < LINUX_MAX_ARG_STRLEN)).toBe(true);
  expect(commands[0]).not.toContain('streamed coordinator source');
  expect(JSON.parse(out.join('\n'))).toMatchObject({ candidate: { state: 'prepared' } });
  expect(readFileSync(join(target.profile.deployRoot, 'maintenance', 'candidate-coordinator.cjs'), 'utf8')).toBe(coordinator);
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('gives baox traversal to the build source without exposing candidate metadata or using a deploy-root cache', async () => {
  const target = await createTarget();
  const source = createRepository();

  const prepared = await cli(source.repository, target, 'prepare', source.first, '--json');

  expect(prepared.code).toBe(0);
  const candidateId = (JSON.parse(prepared.out) as { candidate: { candidateId: string } }).candidate.candidateId;
  const candidates = join(target.profile.deployRoot, 'candidates');
  const candidate = join(candidates, candidateId);
  expect(statSync(candidates).mode & 0o777).toBe(0o710);
  expect(statSync(candidate).mode & 0o777).toBe(0o710);
  expect(statSync(join(candidate, 'source')).mode & 0o777).toBe(0o700);
  expect(statSync(join(candidate, 'request.json')).mode & 0o777).toBe(0o600);
  expect(statSync(join(candidate, 'source.tar')).mode & 0o777).toBe(0o600);
  expect(statSync(join(candidate, 'recovery-config')).mode & 0o777).toBe(0o700);
  expect(readFileSync(join(target.barrier, 'chown.log'), 'utf8')).toEqual(expect.stringContaining(`root:baox ${candidates}`));
  expect(readFileSync(join(target.barrier, 'chown.log'), 'utf8')).toEqual(expect.stringContaining(`root:baox ${candidate}`));
  expect(readFileSync(join(target.barrier, 'chown.log'), 'utf8')).toEqual(expect.stringContaining(`-R baox:baox ${join(candidate, 'source')}`));
  expect(existsSync(join(target.profile.serviceHome, '.local', 'share', 'baox-pnpm'))).toBe(true);
  expect(existsSync(join(target.profile.serviceHome, '.cache', 'baox-build', 'pnpm-store'))).toBe(true);
  expect(existsSync(join(target.profile.deployRoot, 'cache'))).toBe(false);
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('reports the same malformed controlled build environment in doctor and prepare', async () => {
  const target = await createTarget();
  const source = createRepository();
  writeFileSync(target.profile.buildEnvironment, 'HTTP_PROXY=http://proxy.test:8080\nHTTPS_PROXY=http://proxy.test:8443\nNO_PROXY=127.0.0.1,localhost\nUNAPPROVED=value\n');
  chmodSync(target.profile.buildEnvironment, 0o600);
  const host = new SshHostTransport({ profile: target.profile, runner: target.runner.run });

  const doctor = await host.execute({ kind: 'doctor' });
  expect(doctor).toMatchObject({ kind: 'doctor', value: { issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid-build-environment' })]) } });

  const prepared = await cli(source.repository, target, 'prepare', source.first, '--json');
  expect(prepared.code).toBe(1);
  expect(prepared.out).toContain('invalid-build-environment');
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('claims a stale lock once when reconnecting operators prepare the same candidate', async () => {
  const target = await createTarget({ holdBuild: true });
  const source = createRepository();
  writeStaleReceivingState(target, source);

  const first = cli(source.repository, target, 'prepare', source.first, '--json');
  const second = cli(source.repository, target, 'prepare', source.first, '--json');
  await waitFor(join(target.barrier, 'started'));
  unlinkSync(join(target.barrier, 'hold'));
  const results = await Promise.all([first, second]);

  expect(readFileSync(join(target.barrier, 'counter'), 'utf8')).toBe('install');
  expect(results.some((result) => result.code === 0)).toBe(true);
  const final = await cli(source.repository, target, 'prepare', source.first, '--json');
  expect(final.code).toBe(0);
  const status = await cli(source.repository, target, 'status', '--json');
  expect(JSON.parse(status.out)).toMatchObject({ candidate: { lock: { state: 'unlocked' }, journal: { phase: 'prepared' } } });
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('preserves a successor lock when a worker loses its lease before release', async () => {
  const target = await createTarget({ holdBuild: true, fenceOldWorker: true });
  const source = createRepository();

  const preparation = cli(source.repository, target, 'prepare', source.first, '--json');
  await waitFor(join(target.barrier, 'started'));
  unlinkSync(join(target.barrier, 'hold'));
  const result = await preparation;

  expect(result.code).toBe(1);
  expect(JSON.parse(result.out)).toMatchObject({ candidate: { state: 'recovery-required' } });
  const owner = JSON.parse(readFileSync(join(target.profile.deployRoot, 'maintenance', 'deployment.lock', 'owner.json'), 'utf8')) as { token: string };
  expect(owner.token).toBe('f'.repeat(64));
  expect(JSON.parse(readFileSync(join(target.profile.deployRoot, 'maintenance', 'deployment-journal.json'), 'utf8'))).toMatchObject({ phase: 'recovery-required' });
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('reports an unavailable coordinator without rewriting a journal when status inspection fails', async () => {
  const target = await createTarget();
  const source = createRepository();
  const maintenance = join(target.profile.deployRoot, 'maintenance');
  mkdirSync(maintenance, { recursive: true, mode: 0o700 });
  const journal = join(maintenance, 'deployment-journal.json');
  const sentinel = '{"preserve":"read-only-status"}\n';
  writeFileSync(journal, sentinel, { mode: 0o600 });
  const out: string[] = [];
  const err: string[] = [];

  const code = await runOperatorCli(['status', '--json'], {
    source: createSourceRepository(source.repository),
    host: new SshHostTransport({ profile: target.profile, runner: target.runner.run }),
    candidate: new SshCandidateTransport({ profile: { ...target.profile, buildPython: 'relative-path-is-invalid' }, runner: target.runner.run }),
  }, { out: (line) => out.push(line), err: (line) => err.push(line) });

  expect(code).toBe(0);
  expect(err).toEqual([]);
  expect(JSON.parse(out.join('\n'))).toMatchObject({ candidate: { state: 'unavailable' } });
  expect(readFileSync(journal, 'utf8')).toBe(sentinel);
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('repairs an incompatible SQLite prebuild only inside the candidate using the controlled native toolchain', async () => {
  const target = await createTarget();
  const source = createRepository();
  const currentBefore = readlinkSync(target.current);
  const dataBefore = snapshotDirectory(target.dataDir);
  writeFileSync(join(target.barrier, 'force-native-sqlite'), 'enabled\n');

  const result = await cli(source.repository, target, 'prepare', '--json');

  expect(result.code, `${result.out}\n${result.err}`).toBe(0);
  const candidateId = readdirSync(join(target.profile.deployRoot, 'candidates'))[0]!;
  const addon = join(target.profile.deployRoot, 'candidates', candidateId, 'source', 'server', 'node_modules', 'better-sqlite3');
  expect(readFileSync(join(addon, 'prebuilds', `${process.platform}-${process.arch}.node.upstream-disabled`), 'utf8'))
    .toBe('incompatible upstream native binary');
  expect(JSON.parse(readFileSync(join(addon, 'native-build-evidence.json'), 'utf8'))).toEqual({
    args: ['rebuild', '--release', '--jobs=2', `--nodedir=${join(target.profile.deployRoot, 'runtime', 'node')}`],
    python: target.profile.buildPython,
    compiler: join(target.profile.deployRoot, 'runtime', 'gcc-12.5.0', 'bin', 'g++'),
  });
  expect(readlinkSync(target.current)).toBe(currentBefore);
  expect(snapshotDirectory(target.dataDir)).toEqual(dataBefore);
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('retains the installed origin when new candidate templates default to port 8888', async () => {
  const target = await createTarget();
  const source = createRepository();
  const templates = join(source.repository, 'deploy', 'intranet');
  for (const file of ['render-config.mjs', 'Caddyfile', 'baox.service']) {
    writeFileSync(join(templates, file), readFileSync(new URL('../../intranet/' + file, import.meta.url)));
  }
  // The host files the unit names must sit under the deploy root, here the isolated target's.
  writeFileSync(join(templates, 'baox.service'), readFileSync(join(templates, 'baox.service'), 'utf8').replaceAll('/opt/tools/baox/', target.profile.deployRoot + '/'));
  mkdirSync(join(source.repository, 'server', 'src'), { recursive: true });
  writeFileSync(join(source.repository, 'server', 'src', 'public-origin.ts'), readFileSync(new URL('../../../server/src/public-origin.ts', import.meta.url)));
  const service = join(target.profile.systemdDir, 'baox.service');
  writeFileSync(service, readFileSync(service, 'utf8') + 'Environment=BAOX_PUBLIC_ORIGIN=http://10.250.0.222\n');
  git(source.repository, ['add', '.']);
  git(source.repository, ['commit', '--quiet', '-m', 'new default origin']);
  const prepared = await cli(source.repository, target, 'prepare', 'HEAD', '--json');
  expect(prepared.code, prepared.out + prepared.err).toBe(0);
  const result = JSON.parse(prepared.out) as { candidate: { manifest: string } };
  const built = join(result.candidate.manifest, '..', 'source', 'deploy', 'intranet');
  expect(readFileSync(join(built, 'baox.service'), 'utf8')).toContain('Environment=BAOX_PUBLIC_ORIGIN=http://10.250.0.222\n');
  expect(readFileSync(join(built, 'Caddyfile'), 'utf8')).toContain('http://10.250.0.222 {');
  expect(readFileSync(service, 'utf8')).toContain('Environment=BAOX_PUBLIC_ORIGIN=http://10.250.0.222\n');
}, REAL_SUBPROCESS_TIMEOUT_MS);

// A release from line 2 on (erp-headless-v1.md): its unit names the ERP 凭据 key and the 本地执行器 runtimes, and it
// has a 本地执行器 whose runtime fetch is stood in for by a script that records where it was asked to put them.
function writeHostNeeds(repository: string, deployRoot: string): { keyFile: string; runtimes: string } {
  const keyFile = join(deployRoot, 'etc', 'erp-credential.key');
  const runtimes = join(deployRoot, 'cache', 'local-executor-runtime');
  writeFileSync(join(repository, 'deploy', 'intranet', 'baox.service'), [
    '[Service]',
    'Environment=BAOX_PUBLIC_ORIGIN=http://10.250.0.222',
    `Environment=BAOX_ERP_CREDENTIAL_KEY_FILE=${keyFile}`,
    `Environment=BAOX_LOCAL_EXECUTOR_RUNTIMES=${runtimes}`,
    '',
  ].join('\n'));
  mkdirSync(join(repository, 'local-executor', 'scripts'), { recursive: true });
  writeFileSync(join(repository, 'local-executor', 'package.json'), JSON.stringify({ name: '@baox/local-executor' }) + '\n');
  writeFileSync(join(repository, 'local-executor', 'scripts', 'fetch-runtimes.mjs'),
    "import { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nwriteFileSync(join(process.argv[2], 'VERSION'), process.versions.node + '\\n');\n");
  return { keyFile, runtimes };
}

it('creates the ERP 凭据 key once, never replaces it, and fetches the 本地执行器 runtimes outside the release', async () => {
  const target = await createTarget();
  const source = createRepository();
  const { keyFile, runtimes } = writeHostNeeds(source.repository, target.profile.deployRoot);
  const first = commitAll(source.repository, 'line 2 host needs');

  const prepared = await prepareCandidate(source.repository, target, first);
  expect(prepared.manifest.phaseTimings.map((timing) => timing.phase)).toEqual(['upload', 'extract', 'install', 'build', 'native', 'host', 'config']);
  const key = readFileSync(keyFile, 'utf8');
  expect(key).toMatch(/^[0-9a-f]{64}\n$/u);
  expect(statSync(keyFile).mode & 0o777).toBe(0o640);
  expect(readFileSync(join(runtimes, 'VERSION'), 'utf8')).toBe(`${process.versions.node}\n`);
  const chowned = readFileSync(join(target.barrier, 'chown.log'), 'utf8');
  expect(chowned).toContain(`-h root:baox ${keyFile}`);
  expect(chowned).toContain(`-h baox:baox ${runtimes}`);
  expect(readFileSync(join(prepared.source, 'local-executor', 'dist', 'baox-local-executor.mjs'), 'utf8')).toBe('program');

  writeFileSync(join(source.repository, 'version.txt'), 'third\n');
  const next = commitAll(source.repository, 'another release');
  await prepareCandidate(source.repository, target, next);
  expect(readFileSync(keyFile, 'utf8')).toBe(key);
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('stops before the configuration when the ERP 凭据 key on the host is not a key, and leaves it as it was', async () => {
  const target = await createTarget();
  const source = createRepository();
  const { keyFile } = writeHostNeeds(source.repository, target.profile.deployRoot);
  const commit = commitAll(source.repository, 'line 2 host needs');
  mkdirSync(join(keyFile, '..'), { recursive: true });
  writeFileSync(keyFile, 'not a key\n', { mode: 0o600 });
  const currentBefore = readlinkSync(target.current);

  const prepared = await cli(source.repository, target, 'prepare', commit, '--json');
  expect(prepared.code).not.toBe(0);
  expect(prepared.out + prepared.err).toContain('erp-credential-key-invalid');
  expect(readFileSync(keyFile, 'utf8')).toBe('not a key\n');
  expect(readlinkSync(target.current)).toBe(currentBefore);
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('refuses a unit that names a host file outside the deploy root', async () => {
  const target = await createTarget();
  const source = createRepository();
  writeHostNeeds(source.repository, target.profile.deployRoot);
  const service = join(source.repository, 'deploy', 'intranet', 'baox.service');
  writeFileSync(service, readFileSync(service, 'utf8').replace(/BAOX_ERP_CREDENTIAL_KEY_FILE=.*$/mu, 'BAOX_ERP_CREDENTIAL_KEY_FILE=/etc/erp-credential.key'));
  const commit = commitAll(source.repository, 'key outside the deploy root');

  const prepared = await cli(source.repository, target, 'prepare', commit, '--json');
  expect(prepared.code).not.toBe(0);
  expect(prepared.out + prepared.err).toContain('host-path-outside-deploy-root');
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('never chowns through a link the service account left where the runtimes go', async () => {
  const target = await createTarget();
  const source = createRepository();
  const { runtimes } = writeHostNeeds(source.repository, target.profile.deployRoot);
  const commit = commitAll(source.repository, 'line 2 host needs');
  const elsewhere = mkdtempSync(join(tmpdir(), 'baox-elsewhere-'));
  cleanup.push(() => rmSync(elsewhere, { recursive: true, force: true }));
  mkdirSync(join(runtimes, '..'), { recursive: true });
  symlinkSync(elsewhere, runtimes);

  const prepared = await cli(source.repository, target, 'prepare', commit, '--json');
  expect(prepared.code).not.toBe(0);
  expect(prepared.out + prepared.err).toContain('host-path-not-plain');
  const chowned = existsSync(join(target.barrier, 'chown.log')) ? readFileSync(join(target.barrier, 'chown.log'), 'utf8') : '';
  expect(chowned).not.toContain(runtimes);
  expect(readdirSync(elsewhere)).toEqual([]);
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('ships a unit whose host files sit under the production deploy root', () => {
  const unit = readFileSync(new URL('../../intranet/baox.service', import.meta.url), 'utf8');
  for (const name of ['BAOX_ERP_CREDENTIAL_KEY_FILE', 'BAOX_LOCAL_EXECUTOR_RUNTIMES']) {
    const value = new RegExp(`^Environment=${name}=(.+)$`, 'mu').exec(unit)?.[1];
    expect(value, name).toBeDefined();
    expect(value!.startsWith(`${NATIVE_PROFILE.deployRoot}/`), name).toBe(true);
    expect(value, name).not.toContain('..');
  }
});

function writeWorkspaceSource(repository: string): void {
  writeCandidateSource(repository, 'workspace');
  writeFileSync(join(repository, 'package.json'), JSON.stringify({ name: 'candidate-workspace', packageManager: 'pnpm@10.17.1', scripts: { build: 'pnpm -r build' } }) + '\n');
  writeFileSync(join(repository, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  writeFileSync(join(repository, 'pnpm-workspace.yaml'), 'packages:\n  - server\n  - web\n  - extension\n  - contract\n\nonlyBuiltDependencies:\n  - better-sqlite3\n');
  const workspace = (directory: string, build: boolean) => {
    mkdirSync(join(repository, directory, 'src'), { recursive: true });
    writeFileSync(join(repository, directory, 'package.json'), JSON.stringify({
      name: `@baox/${directory}`,
      ...(build ? { scripts: { build: 'node build.mjs' }, dependencies: { '@baox/contract': 'workspace:*' } } : {}),
    }) + '\n');
    writeFileSync(join(repository, directory, 'src', 'index.ts'), `export const name = '${directory}';\n`);
  };
  workspace('contract', false);
  for (const directory of ['server', 'web', 'extension']) workspace(directory, true);
}

function commitAll(repository: string, message: string): string {
  git(repository, ['add', '.']);
  git(repository, ['commit', '--quiet', '-m', message]);
  return git(repository, ['rev-parse', 'HEAD']).trim();
}

type PreparedManifest = { candidateId: string; buildInputs?: unknown; phaseTimings: Array<{ phase: string; reused?: boolean; rebuilt?: string[] }> };

async function prepareCandidate(repository: string, target: IsolatedTarget, commit: string): Promise<{ manifest: PreparedManifest; source: string }> {
  const prepared = await cli(repository, target, 'prepare', commit, '--json');
  expect(prepared.code, prepared.out + prepared.err).toBe(0);
  const manifestFile = (JSON.parse(prepared.out) as { candidate: { manifest: string } }).candidate.manifest;
  return { manifest: JSON.parse(readFileSync(manifestFile, 'utf8')) as PreparedManifest, source: join(manifestFile, '..', 'source') };
}

// What cutover's promotion does: the candidate source becomes releases/<id> and current points at it.
function promote(target: IsolatedTarget, candidateId: string): string {
  const release = join(target.profile.deployRoot, 'releases', candidateId);
  renameSync(join(target.profile.deployRoot, 'candidates', candidateId, 'source'), release);
  unlinkSync(target.current);
  symlinkSync(`releases/${candidateId}`, target.current);
  return release;
}

function reuseMarkers(timings: PreparedManifest['phaseTimings']) {
  return Object.fromEntries(timings.map(({ phase, reused, rebuilt }) => [phase, { reused, rebuilt }]));
}

function workspaceRepository(): { repository: string; first: string } {
  const repository = mkdtempSync(join(tmpdir(), 'baox-candidate-workspace-'));
  cleanup.push(() => rmSync(repository, { recursive: true, force: true }));
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'user.name', 'candidate test']);
  git(repository, ['config', 'user.email', 'candidate@example.test']);
  writeWorkspaceSource(repository);
  return { repository, first: commitAll(repository, 'first') };
}

it('reuses the running release\'s node_modules, native module and unchanged package builds, and installs fresh on a lockfile change', async () => {
  const target = await createTarget();
  const { repository, first } = workspaceRepository();
  const builds = () => readFileSync(join(target.barrier, 'builds'), 'utf8').trim().split('\n');

  const running = await prepareCandidate(repository, target, first);
  expect(running.manifest.buildInputs).toMatchObject({
    schema: 1,
    packages: { '@baox/server': { directory: 'server' }, '@baox/web': { directory: 'web' }, '@baox/extension': { directory: 'extension' } },
  });
  expect(reuseMarkers(running.manifest.phaseTimings)).toMatchObject({ install: { reused: undefined }, build: { rebuilt: undefined }, native: { reused: undefined } });
  const release = promote(target, running.manifest.candidateId);
  const releaseBefore = snapshotDirectory(release);

  writeFileSync(join(repository, 'web', 'src', 'index.ts'), "export const name = 'web, changed';\n");
  const webOnly = await prepareCandidate(repository, target, commitAll(repository, 'web only'));

  expect(readFileSync(join(target.barrier, 'counter'), 'utf8')).toBe('install');
  expect(builds()).toEqual(['build:all', 'build:web']);
  expect(reuseMarkers(webOnly.manifest.phaseTimings)).toMatchObject({
    install: { reused: true },
    build: { rebuilt: ['@baox/web'] },
    native: { reused: true },
  });
  expect(statSync(join(webOnly.source, 'node_modules', '.installed-in')).ino).toBe(statSync(join(release, 'node_modules', '.installed-in')).ino);
  expect(readlinkSync(join(webOnly.source, 'server', 'node_modules'))).toBe(readlinkSync(join(release, 'server', 'node_modules')));
  expect(readFileSync(join(webOnly.source, 'server', 'dist', 'main.mjs'), 'utf8')).toBe('main');
  expect(readFileSync(join(webOnly.source, 'extension', 'dist', 'manifest.json'), 'utf8')).toBe('{"manifest_version":3}');
  expect(readFileSync(join(webOnly.source, 'web', 'dist', 'index.html'), 'utf8')).toBe('<html>rebuilt</html>');
  expect(snapshotDirectory(release)).toEqual(releaseBefore);

  writeFileSync(join(repository, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n# changed\n");
  const lockfile = await prepareCandidate(repository, target, commitAll(repository, 'lockfile'));

  expect(readFileSync(join(target.barrier, 'counter'), 'utf8')).toBe('installinstall');
  expect(builds()).toEqual(['build:all', 'build:web', 'build:all']);
  expect(reuseMarkers(lockfile.manifest.phaseTimings)).toMatchObject({ install: { reused: undefined }, build: { rebuilt: undefined }, native: { reused: undefined } });
  expect(statSync(join(lockfile.source, 'node_modules', '.installed-in')).ino).not.toBe(statSync(join(release, 'node_modules', '.installed-in')).ino);
  expect(snapshotDirectory(release)).toEqual(releaseBefore);
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('repairs the native module in a private copy when reused node_modules fail the smoke test, leaving the running release byte-identical', async () => {
  const target = await createTarget();
  writeFileSync(join(target.barrier, 'force-native-sqlite'), 'enabled\n');
  const { repository, first } = workspaceRepository();
  const running = await prepareCandidate(repository, target, first);
  const release = promote(target, running.manifest.candidateId);
  const releaseAddon = join(release, 'server', 'node_modules', 'better-sqlite3');
  expect(existsSync(join(releaseAddon, 'native-build-evidence.json'))).toBe(true);
  // The running release's addon stops loading, so the candidate that links it must rebuild.
  writeFileSync(join(releaseAddon, 'build', 'Release', 'better_sqlite3.node'), 'broken native module');
  const releaseBefore = snapshotDirectory(release);

  writeFileSync(join(repository, 'web', 'src', 'index.ts'), "export const name = 'web, changed';\n");
  const webOnly = await prepareCandidate(repository, target, commitAll(repository, 'web only'));

  expect(reuseMarkers(webOnly.manifest.phaseTimings)).toMatchObject({ install: { reused: true }, native: { reused: undefined } });
  const candidateAddon = join(webOnly.source, 'server', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  expect(readFileSync(candidateAddon, 'utf8')).not.toBe('broken native module');
  expect(statSync(candidateAddon).ino).not.toBe(statSync(join(releaseAddon, 'build', 'Release', 'better_sqlite3.node')).ino);
  expect(snapshotDirectory(release)).toEqual(releaseBefore);
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('installs fresh when reusing node_modules fails, even when the half-made copy cannot be removed', async () => {
  const target = await createTarget();
  cleanup.push(() => { execFileSync('chmod', ['-R', 'u+w', target.profile.deployRoot]); });
  const { repository, first } = workspaceRepository();
  const running = await prepareCandidate(repository, target, first);
  const release = promote(target, running.manifest.candidateId);
  // The root node_modules links fine but leaves a directory rm cannot empty;
  // web/node_modules then fails to copy (a FIFO is not a supported entry).
  const readonly = join(release, 'node_modules', 'readonly');
  mkdirSync(readonly);
  writeFileSync(join(readonly, 'file'), 'kept');
  chmodSync(readonly, 0o555);
  mkdirSync(join(release, 'web', 'node_modules'));
  execFileSync('mkfifo', [join(release, 'web', 'node_modules', 'pipe')]);
  const releaseBefore = snapshotDirectory(release);

  writeFileSync(join(repository, 'web', 'src', 'index.ts'), "export const name = 'web, changed';\n");
  const webOnly = await prepareCandidate(repository, target, commitAll(repository, 'web only'));

  expect(readFileSync(join(target.barrier, 'counter'), 'utf8')).toBe('installinstall');
  expect(reuseMarkers(webOnly.manifest.phaseTimings)).toMatchObject({ install: { reused: undefined }, build: { rebuilt: ['@baox/web'] } });
  expect(existsSync(join(webOnly.source, 'node_modules', 'readonly'))).toBe(false);
  expect(existsSync(join(webOnly.source, 'web', 'node_modules'))).toBe(false);
  expect(statSync(join(webOnly.source, 'node_modules', '.installed-in')).ino).not.toBe(statSync(join(release, 'node_modules', '.installed-in')).ino);
  expect(snapshotDirectory(release)).toEqual(releaseBefore);
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('keeps package builds when only docs-only root files change', async () => {
  const target = await createTarget();
  const { repository, first } = workspaceRepository();
  const running = await prepareCandidate(repository, target, first);
  promote(target, running.manifest.candidateId);

  writeFileSync(join(repository, 'README.md'), '# docs only\n');
  const docsOnly = await prepareCandidate(repository, target, commitAll(repository, 'docs only'));

  expect(reuseMarkers(docsOnly.manifest.phaseTimings)).toMatchObject({ install: { reused: true }, build: { reused: true, rebuilt: [] } });
}, REAL_SUBPROCESS_TIMEOUT_MS);
