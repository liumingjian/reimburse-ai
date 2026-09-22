import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
};

/**
 * Runs the production target driver against a temporary host layout. The baox
 * server, SQLite database, blob files, maintenance socket, and control token
 * are real; only operating-system build commands are narrow test shims.
 */
export class LocalTargetRunner {
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

export async function createIsolatedTarget({ holdBuild = false, buildEnvironment = true, fenceOldWorker = false }: IsolatedTargetOptions = {}): Promise<IsolatedTarget> {
  const root = mkdtempSync(join(tmpdir(), 'baox-candidate-target-'));
  const deployRoot = join(root, 'deploy');
  const dataDir = join(deployRoot, 'data');
  const systemdDir = join(root, 'systemd');
  const fakeBin = join(root, 'fake-bin');
  const barrier = join(root, 'barrier');
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(barrier, { recursive: true });
  if (holdBuild) writeFileSync(join(barrier, 'hold'), 'hold\n');
  if (fenceOldWorker) writeFileSync(join(barrier, 'fence-old-worker'), 'enabled\n');

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

  const token = 'candidate-test-maintenance-token-0123456789';
  const tokenFile = join(deployRoot, 'etc', 'maintenance-gate.token');
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  const socket = join(dataDir, 'maintenance-gate.sock');
  const server = await startServer({ dataDir, port: 0, maintenanceToken: token, maintenanceSocketPath: socket });
  writeBlob(dataDir, Buffer.from('real original file\n'));
  writeExecutable(join(deployRoot, 'bin', 'baox-maintenance-gate'), maintenanceWrapperScript(join(deployRoot, 'runtime', 'node', 'bin', 'node'), socket, tokenFile));

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

function pnpmScript(barrier: string): string {
  return `#!/bin/sh
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

function maintenanceWrapperScript(node: string, socket: string, tokenFile: string): string {
  return `#!/bin/sh
set -eu
case "${'$'}{1:-}" in status|admit|reopen) ;; *) exit 64;; esac
[ "${'$'}#" -eq 1 ] || exit 64
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
