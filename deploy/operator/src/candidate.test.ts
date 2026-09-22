import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../../../server/src/server.js';
import { writeBlob } from '../../../server/src/data-dir.js';
import { SshCandidateTransport } from './candidate.js';
import { runOperatorCli } from './cli.js';
import { SshHostTransport, type SshResult, type SshRunner } from './host.js';
import { NATIVE_PROFILE, type NativeProfile } from './profile.js';
import { createSourceRepository } from './source.js';

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const remove of cleanup.splice(0).reverse()) await remove();
});

type IsolatedTarget = {
  root: string;
  dataDir: string;
  profile: NativeProfile;
  runner: LocalTargetRunner;
  barrier: string;
  server: RunningServer;
  current: string;
  activeConfiguration: string[];
};

class LocalTargetRunner {
  disconnectNextReceive = false;

  constructor(private readonly fakeBin: string, private readonly barrier: string) {}

  readonly run: SshRunner = async (_profile, remoteCommand, input) => new Promise<SshResult>((resolve, reject) => {
    const child = spawn('sh', ['-c', remoteCommand], {
      env: { ...process.env, PATH: `${this.fakeBin}:${process.env.PATH ?? ''}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.resume();
    child.stdin.on('error', () => undefined);
    if (input) {
      input.on('error', reject);
      input.pipe(child.stdin);
    } else {
      child.stdin.end();
    }

    let disconnectTimer: NodeJS.Timeout | undefined;
    if (this.disconnectNextReceive && remoteCommand.includes(' receive')) {
      this.disconnectNextReceive = false;
      disconnectTimer = setInterval(() => {
        if (existsSync(join(this.barrier, 'started'))) child.kill('SIGKILL');
      }, 10);
    }
    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (disconnectTimer) clearInterval(disconnectTimer);
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), exitCode });
    });
  });
}

async function createTarget({ holdBuild = false, buildEnvironment = true }: { holdBuild?: boolean; buildEnvironment?: boolean } = {}): Promise<IsolatedTarget> {
  const root = mkdtempSync(join(tmpdir(), 'baox-candidate-target-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const deployRoot = join(root, 'deploy');
  const dataDir = join(deployRoot, 'data');
  const systemdDir = join(root, 'systemd');
  const fakeBin = join(root, 'fake-bin');
  const barrier = join(root, 'barrier');
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(barrier, { recursive: true });
  if (holdBuild) writeFileSync(join(barrier, 'hold'), 'hold\n');

  mkdirSync(join(deployRoot, 'runtime', 'node', 'bin'), { recursive: true });
  symlinkSync(process.execPath, join(deployRoot, 'runtime', 'node', 'bin', 'node'));
  mkdirSync(join(deployRoot, 'runtime', 'pnpm-10.17.1', 'bin'), { recursive: true });
  writeExecutable(join(deployRoot, 'runtime', 'pnpm-10.17.1', 'bin', 'pnpm'), pnpmScript(barrier));
  mkdirSync(join(deployRoot, 'runtime', 'gcc-12.5.0', 'bin'), { recursive: true });
  mkdirSync(join(deployRoot, 'runtime', 'gcc-12.5.0', 'lib64'), { recursive: true });
  writeExecutable(join(deployRoot, 'runtime', 'gcc-12.5.0', 'bin', 'g++'), '#!/bin/sh\nprintf "12.5.0\\n"\n');
  mkdirSync(join(deployRoot, 'bin'), { recursive: true });
  writeExecutable(join(deployRoot, 'bin', 'caddy'), '#!/bin/sh\nif [ "$1" = version ]; then printf "v2.10.2\\n"; fi\nexit 0\n');
  const testPython = join(fakeBin, 'python');
  writeExecutable(testPython, '#!/bin/sh\nprintf "Python 3.12.14\\n"\n');
  mkdirSync(join(deployRoot, 'etc'), { recursive: true });
  if (buildEnvironment) {
    const buildEnv = join(deployRoot, 'etc', 'build.env');
    writeFileSync(buildEnv, 'HTTP_PROXY=http://proxy.test:8080\nHTTPS_PROXY=http://proxy.test:8443\nNO_PROXY=127.0.0.1,localhost\nnpm_config_registry=https://registry.test/npm\n');
    chmodSync(buildEnv, 0o600);
  }
  writeFileSync(join(deployRoot, 'etc', 'Caddyfile'), 'http://10.250.0.222 {\n  respond "active"\n}\n');
  mkdirSync(systemdDir, { recursive: true });
  writeFileSync(join(systemdDir, 'baox.service'), '[Service]\nExecStart=/opt/tools/baox/current/server/dist/main.mjs\n');
  writeFileSync(join(systemdDir, 'baox-caddy.service'), '[Service]\nExecStart=/opt/tools/baox/bin/caddy\n');
  mkdirSync(join(deployRoot, 'releases', 'active'), { recursive: true });
  symlinkSync('releases/active', join(deployRoot, 'current'));
  mkdirSync(join(deployRoot, 'cache', 'home'), { recursive: true });
  mkdirSync(join(deployRoot, 'cache', 'pnpm-home'), { recursive: true });
  mkdirSync(join(deployRoot, 'cache', 'pnpm-store'), { recursive: true });
  writeExecutable(join(fakeBin, 'id'), '#!/bin/sh\nif [ "$1" = baox ]; then exit 0; fi\nexec /usr/bin/id "$@"\n');
  writeExecutable(join(fakeBin, 'chown'), '#!/bin/sh\nexit 0\n');
  writeExecutable(join(fakeBin, 'runuser'), '#!/bin/sh\n[ "$1" = -u ] || exit 2\nshift 2\n[ "$1" = -- ] && shift\nexec "$@"\n');
  writeExecutable(join(deployRoot, 'bin', 'baox-maintenance-gate'), '#!/bin/sh\nif [ "$1" = status ]; then printf \'{"version":1,"state":"open","barrier":false,"activeWrites":0,"activeErpAttempt":false}\\n\'; exit 0; fi\nexit 65\n');

  const server = await startServer({ dataDir, port: 0 });
  cleanup.push(() => server.close());
  writeBlob(dataDir, Buffer.from('real original file\n'));
  const runner = new LocalTargetRunner(fakeBin, barrier);
  const profile = {
    ...NATIVE_PROFILE,
    host: 'isolated.test',
    deployRoot,
    dataDir,
    systemdDir,
    buildEnvironment: join(deployRoot, 'etc', 'build.env'),
    buildPython: testPython,
    maintenanceWrapper: join(deployRoot, 'bin', 'baox-maintenance-gate'),
    maintenanceSocket: join(dataDir, 'maintenance-gate.sock'),
  };
  return {
    root,
    dataDir,
    profile,
    runner,
    barrier,
    server,
    current: join(deployRoot, 'current'),
    activeConfiguration: [join(deployRoot, 'etc', 'Caddyfile'), join(systemdDir, 'baox.service'), join(systemdDir, 'baox-caddy.service')],
  };
}

function pnpmScript(barrier: string): string {
  return `#!/bin/sh
if [ "$1" = --version ]; then printf '10.17.1\\n'; exit 0; fi
if [ "$1" = install ]; then
  printf install >> '${join(barrier, 'counter')}'
  touch '${join(barrier, 'started')}'
  while [ -f '${join(barrier, 'hold')}' ]; do sleep 0.02; done
  exit 0
fi
if [ "$1" = build ]; then
  mkdir -p server/dist web/dist extension/dist
  printf 'main' > server/dist/main.mjs
  printf 'cli' > server/dist/baox.mjs
  printf '<html></html>' > web/dist/index.html
  printf '{"manifest_version":3}' > extension/dist/manifest.json
  exit 0
fi
exit 2
`;
}

function writeExecutable(file: string, content: string): void {
  writeFileSync(file, content, { mode: 0o755 });
  chmodSync(file, 0o755);
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

async function reaches(server: RunningServer): Promise<void> {
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

it('keeps the real service, SQLite data, active release, and configuration unchanged while a disconnected prepare reconciles under one target lock', async () => {
  const target = await createTarget({ holdBuild: true });
  const source = createRepository();
  const dataBefore = snapshotDirectory(target.dataDir);
  const currentBefore = readlinkSync(target.current);
  const configurationBefore = target.activeConfiguration.map((file) => sha256(readFileSync(file)));
  await reaches(target.server);

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
});

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
