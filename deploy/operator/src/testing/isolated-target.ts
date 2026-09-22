import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startServer, type RunningServer } from '../../../../server/src/server.js';
import { writeBlob } from '../../../../server/src/data-dir.js';
import { type SshResult, type SshRunner } from '../host.js';
import { NATIVE_PROFILE, type NativeProfile } from '../profile.js';

export type IsolatedTarget = {
  root: string;
  dataDir: string;
  profile: NativeProfile;
  runner: LocalTargetRunner;
  barrier: string;
  server: RunningServer;
  current: string;
  activeConfiguration: string[];
  close: () => Promise<void>;
};

export type IsolatedTargetOptions = {
  holdBuild?: boolean;
  buildEnvironment?: boolean;
  fenceOldWorker?: boolean;
  snapshotAvailableBytes?: number;
};

export type ManagedServiceController = {
  serviceUrl: string;
  publicUrl: string;
  startService: () => void;
  stopService: () => void;
  restartService: () => void;
  startProxy: () => void;
  stopProxy: () => void;
  restartProxy: () => void;
  failNextStart: (service: 'baox' | 'proxy') => void;
  failLoopbackProbeVerification: () => void;
  serveWrongLoopbackSession: () => void;
  refuseNextAdmission: () => void;
  commands: () => string[];
  loopbackProbeStarts: () => number;
};

export type SnapshotIsolatedTarget = Omit<IsolatedTarget, 'server' | 'close'> & {
  controller: ManagedServiceController;
  close: () => Promise<void>;
};

type SystemctlValues = {
  barrier: string;
  commands: string;
  servicePid: string;
  proxyPid: string;
  serviceLog: string;
  proxyLog: string;
  failServiceStart: string;
  failProxyStart: string;
  failProxyVerification: string;
  node: string;
  current: string;
  dataDir: string;
  tokenFile: string;
  servicePort: number;
  publicPort: number;
  publicHost: string;
  proxy: string;
  runtimeRoot: string;
  mutationScript: string;
};

/**
 * Runs the production target driver against a temporary host layout. The baox
 * server, SQLite database, blob files, maintenance socket, and control token
 * are real; only operating-system build commands are narrow test shims.
 */
export class LocalTargetRunner {
  disconnectNextReceive = false;
  disconnectNextSnapshot = false;
  disconnectNextCutoverTransportOnly = false;
  interruptNextCutoverAtPhase: string | null = null;
  interruptNextCutoverAfterPrivateProbeStart = false;

  constructor(private readonly fakeBin: string, private readonly barrier: string, private readonly environment: NodeJS.ProcessEnv = {}) {}

  setSnapshotAvailableBytes(bytes: number | undefined): void {
    if (bytes === undefined) {
      delete this.environment.BAOX_TEST_SNAPSHOT_AVAILABLE_BYTES;
      return;
    }
    this.environment.BAOX_TEST_SNAPSHOT_AVAILABLE_BYTES = String(bytes);
  }

  readonly run: SshRunner = async (profile, remoteCommand, input) => new Promise<SshResult>((resolve, reject) => {
    const child = spawn('sh', ['-c', remoteCommand], {
      env: { ...process.env, ...this.environment, PATH: `${this.fakeBin}:${process.env.PATH ?? ''}` },
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
    let transportDisconnected = false;
    if (this.disconnectNextReceive && remoteCommand.includes('receive')) {
      this.disconnectNextReceive = false;
      disconnectTimer = setInterval(() => {
        if (existsSync(join(this.barrier, 'started'))) child.kill('SIGKILL');
      }, 10);
    }
    if (this.disconnectNextSnapshot && remoteCommand.includes('snapshot')) {
      this.disconnectNextSnapshot = false;
      disconnectTimer = setInterval(() => {
        if (existsSync(join(this.barrier, 'snapshot-stop-started'))) child.kill('SIGKILL');
      }, 10);
    }
    if (this.disconnectNextCutoverTransportOnly && remoteCommand.includes('cutover')) {
      this.disconnectNextCutoverTransportOnly = false;
      const journal = join(profile.deployRoot, 'maintenance', 'deployment-journal.json');
      disconnectTimer = setInterval(() => {
        try {
          const value = JSON.parse(readFileSync(journal, 'utf8')) as { operation?: string };
          if (value.operation !== 'recovery-snapshot' && value.operation !== 'cutover') return;
          transportDisconnected = true;
          clearInterval(disconnectTimer);
          resolve({ stdout: '', exitCode: 255 });
        } catch {
          // The coordinator has not passed its first durable checkpoint yet.
        }
      }, 10);
    }
    if (this.interruptNextCutoverAtPhase && remoteCommand.includes('cutover')) {
      const phase = this.interruptNextCutoverAtPhase;
      this.interruptNextCutoverAtPhase = null;
      const journal = join(profile.deployRoot, 'maintenance', 'deployment-journal.json');
      disconnectTimer = setInterval(() => {
        try {
          const value = JSON.parse(readFileSync(journal, 'utf8')) as { operation?: string; phase?: string };
          if (value.operation === 'cutover' && value.phase === phase) child.kill('SIGKILL');
        } catch {
          // The coordinator has not reached the requested durable phase yet.
        }
      }, 10);
    }
    if (this.interruptNextCutoverAfterPrivateProbeStart && remoteCommand.includes('cutover')) {
      this.interruptNextCutoverAfterPrivateProbeStart = false;
      const journal = join(profile.deployRoot, 'maintenance', 'deployment-journal.json');
      const probeStarted = join(this.barrier, 'loopback-proxy-probe-started');
      disconnectTimer = setInterval(() => {
        try {
          const value = JSON.parse(readFileSync(journal, 'utf8')) as { operation?: string; phase?: string };
          if (value.operation !== 'cutover' || value.phase !== 'candidate-proxy-probe-started' || !existsSync(probeStarted)) return;
          child.kill('SIGKILL');
        } catch {
          // The coordinator has not reached the durable private-probe checkpoint yet.
        }
      }, 10);
    }
    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (disconnectTimer) clearInterval(disconnectTimer);
      if (!transportDisconnected) resolve({ stdout: Buffer.concat(stdout).toString('utf8'), exitCode });
    });
  });
}

export async function createIsolatedTarget({ holdBuild = false, buildEnvironment = true, fenceOldWorker = false, snapshotAvailableBytes }: IsolatedTargetOptions = {}): Promise<IsolatedTarget> {
  const root = mkdtempSync(join(tmpdir(), 'baox-candidate-target-'));
  const deployRoot = join(root, 'deploy');
  const dataDir = join(deployRoot, 'data');
  const serviceHome = join(root, 'home', 'baox');
  const systemdDir = join(root, 'systemd');
  const fakeBin = join(root, 'fake-bin');
  const barrier = join(root, 'barrier');
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(barrier, { recursive: true });
  if (holdBuild) writeFileSync(join(barrier, 'hold'), 'hold\n');
  if (fenceOldWorker) writeFileSync(join(barrier, 'fence-old-worker'), 'enabled\n');

  mkdirSync(join(deployRoot, 'runtime', 'node-test', 'bin'), { recursive: true });
  symlinkSync(process.execPath, join(deployRoot, 'runtime', 'node-test', 'bin', 'node'));
  mkdirSync(join(deployRoot, 'runtime', 'node-mutated', 'bin'), { recursive: true });
  symlinkSync(process.execPath, join(deployRoot, 'runtime', 'node-mutated', 'bin', 'node'));
  symlinkSync('node-test', join(deployRoot, 'runtime', 'node'));
  mkdirSync(join(deployRoot, 'runtime', 'pnpm-10.17.1', 'bin'), { recursive: true });
  writeExecutable(join(deployRoot, 'runtime', 'pnpm-10.17.1', 'bin', 'pnpm'), pnpmScript(barrier, repositoryRootPath()));
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
  mkdirSync(join(serviceHome, '.local', 'share'), { recursive: true });
  mkdirSync(join(serviceHome, '.cache'), { recursive: true });
  writeExecutable(join(fakeBin, 'id'), '#!/bin/sh\nif [ "$1" = baox ] || { [ "$1" = -u ] && [ "$2" = baox ]; }; then exit 0; fi\nexec /usr/bin/id "$@"\n');
  writeExecutable(join(fakeBin, 'getent'), `#!/bin/sh\nif [ "$1" = passwd ] && [ "$2" = baox ]; then printf '%s\\n' ${shellQuote(`baox:x:998:998::${serviceHome}:/sbin/nologin`)}; exit 0; fi\nexit 2\n`);
  writeExecutable(join(fakeBin, 'stat'), '#!/bin/sh\n[ "$1" = -c ] || exit 2\ncase "$2" in\n  %a) /usr/bin/stat -f "%Lp" "$3" ;;\n  %u) printf "0\\n" ;;\n  *) exit 2 ;;\nesac\n');
  writeExecutable(join(fakeBin, 'chown'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(join(barrier, 'chown.log'))}\nexit 0\n`);
  writeExecutable(join(fakeBin, 'runuser'), '#!/bin/sh\n[ "$1" = -u ] || exit 2\nshift 2\n[ "$1" = -- ] && shift\nexec "$@"\n');

  const token = 'candidate-test-maintenance-token-0123456789';
  const tokenFile = join(deployRoot, 'etc', 'maintenance-gate.token');
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  const socket = join(dataDir, 'maintenance-gate.sock');
  const server = await startServer({ dataDir, port: 0, maintenanceToken: token, maintenanceSocketPath: socket });
  writeBlob(dataDir, Buffer.from('real original file\n'));
  writeExecutable(
    join(deployRoot, 'bin', 'baox-maintenance-gate'),
    maintenanceWrapperScript(
      join(deployRoot, 'runtime', 'node', 'bin', 'node'),
      socket,
      tokenFile,
      join(barrier, 'post-reopen-gate-status-failure'),
      join(barrier, 'next-admission-refused'),
      join(barrier, 'fail-proxy-verification'),
    ),
  );

  const runnerEnvironment: NodeJS.ProcessEnv = {};
  if (snapshotAvailableBytes !== undefined) {
    const preload = join(root, 'snapshot-statfs-preload.cjs');
    writeFileSync(preload, snapshotStatfsPreload());
    runnerEnvironment.NODE_OPTIONS = `--require=${preload}`;
    runnerEnvironment.BAOX_TEST_SNAPSHOT_AVAILABLE_BYTES = String(snapshotAvailableBytes);
  }
  const runner = new LocalTargetRunner(fakeBin, barrier, runnerEnvironment);
  const profile = {
    ...NATIVE_PROFILE,
    host: 'isolated.test',
    deployRoot,
    dataDir,
    serviceHome,
    systemdDir,
    buildEnvironment: join(deployRoot, 'etc', 'build.env'),
    buildPython: testPython,
    maintenanceWrapper: join(deployRoot, 'bin', 'baox-maintenance-gate'),
    maintenanceSocket: socket,
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
    async close() {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

let originalServerBuildReady = false;

/**
 * Reuses the candidate target layout but runs the original built server through
 * a controllable systemctl shim. The service and proxy are real child processes
 * over the target's SQLite/blob directory; only their supervisor is a test shim.
 */
export async function createSnapshotIsolatedTarget(options: IsolatedTargetOptions = {}): Promise<SnapshotIsolatedTarget> {
  ensureOriginalServerBuild();
  const base = await createIsolatedTarget(options);
  await base.server.close();

  const deployRoot = base.profile.deployRoot;
  const fakeBin = join(base.root, 'fake-bin');
  const systemdDir = base.profile.systemdDir;
  const tokenFile = join(deployRoot, 'etc', 'maintenance-gate.token');
  const servicePort = await freePort();
  const publicPort = await freePort();
  const publicHost = `127.0.0.1:${publicPort}`;
  const originalRelease = join(deployRoot, 'releases', 'active');
  const repositoryRoot = repositoryRootPath();
  rmSync(originalRelease, { recursive: true, force: true });
  symlinkSync(repositoryRoot, originalRelease);

  writeFileSync(join(systemdDir, 'baox.service'), [
    '[Service]',
    `ExecStart=${join(deployRoot, 'runtime', 'node', 'bin', 'node')} ${join(deployRoot, 'current', 'server', 'dist', 'main.mjs')}`,
    `Environment=BAOX_PUBLIC_ORIGIN=http://${publicHost}`,
    `Environment=BAOX_PORT=${servicePort}`,
    `Environment=BAOX_DATA_DIR=${base.dataDir}`,
    `Environment=BAOX_MAINTENANCE_TOKEN_FILE=${tokenFile}`,
    `Environment=BAOX_HOME=${join(base.root, 'no-legacy-import')}`,
    '',
  ].join('\n'));
  writeFileSync(join(deployRoot, 'etc', 'Caddyfile'), `http://${publicHost} {\n  reverse_proxy 127.0.0.1:${servicePort}\n}\n`);

  const proxy = join(base.root, 'proxy.mjs');
  writeFileSync(proxy, proxyScript());
  const mutationScript = join(base.root, 'candidate-mutation.cjs');
  writeFileSync(mutationScript, candidateMutationScript());
  const state = {
    servicePid: join(base.barrier, 'baox.pid'),
    proxyPid: join(base.barrier, 'caddy.pid'),
    commands: join(base.barrier, 'systemctl.log'),
    serviceLog: join(base.barrier, 'baox.log'),
    proxyLog: join(base.barrier, 'caddy.log'),
    failServiceStart: join(base.barrier, 'fail-baox-start'),
    failProxyStart: join(base.barrier, 'fail-proxy-start'),
    failProxyVerification: join(base.barrier, 'fail-proxy-verification'),
    loopbackProbeVerification: join(base.barrier, 'fail-loopback-proxy-probe'),
    admitRefusal: join(base.barrier, 'next-admission-refused'),
    loopbackProbeStarted: join(base.barrier, 'loopback-proxy-probe-started'),
  };
  writeExecutable(join(deployRoot, 'bin', 'caddy'), caddyProbeScript({
    node: join(deployRoot, 'runtime', 'node', 'bin', 'node'),
    proxy,
    servicePort,
    publicPort,
    publicHost,
    proxyVerificationFile: state.loopbackProbeVerification,
    probeStarted: state.loopbackProbeStarted,
  }));
  writeExecutable(join(fakeBin, 'systemctl'), systemctlScript({
    barrier: base.barrier,
    node: join(deployRoot, 'runtime', 'node', 'bin', 'node'),
    current: base.current,
    dataDir: base.dataDir,
    tokenFile,
    servicePort,
    publicPort,
    publicHost,
    proxy,
    runtimeRoot: join(deployRoot, 'runtime'),
    mutationScript,
    ...state,
  }));

  const run = (action: 'start' | 'stop' | 'restart', unit: 'baox.service' | 'baox-caddy.service'): void => {
    execFileSync(join(fakeBin, 'systemctl'), [action, unit], { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` } });
  };
  const serviceUrl = `http://127.0.0.1:${servicePort}`;
  const publicUrl = `http://127.0.0.1:${publicPort}`;
  const controller: ManagedServiceController = {
    serviceUrl,
    publicUrl,
    startService: () => run('start', 'baox.service'),
    stopService: () => run('stop', 'baox.service'),
    restartService: () => run('restart', 'baox.service'),
    startProxy: () => run('start', 'baox-caddy.service'),
    stopProxy: () => run('stop', 'baox-caddy.service'),
    restartProxy: () => run('restart', 'baox-caddy.service'),
    failNextStart: (service) => writeFileSync(service === 'baox' ? state.failServiceStart : state.failProxyStart, 'fail\n'),
    failLoopbackProbeVerification: () => writeFileSync(state.loopbackProbeVerification, 'once\n'),
    serveWrongLoopbackSession: () => writeFileSync(state.loopbackProbeVerification, 'wrong-session-until-reopen\n'),
    refuseNextAdmission: () => writeFileSync(state.admitRefusal, 'once\n'),
    commands: () => existsSync(state.commands) ? readFileSync(state.commands, 'utf8').trim().split('\n').filter(Boolean) : [],
    loopbackProbeStarts: () => existsSync(state.loopbackProbeStarted) ? readFileSync(state.loopbackProbeStarted, 'utf8').trim().split('\n').filter(Boolean).length : 0,
  };

  controller.startService();
  await waitForReachable(serviceUrl);
  controller.startProxy();
  await waitForReachable(publicUrl);
  return {
    ...base,
    controller,
    async close() {
      try { controller.stopProxy(); } catch {}
      try { controller.stopService(); } catch {}
      rmSync(base.root, { recursive: true, force: true });
    },
  };
}

function ensureOriginalServerBuild(): void {
  if (originalServerBuildReady) return;
  const serverRoot = join(repositoryRootPath(), 'server');
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: serverRoot, stdio: 'ignore' });
  originalServerBuildReady = true;
}

function repositoryRootPath(): string {
  return fileURLToPath(new URL('../../../../', import.meta.url));
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('unable to reserve test port'));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForReachable(url: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/session`);
      if (response.status < 500) return;
    } catch {
      // The child can take a short moment to bind after systemctl returns.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${url}`);
}

function systemctlScript(values: SystemctlValues): string {
  const quote = (value: string | number): string => shellQuote(String(value));
  return `#!/bin/sh
set -eu
action="${'$'}{1:-}"
unit="${'$'}{2:-}"
log=${quote(values.commands)}
barrier=${quote(values.barrier)}
printf '%s %s\\n' "${'$'}action" "${'$'}unit" >> "${'$'}log"
pid_file() {
  case "${'$'}1" in
    baox.service) printf %s ${quote(values.servicePid)} ;;
    baox-caddy.service) printf %s ${quote(values.proxyPid)} ;;
    *) exit 2 ;;
  esac
}
alive() { [ -f "${'$'}1" ] && kill -0 "$(cat "${'$'}1")" 2>/dev/null; }
stop_pid() {
  file="${'$'}1"
  if alive "${'$'}file"; then
    kill -TERM "$(cat "${'$'}file")" 2>/dev/null || true
    for _ in $(seq 1 200); do alive "${'$'}file" || break; sleep 0.025; done
    alive "${'$'}file" && kill -KILL "$(cat "${'$'}file")" 2>/dev/null || true
  fi
  rm -f "${'$'}file"
}
start_baox() {
  file=$(pid_file baox.service)
  alive "${'$'}file" && return 0
  rm -f "${'$'}file"
  if [ -f ${quote(values.failServiceStart)} ]; then rm -f ${quote(values.failServiceStart)}; exit 1; fi
  if [ -f ${quote(values.current)}/.baox-test-mutate-before-failure ]; then
    ${quote(values.node)} ${quote(values.mutationScript)} ${quote(values.dataDir)}
    cp ${quote(join(dirname(values.current), 'etc', 'Caddyfile'))} "${'$'}barrier/candidate-caddyfile-before-failure"
    touch "${'$'}barrier/candidate-mutation-applied"
  fi
  if [ -f ${quote(values.current)}/.baox-test-mutate-runtime-before-failure ]; then
    rm -f ${quote(join(values.runtimeRoot, 'node'))}
    ln -s node-mutated ${quote(join(values.runtimeRoot, 'node'))}
  fi
  if [ -f ${quote(values.current)}/.baox-test-fail-recovery-start ]; then
    touch ${quote(values.failServiceStart)}
    exit 1
  fi
  if [ -f ${quote(values.current)}/.baox-test-fail-start ]; then exit 1; fi
  BAOX_DATA_DIR=${quote(values.dataDir)} BAOX_PORT=${quote(values.servicePort)} BAOX_PUBLIC_ORIGIN=${quote(`http://${values.publicHost}`)} BAOX_MAINTENANCE_TOKEN_FILE=${quote(values.tokenFile)} BAOX_HOME=${quote(join(String(values.barrier), 'no-legacy-import'))} ${quote(values.node)} ${quote(join(String(values.current), 'server', 'dist', 'main.mjs'))} >>${quote(values.serviceLog)} 2>&1 &
  printf '%s\\n' "${'$'}!" > "${'$'}file"
}
start_proxy() {
  file=$(pid_file baox-caddy.service)
  alive "${'$'}file" && return 0
  rm -f "${'$'}file"
  if [ -f ${quote(values.failProxyStart)} ]; then rm -f ${quote(values.failProxyStart)}; exit 1; fi
  if [ -f ${quote(values.current)}/.baox-test-mutate-after-reopen ]; then
    ${quote(values.node)} ${quote(values.mutationScript)} ${quote(values.dataDir)} post-access ${quote(values.barrier)}
  fi
  BAOX_PROXY_PORT=${quote(values.publicPort)} BAOX_UPSTREAM_PORT=${quote(values.servicePort)} BAOX_PUBLIC_HOST=${quote(values.publicHost)} BAOX_PROXY_FAILURE_FILE=${quote(values.failProxyVerification)} ${quote(values.node)} ${quote(values.proxy)} >>${quote(values.proxyLog)} 2>&1 &
  printf '%s\\n' "${'$'}!" > "${'$'}file"
}
case "${'$'}action" in
  is-active)
    file=$(pid_file "${'$'}unit")
    if alive "${'$'}file"; then printf active; exit 0; fi
    printf inactive; exit 3 ;;
  start)
    case "${'$'}unit" in baox.service) start_baox ;; baox-caddy.service) start_proxy ;; *) exit 2 ;; esac ;;
  stop)
    case "${'$'}unit" in baox.service) touch "${'$'}barrier/snapshot-stop-started"; stop_pid "$(pid_file baox.service)" ;; baox-caddy.service) stop_pid "$(pid_file baox-caddy.service)" ;; *) exit 2 ;; esac ;;
  restart)
    "${'$'}0" stop "${'$'}unit"
    "${'$'}0" start "${'$'}unit" ;;
  daemon-reload|enable) exit 0 ;;
  *) exit 2 ;;
esac
`;
}

function caddyProbeScript(values: {
  node: string;
  proxy: string;
  servicePort: number;
  publicPort: number;
  publicHost: string;
  proxyVerificationFile: string;
  probeStarted: string;
}): string {
  const adapted = JSON.stringify({
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [`:${values.publicPort}`],
            routes: [{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: `127.0.0.1:${values.servicePort}` }] }] }],
          },
        },
      },
    },
  });
  return `#!/bin/sh
set -eu
case "${'$'}{1:-}" in
  version) printf 'v2.10.2\\n'; exit 0 ;;
  validate) exit 0 ;;
  adapt) printf '%s\\n' ${shellQuote(adapted)}; exit 0 ;;
  run) ;;
  *) exit 2 ;;
esac
shift
configuration=''
while [ "${'$'}#" -gt 0 ]; do
  case "${'$'}1" in
    --config) configuration="${'$'}2"; shift 2 ;;
    --adapter) exit 2 ;;
    *) shift ;;
  esac
done
[ -n "${'$'}configuration" ] || exit 2
port=$(${shellQuote(values.node)} - "${'$'}configuration" <<'NODE'
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const servers = config && config.apps && config.apps.http && config.apps.http.servers;
if (!config || !config.admin || config.admin.disabled !== true || !config.storage || config.storage.module !== 'file_system' || typeof config.storage.root !== 'string') process.exit(2);
if (!servers || Object.keys(config.apps).some((name) => name !== 'http')) process.exit(2);
const server = Object.values(servers)[0];
if (!server || !server.automatic_https || server.automatic_https.disable !== true) process.exit(2);
const listen = Array.isArray(server.listen) ? server.listen[0] : null;
const match = typeof listen === 'string' && /^127\\.0\\.0\\.1:(\\d+)$/.exec(listen);
if (!match) process.exit(2);
process.stdout.write(match[1]);
NODE
)
printf 'started\\n' >> ${shellQuote(values.probeStarted)}
exec env BAOX_PROXY_PORT="${'$'}port" BAOX_UPSTREAM_PORT=${shellQuote(String(values.servicePort))} BAOX_PUBLIC_HOST=${shellQuote(values.publicHost)} BAOX_PROXY_FAILURE_FILE=${shellQuote(values.proxyVerificationFile)} ${shellQuote(values.node)} ${shellQuote(values.proxy)}
`;
}

function proxyScript(): string {
  return `import http from 'node:http';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
const port = Number(process.env.BAOX_PROXY_PORT);
const upstreamPort = Number(process.env.BAOX_UPSTREAM_PORT);
const host = process.env.BAOX_PUBLIC_HOST;
const failure = process.env.BAOX_PROXY_FAILURE_FILE;
const server = http.createServer((request, response) => {
  if (failure && existsSync(failure)) {
    const mode = readFileSync(failure, 'utf8').trim();
    if (mode === 'once') unlinkSync(failure);
    if (mode === 'wrong-session-until-reopen') {
      response.statusCode = 404;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: { code: 'not_found' } }));
      return;
    }
    response.statusCode = 503;
    response.end('maintenance');
    return;
  }
  const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: request.url, method: request.method, headers: { ...request.headers, host } }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.once('error', () => { response.statusCode = 502; response.end('unavailable'); });
  request.pipe(upstream);
});
server.listen(port, '127.0.0.1');
process.once('SIGTERM', () => server.close(() => process.exit(0)));
`;
}

function candidateMutationScript(): string {
  const betterSqlite = join(repositoryRootPath(), 'server', 'node_modules', 'better-sqlite3');
  return `const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require(${JSON.stringify(betterSqlite)});
const dataDir = process.argv[2];
const mode = process.argv[3] || 'pre-access';
const barrier = process.argv[4] || null;
const database = new Database(path.join(dataDir, 'baox.sqlite'));
if (mode === 'post-access') {
  const gate = database.prepare("SELECT state FROM maintenance_gate WHERE gate_id = 'main'").get();
  if (!gate || gate.state !== 'open' || (barrier && fs.existsSync(path.join(barrier, 'post-reopen-mutation-applied')))) {
    database.close();
    process.exit(0);
  }
  database.exec('CREATE TABLE IF NOT EXISTS cutover_test_post_access_mutation (value TEXT NOT NULL)');
  database.prepare('INSERT INTO cutover_test_post_access_mutation (value) VALUES (?)').run('candidate-post-access-mutation');
} else {
  database.exec('CREATE TABLE cutover_test_mutation (value TEXT NOT NULL)');
  database.prepare('INSERT INTO cutover_test_mutation (value) VALUES (?)').run('candidate-pre-access-mutation');
}
database.close();
const bytes = Buffer.from(mode === 'post-access' ? 'candidate post-access blob mutation\\n' : 'candidate pre-access blob mutation\\n');
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
const directory = path.join(dataDir, 'files', 'sha256', digest.slice(0, 2));
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(directory, digest), bytes, { mode: 0o600 });
if (mode === 'post-access' && barrier) {
  fs.writeFileSync(path.join(barrier, 'post-reopen-mutation-applied'), 'applied\\n');
  fs.writeFileSync(path.join(barrier, 'post-reopen-gate-status-failure'), 'once\\n');
}
`;
}

function snapshotStatfsPreload(): string {
  return `const fs = require('node:fs/promises');
const original = fs.statfs.bind(fs);
fs.statfs = async (...args) => {
  const result = await original(...args);
  const available = Number(process.env.BAOX_TEST_SNAPSHOT_AVAILABLE_BYTES);
  if (!Number.isSafeInteger(available) || available < 0) return result;
  return { ...result, bavail: Math.floor(available / Number(result.bsize)) };
};
`;
}

function pnpmScript(barrier: string, candidateRuntimeSource: string): string {
  return `#!/bin/sh
native_fixture() {
  if [ ! -f ${shellQuote(join(barrier, 'force-native-sqlite'))} ]; then return; fi
  node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const original = path.dirname(require.resolve('better-sqlite3/package.json', { paths: [${JSON.stringify(join(candidateRuntimeSource, 'server'))}] }));
const modules = path.join(process.cwd(), 'server', 'node_modules');
fs.unlinkSync(modules);
fs.mkdirSync(modules);
const target = path.join(modules, 'better-sqlite3');
fs.cpSync(original, target, { recursive: true, dereference: true });
const prebuild = path.join(target, 'prebuilds', process.platform + '-' + process.arch + '.node');
const good = fs.readFileSync(prebuild);
fs.writeFileSync(path.join(target, 'fixture-native.node'), good);
fs.writeFileSync(prebuild, 'incompatible upstream native binary');
const gyp = path.resolve(process.cwd(), '../../..', 'runtime/pnpm-10.17.1/lib/node_modules/pnpm/dist/node_modules/node-gyp/bin/node-gyp.js');
fs.mkdirSync(path.dirname(gyp), { recursive: true });
fs.writeFileSync(gyp, "const fs=require('node:fs');fs.mkdirSync('build/Release',{recursive:true});fs.copyFileSync('fixture-native.node','build/Release/better_sqlite3.node');fs.writeFileSync('native-build-evidence.json',JSON.stringify({args:process.argv.slice(2),python:process.env.npm_config_python,compiler:process.env.CXX}));");
NODE
}
if [ "$1" = --version ]; then printf '10.17.1\\n'; exit 0; fi
if [ "$1" = install ]; then
  printf install >> '${join(barrier, 'counter')}'
  touch '${join(barrier, 'started')}'
  while [ -f '${join(barrier, 'hold')}' ]; do sleep 0.02; done
  if [ -f '${join(barrier, 'fence-old-worker')}' ]; then
    deploy_root=$(cd ../../.. && pwd)
    lock="$deploy_root/maintenance/deployment.lock"
    claim="$lock.test-claim-$$"
    candidate=$(basename "$(dirname "$PWD")")
    if [ -r "/proc/$$/stat" ]; then
      start=$(awk '{print $22}' "/proc/$$/stat")
      identity="linux:$start"
    else
      identity="nonlinux:$$"
    fi
    mv "$lock" "$claim"
    mkdir "$lock"
    printf '{"schema":1,"operation":"candidate-prepare","candidateId":"%s","pid":%s,"startIdentity":"%s","token":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","createdAt":"test"}\n' "$candidate" "$$" "$identity" > "$lock/owner.json"
    rm -rf "$claim"
    node - "$deploy_root/maintenance/deployment-journal.json" <<'NODE'
const fs = require('node:fs');
const [journal] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(journal, 'utf8'));
value.phase = 'recovery-required';
value.failure = 'test-successor-owns-lock';
fs.writeFileSync(journal, JSON.stringify(value, null, 2) + '\\n');
NODE
  fi
  exit 0
fi
if [ "$1" = build ]; then
  if [ -f .baox-test-use-real-server ]; then
    rm -rf server/dist web/dist extension/dist server/node_modules
    mkdir -p server web/dist extension/dist
    cp -R ${shellQuote(join(candidateRuntimeSource, 'server', 'dist'))} server/dist
    ln -s ${shellQuote(join(candidateRuntimeSource, 'server', 'node_modules'))} server/node_modules
    native_fixture
    printf '<html>candidate</html>' > web/dist/index.html
    printf '{"manifest_version":3}' > extension/dist/manifest.json
    exit 0
  fi
  mkdir -p server/dist web/dist extension/dist
  ln -s ${shellQuote(join(candidateRuntimeSource, 'server', 'node_modules'))} server/node_modules
  native_fixture
  printf 'main' > server/dist/main.mjs
  printf 'cli' > server/dist/baox.mjs
  printf '<html></html>' > web/dist/index.html
  printf '{"manifest_version":3}' > extension/dist/manifest.json
  exit 0
fi
exit 2
`;
}

function maintenanceWrapperScript(
  node: string,
  socket: string,
  tokenFile: string,
  statusFailureFile: string,
  admissionRefusalFile: string,
  proxyVerificationFile: string,
): string {
  return `#!/bin/sh
set -eu
case "${'$'}{1:-}" in status|admit|reopen) ;; *) exit 64;; esac
[ "${'$'}#" -eq 1 ] || exit 64
if [ "${'$'}1" = status ] && [ -f ${shellQuote(statusFailureFile)} ]; then rm -f ${shellQuote(statusFailureFile)}; exit 69; fi
if [ "${'$'}1" = admit ] && [ -f ${shellQuote(admissionRefusalFile)} ]; then
  rm -f ${shellQuote(admissionRefusalFile)}
  printf '%s\\n' '{"version":1,"state":"refused","barrier":false,"activeWrites":0,"activeErpAttempt":true,"reason":"active_erp_attempt"}'
  exit 0
fi
if [ "${'$'}1" = reopen ] && [ -f ${shellQuote(proxyVerificationFile)} ] && [ "$(cat ${shellQuote(proxyVerificationFile)})" = wrong-session-until-reopen ]; then
  rm -f ${shellQuote(proxyVerificationFile)}
fi
exec ${shellQuote(node)} - "${'$'}1" ${shellQuote(socket)} ${shellQuote(tokenFile)} <<'NODE'
const fs = require('node:fs');
const net = require('node:net');
const [command, socketPath, tokenPath] = process.argv.slice(2);
let token;
try { token = fs.readFileSync(tokenPath, 'utf8').trim(); } catch { process.exit(69); }
if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) process.exit(65);
const client = net.createConnection(socketPath);
let buffer = '';
const fail = (code) => { client.destroy(); process.exit(code); };
client.setTimeout(5000, () => fail(69));
client.once('error', () => fail(69));
client.on('connect', () => client.write(JSON.stringify({ version: 1, command, token }) + '\\n'));
client.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  const newline = buffer.indexOf('\\n');
  if (newline < 0 || Buffer.byteLength(buffer) > 4096) return;
  let response;
  try { response = JSON.parse(buffer.slice(0, newline)); } catch { fail(65); return; }
  process.stdout.write(JSON.stringify(response) + '\\n');
  client.end();
});
client.once('end', () => process.exit(0));
NODE
`;
}

function writeExecutable(file: string, content: string): void {
  writeFileSync(file, content, { mode: 0o755 });
  chmodSync(file, 0o755);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
