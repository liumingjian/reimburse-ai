import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { SshCandidateTransport } from './candidate.js';
import { runOperatorCli } from './cli.js';
import { LINUX_MAX_ARG_STRLEN } from './coordinator-transport.js';
import { SshHostTransport } from './host.js';
import { createSourceRepository } from './source.js';
import { createIsolatedTarget, type IsolatedTarget } from './testing/isolated-target.js';

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
  for (let attempt = 0; attempt < 400; attempt += 1) {
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
  const output = JSON.parse(prepared.out) as { candidate: { state: string; manifest: string }; source: { commit: string; archiveSha256: string } };
  expect(output.candidate.state).toBe('prepared');
  const manifest = JSON.parse(readFileSync(output.candidate.manifest, 'utf8')) as { source: { commit: string; archiveSha256: string; verifiedArchiveSha256: string; artifactOrigin: string }; recovery: { activeRelease: string; activeConfiguration: unknown[] } };
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
}, 30_000);

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
});

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
});

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
});

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
});

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
});
