import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import {
  BOOTSTRAP_ARTIFACTS,
  bootstrapArtifactDirectory,
  bootstrapArtifactForName,
  bootstrapArtifactName,
  bootstrapScript,
  parseBootstrapResponse,
  validateBootstrapProxy,
  type BootstrapArtifacts,
  type BootstrapResponse,
  type BootstrapSource,
  type LocalBootstrapArtifact,
} from './bootstrap.js';
import { createCoordinatorInvocation, readCoordinatorSource } from './coordinator-transport.js';
import { NATIVE_PROFILE, type NativeProfile } from './profile.js';

export type HostCommand =
  | { kind: 'status' }
  | { kind: 'doctor' }
  | { kind: 'logs'; lines: number }
  | { kind: 'gate-status' }
  | { kind: 'bootstrap-preview'; source: BootstrapSource }
  | { kind: 'bootstrap-apply'; source: BootstrapSource; confirmationDigest: string };

export type HostStatus = {
  currentRelease: string | null;
  baoxService: string;
  caddyService: string;
  dataDirectory: 'present' | 'missing' | 'unknown';
  availableKib: number | null;
};

export type DoctorReport = {
  nodeVersion: string | null;
  gccVersion: string | null;
  buildPython: string | null;
  pnpmVersion: string | null;
  caddyVersion: string | null;
  serviceAccount: 'ready' | 'missing' | 'mismatched' | 'unknown';
  maintenanceWrapper: 'present' | 'missing' | 'unknown';
  issues: readonly DoctorIssue[];
};

export type DoctorIssue = Readonly<{
  code: string;
  message: string;
}>;

export type GateState = 'open' | 'admitting' | 'admitted' | 'refused' | 'unknown';

export type GateResponse = {
  version: 1;
  state: GateState;
  barrier: boolean;
  activeWrites: number | 'unknown';
  activeErpAttempt: boolean | 'unknown';
  reason?: string;
};

export type GateStatus =
  | { kind: 'available'; response: GateResponse }
  | { kind: 'missing-gate' }
  | { kind: 'incompatible-gate' }
  | { kind: 'unavailable-gate' };

export type HostResult =
  | { kind: 'status'; value: HostStatus }
  | { kind: 'doctor'; value: DoctorReport }
  | { kind: 'logs'; value: string }
  | { kind: 'gate-status'; value: GateStatus }
  | { kind: 'bootstrap-preview'; value: BootstrapResponse }
  | { kind: 'bootstrap-apply'; value: BootstrapResponse };

export type TargetArtifactHandle = Readonly<{
  fileName: string;
  sha256: string;
}>;

export interface HostTransport {
  execute(command: HostCommand): Promise<HostResult>;
  uploadArtifact(artifact: LocalBootstrapArtifact): Promise<TargetArtifactHandle>;
}

export type SshResult = { stdout: string; exitCode: number | null };

/**
 * The optional input stream lets a target driver send an immutable local artifact
 * through the fixed SSH profile. Production callers never expose this as a CLI
 * target override; tests use it to run the same driver against an isolated host.
 */
export type SshRunner = (profile: NativeProfile, remoteCommand: string, input?: Readable) => Promise<SshResult>;

export type ArtifactUploader = (profile: NativeProfile, localPath: string, targetPath: string) => Promise<void>;

export type SshHostTransportOptions = {
  runner?: SshRunner;
  artifactUploader?: ArtifactUploader;
  bootstrapArtifacts?: BootstrapArtifacts;
  profile?: NativeProfile;
};

export class SshHostTransport implements HostTransport {
  private readonly runner: SshRunner;
  private readonly artifactUploader: ArtifactUploader;
  private readonly bootstrapArtifacts: BootstrapArtifacts;
  private readonly profile: NativeProfile;

  constructor(options: SshHostTransportOptions = {}) {
    this.runner = options.runner ?? productionSshRunner;
    this.artifactUploader = options.artifactUploader ?? uploadWithScp;
    this.bootstrapArtifacts = options.bootstrapArtifacts ?? BOOTSTRAP_ARTIFACTS;
    this.profile = options.profile ?? NATIVE_PROFILE;
  }

  async execute(command: HostCommand): Promise<HostResult> {
    switch (command.kind) {
      case 'status':
        return { kind: 'status', value: parseStatus(await this.requireSuccess(statusScript(this.profile), '状态检查')) };
      case 'doctor':
        return { kind: 'doctor', value: parseDoctor(await this.requireSuccess(doctorScript(this.profile), '诊断检查')) };
      case 'logs':
        return { kind: 'logs', value: (await this.requireSuccess(logScript(command.lines), '日志收集')).stdout };
      case 'gate-status':
        return { kind: 'gate-status', value: await this.gateStatus() };
      case 'bootstrap-preview':
        return { kind: 'bootstrap-preview', value: await this.bootstrap({ mode: 'preview', source: command.source }) };
      case 'bootstrap-apply':
        return {
          kind: 'bootstrap-apply',
          value: await this.bootstrap({ mode: 'apply', source: command.source, confirmationDigest: command.confirmationDigest }),
        };
    }
  }

  async uploadArtifact(artifact: LocalBootstrapArtifact): Promise<TargetArtifactHandle> {
    const fileName = bootstrapArtifactName(artifact.fileName);
    const expected = bootstrapArtifactForName(fileName, this.bootstrapArtifacts);
    if (!expected || artifact.sha256 !== expected.sha256) throw new Error(`不允许上传未固定的 bootstrap 工件：${fileName}。`);
    if (await sha256File(artifact.localPath) !== artifact.sha256) throw new Error(`本机 bootstrap 工件校验失败：${fileName}。`);

    const directory = bootstrapArtifactDirectory(this.profile);
    const targetPath = `${directory}/${artifact.sha256}`;
    await this.requireSuccess(`install -d -o root -g root -m 0700 ${shellQuote(directory)}`, 'bootstrap 工件目录准备');
    await this.artifactUploader(this.profile, artifact.localPath, targetPath);
    await this.requireSuccess(
      `printf '%s  %s\\n' ${shellQuote(artifact.sha256)} ${shellQuote(targetPath)} | sha256sum --strict --check --status -`,
      `bootstrap 工件主机校验 (${fileName})`,
    );
    return { fileName, sha256: artifact.sha256 };
  }

  private async requireSuccess(script: string, label: string): Promise<SshResult> {
    const result = await this.runner(this.profile, remoteShellCommand(script));
    if (result.exitCode !== 0) throw new Error(`${label}无法完成。SSH 命令退出码为 ${result.exitCode ?? '未知'}。`);
    return result;
  }

  private async gateStatus(): Promise<GateStatus> {
    const result = await this.runner(this.profile, remoteShellCommand(`${this.profile.maintenanceWrapper} status`));
    if (result.exitCode === 127) return { kind: 'missing-gate' };
    if (result.exitCode === 69) return { kind: 'unavailable-gate' };
    if (result.exitCode === 65) return { kind: 'incompatible-gate' };
    if (result.exitCode !== 0) return { kind: 'unavailable-gate' };

    return parseGateStatus(result.stdout);
  }

  private async bootstrap(request: Readonly<{ mode: 'preview' | 'apply'; source: BootstrapSource; confirmationDigest?: string }>): Promise<BootstrapResponse> {
    validateBootstrapProxy(request.source.proxy);
    if (request.mode === 'preview') return this.runBootstrapScript(request);

    // Recalculate the reviewed transaction before acquiring the mutable target
    // lease. A preview has no coordinator side effects.
    const preview = await this.runBootstrapScript({ mode: 'preview', source: request.source });
    if (preview.state !== 'preview') return preview;
    if (preview.plan.transactionDigest !== request.confirmationDigest) {
      return {
        version: 1,
        state: 'confirmation-mismatch',
        plan: preview.plan,
        reason: '当前包事务与已审阅的 preview 不一致。',
      };
    }

    const invocation = createCoordinatorInvocation({
      nodePath: `${this.profile.deployRoot}/runtime/node/bin/node`,
      mode: 'external-bootstrap',
      coordinatorSource: readCoordinatorSource(),
      request: {
        schema: 1,
        externalLock: true,
        operation: 'bootstrap',
        candidateId: 'native-bootstrap',
        deployRoot: this.profile.deployRoot,
        serviceHome: this.profile.serviceHome,
        systemdDir: this.profile.systemdDir,
        buildEnvironment: this.profile.buildEnvironment,
        buildPython: this.profile.buildPython,
        bootstrapScript: bootstrapScript(this.profile, request, this.bootstrapArtifacts),
      },
    });
    const result = await this.runner(this.profile, invocation.remoteCommand, invocation.input);
    let response: BootstrapResponse | undefined;
    try {
      response = parseBootstrapResponse(result.stdout);
    } catch {
      // An unexpected target failure is reported with the SSH status below.
    }
    if (response) return response;
    const lockRefusal = parseBootstrapLockRefusal(result.stdout, preview.plan);
    if (lockRefusal) return lockRefusal;
    throw new Error(`bootstrap 无法完成。SSH 命令退出码为 ${result.exitCode ?? '未知'}。`);
  }

  private async runBootstrapScript(request: Readonly<{ mode: 'preview' | 'apply'; source: BootstrapSource; confirmationDigest?: string }>): Promise<BootstrapResponse> {
    const result = await this.runner(this.profile, remoteShellCommand(bootstrapScript(this.profile, request, this.bootstrapArtifacts)));
    let response: BootstrapResponse | undefined;
    try {
      response = parseBootstrapResponse(result.stdout);
    } catch {
      // An unexpected target failure is reported with the SSH status below.
    }
    if (response) return response;
    throw new Error(`bootstrap 无法完成。SSH 命令退出码为 ${result.exitCode ?? '未知'}。`);
  }
}

function parseBootstrapLockRefusal(output: string, plan: BootstrapResponse['plan']): BootstrapResponse | undefined {
  for (const line of output.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean).reverse()) {
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object') continue;
      const record = value as Record<string, unknown>;
      if (record.state === 'busy' && typeof record.operation === 'string' && typeof record.candidateId === 'string') {
        return {
          version: 1,
          state: 'prerequisite-refused',
          plan,
          reason: `共享部署锁正由 ${record.operation} (${record.candidateId}) 持有。`,
        };
      }
      if (record.state === 'reconcile-needed' && typeof record.code === 'string') {
        return {
          version: 1,
          state: 'prerequisite-refused',
          plan,
          reason: `共享部署锁需要恢复：${record.code}。`,
        };
      }
    } catch {
      // Child tool output may precede the coordinator result.
    }
  }
  return undefined;
}

function statusScript(profile: NativeProfile): string {
  return `
set -u
service_state() { systemctl is-active "$1" 2>/dev/null || true; }
printf 'current_release='
readlink -f ${profile.deployRoot}/current 2>/dev/null || true
printf '\\n'
printf 'baox_service='
service_state baox.service
printf '\\n'
printf 'caddy_service='
service_state baox-caddy.service
printf '\\n'
printf 'data_directory='
if [ -d ${profile.dataDir} ]; then printf present; else printf missing; fi
printf '\\n'
printf 'available_kib='
df -Pk ${profile.dataDir} 2>/dev/null | awk 'NR == 2 { print $4 }' || true
printf '\\n'
`;
}

function doctorScript(profile: NativeProfile): string {
  return `
set -u
issues=''
SERVICE_HOME=${shellQuote(profile.serviceHome)}
BUILD_ENV=${shellQuote(profile.buildEnvironment)}
GCC_LIBDIR=${shellQuote(`${profile.deployRoot}/runtime/gcc-12.5.0/lib64`)}
append_issue() {
  if [ -z "$issues" ]; then issues=$1; else issues="$issues,$1"; fi
}
valid_build_value() {
  key=$1
  value=$2
  python3 - "$key" "$value" <<'PY'
import sys
from urllib.parse import urlsplit

key, value = sys.argv[1:]
if not value or any(character.isspace() for character in value) or '@' in value:
    raise SystemExit(1)
if key == 'NO_PROXY':
    raise SystemExit(0 if value == '127.0.0.1,localhost' else 1)
try:
    parsed = urlsplit(value)
    _ = parsed.port
except ValueError:
    raise SystemExit(1)
if parsed.username or parsed.password or not parsed.hostname:
    raise SystemExit(1)
if key in {'HTTP_PROXY', 'HTTPS_PROXY'}:
    raise SystemExit(0 if parsed.scheme in {'http', 'https'} else 1)
if key in {'npm_config_registry', 'NODE_MIRROR', 'CADDY_DOWNLOAD'}:
    raise SystemExit(0 if parsed.scheme == 'https' else 1)
raise SystemExit(1)
PY
}
validate_build_environment() {
  build_environment_ready=0
  BUILD_HTTP_PROXY=''
  BUILD_HTTPS_PROXY=''
  BUILD_NO_PROXY=''
  if [ ! -f "$BUILD_ENV" ]; then append_issue missing-build-environment; return; fi
  mode=$(stat -c '%a' "$BUILD_ENV" 2>/dev/null || true)
  [ "$mode" = 600 ] || { append_issue invalid-build-environment-permissions; return; }
  owner=$(stat -c '%u' "$BUILD_ENV" 2>/dev/null || true)
  [ "$owner" = 0 ] || { append_issue invalid-build-environment-owner; return; }
  seen=' '
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    case "$line" in *=*) ;; *) append_issue invalid-build-environment; return ;; esac
    key=${'$'}{line%%=*}
    value=${'$'}{line#*=}
    case " $seen" in *" $key "*) append_issue invalid-build-environment; return ;; esac
    valid_build_value "$key" "$value" || { append_issue invalid-build-environment; return; }
    seen="$seen$key "
    case "$key" in
      HTTP_PROXY) BUILD_HTTP_PROXY=$value ;;
      HTTPS_PROXY) BUILD_HTTPS_PROXY=$value ;;
      NO_PROXY) BUILD_NO_PROXY=$value ;;
    esac
  done < "$BUILD_ENV"
  [ -n "$BUILD_HTTP_PROXY" ] && [ -n "$BUILD_HTTPS_PROXY" ] && [ -n "$BUILD_NO_PROXY" ] || { append_issue missing-build-environment-value; return; }
  build_environment_ready=1
}
service_account=unknown
if ! id -u baox >/dev/null 2>&1; then
  service_account=missing
elif ! command -v getent >/dev/null 2>&1; then
  service_account=unknown
else
  account_entry=$(getent passwd baox 2>/dev/null || true)
  if [ -z "$account_entry" ]; then
    service_account=unknown
  else
    account_home=$(printf '%s\n' "$account_entry" | awk -F: '{print $6}')
    if [ "$account_home" = "$SERVICE_HOME" ]; then service_account=ready; else service_account=mismatched; fi
  fi
fi
validate_build_environment
as_baox() {
  runuser -u baox -- env -i \
    HOME="$SERVICE_HOME" \
    PATH="$SERVICE_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
    HTTP_PROXY="$BUILD_HTTP_PROXY" \
    HTTPS_PROXY="$BUILD_HTTPS_PROXY" \
    NO_PROXY="$BUILD_NO_PROXY" \
    LD_LIBRARY_PATH="$GCC_LIBDIR" \
    /bin/sh -c 'cd "$HOME" && exec "$@"' sh "$@"
}
node_version=''
gcc_version=''
build_python=''
pnpm_version=''
caddy_version=''
pnpm_bin=$(find ${shellQuote(`${profile.deployRoot}/runtime`)} -type f -path '*/bin/pnpm' -print -quit 2>/dev/null || true)
if [ "$service_account" = ready ] && [ "$build_environment_ready" = 1 ]; then
  node_version=$(as_baox ${shellQuote(`${profile.deployRoot}/runtime/node/bin/node`)} --version 2>/dev/null || true)
  gcc_version=$(as_baox ${shellQuote(`${profile.deployRoot}/runtime/gcc-12.5.0/bin/g++`)} -dumpfullversion -dumpversion 2>/dev/null || true)
  build_python=$(as_baox ${shellQuote(profile.buildPython)} --version 2>/dev/null || true)
  if [ -n "$pnpm_bin" ]; then pnpm_version=$(as_baox "$pnpm_bin" --version 2>/dev/null || true); fi
  caddy_version=$(as_baox ${shellQuote(`${profile.deployRoot}/bin/caddy`)} version 2>/dev/null | awk '{print $1}' || true)
fi
printf 'node_version=%s\\n' "$node_version"
printf 'gcc_version=%s\\n' "$gcc_version"
printf 'build_python=%s\\n' "$build_python"
printf 'pnpm_version=%s\\n' "$pnpm_version"
printf 'caddy_version=%s\\n' "$caddy_version"
printf 'service_account=%s\\n' "$service_account"
printf '\\n'
printf 'maintenance_wrapper='
if [ -x ${profile.maintenanceWrapper} ]; then printf present; else printf missing; fi
printf '\\n'
if [ ! -x ${shellQuote(`${profile.deployRoot}/runtime/node/bin/node`)} ]; then append_issue missing-node-runtime; elif [ "$service_account" = ready ] && [ "$build_environment_ready" = 1 ] && [ -z "$node_version" ]; then append_issue unusable-node-runtime; fi
if [ ! -x ${shellQuote(`${profile.deployRoot}/runtime/gcc-12.5.0/bin/g++`)} ]; then append_issue missing-gcc-runtime; elif [ "$service_account" = ready ] && [ "$build_environment_ready" = 1 ] && [ -z "$gcc_version" ]; then append_issue unusable-gcc-runtime; fi
if [ ! -x ${shellQuote(profile.buildPython)} ]; then append_issue missing-build-python; elif [ "$service_account" = ready ] && [ "$build_environment_ready" = 1 ] && [ -z "$build_python" ]; then append_issue unusable-build-python; fi
if [ -z "$pnpm_bin" ]; then append_issue missing-pnpm-runtime; elif [ "$service_account" = ready ] && [ "$build_environment_ready" = 1 ] && [ -z "$pnpm_version" ]; then append_issue unusable-pnpm-runtime; fi
if [ ! -x ${shellQuote(`${profile.deployRoot}/bin/caddy`)} ]; then append_issue missing-caddy-runtime; elif [ "$service_account" = ready ] && [ "$build_environment_ready" = 1 ] && [ -z "$caddy_version" ]; then append_issue unusable-caddy-runtime; fi
if [ "$service_account" = missing ]; then append_issue missing-service-account; fi
if [ "$service_account" = mismatched ]; then append_issue service-account-home-mismatch; fi
if [ "$service_account" = unknown ]; then append_issue service-account-home-unverified; fi
printf 'issues=%s\\n' "$issues"
`;
}

function logScript(lines: number): string {
  return `journalctl --no-pager --output=short-iso --lines=${lines} --unit=baox.service --unit=baox-caddy.service`;
}

function parseStatus(result: SshResult): HostStatus {
  const values = keyValue(result.stdout);
  const available = values['available_kib'] ?? '';
  const availableKib = /^\d+$/.test(available) ? Number.parseInt(available, 10) : null;
  const dataDirectory = values['data_directory'];
  return {
    currentRelease: values['current_release'] || null,
    baoxService: values['baox_service'] || 'unknown',
    caddyService: values['caddy_service'] || 'unknown',
    dataDirectory: dataDirectory === 'present' || dataDirectory === 'missing' ? dataDirectory : 'unknown',
    availableKib,
  };
}

function parseDoctor(result: SshResult): DoctorReport {
  const values = keyValue(result.stdout);
  const wrapper = values['maintenance_wrapper'];
  const serviceAccount = values['service_account'];
  return {
    nodeVersion: values['node_version'] || null,
    gccVersion: values['gcc_version'] || null,
    buildPython: values['build_python'] || null,
    pnpmVersion: values['pnpm_version'] || null,
    caddyVersion: values['caddy_version'] || null,
    serviceAccount: serviceAccount === 'ready' || serviceAccount === 'missing' || serviceAccount === 'mismatched' ? serviceAccount : 'unknown',
    maintenanceWrapper: wrapper === 'present' || wrapper === 'missing' ? wrapper : 'unknown',
    issues: parseDoctorIssues(values['issues']),
  };
}

function parseDoctorIssues(value: string | undefined): readonly DoctorIssue[] {
  if (!value) return [];
  return value.split(',').filter(Boolean).map((code) => ({ code, message: doctorIssueMessage(code) }));
}

function doctorIssueMessage(code: string): string {
  const messages: Readonly<Record<string, string>> = {
    'missing-node-runtime': '缺少 baox 专用 Node 运行时。',
    'unusable-node-runtime': 'baox 服务账号无法运行 Node 运行时。',
    'missing-gcc-runtime': '缺少隔离 GCC 运行时。请先执行 bootstrap。',
    'unusable-gcc-runtime': 'baox 服务账号无法运行隔离 GCC。',
    'missing-build-python': '缺少 baox 构建 Python 虚拟环境。请先执行 bootstrap。',
    'unusable-build-python': 'baox 服务账号无法运行构建 Python。',
    'missing-pnpm-runtime': '缺少 baox 专用 pnpm。',
    'unusable-pnpm-runtime': 'baox 服务账号无法运行 pnpm。',
    'missing-caddy-runtime': '缺少 baox 专用 Caddy。',
    'unusable-caddy-runtime': 'baox 服务账号无法运行 Caddy。',
    'missing-service-account': '缺少 baox 服务账号。请先执行 bootstrap。',
    'service-account-home-mismatch': 'baox 服务账号 home 与受控布局不一致。',
    'service-account-home-unverified': '无法验证 baox 服务账号 home。',
    'missing-build-environment': '缺少受控构建环境。请先执行 bootstrap。',
    'invalid-build-environment-permissions': '受控构建环境权限必须是 root 所有的 0600。',
    'invalid-build-environment-owner': '受控构建环境必须由 root 所有。',
    'invalid-build-environment': '受控构建环境的键或值不符合受控格式。',
    'missing-build-environment-value': '受控构建环境缺少必需代理值。',
  };
  return messages[code] ?? `主机报告了未知的准备条件问题：${code}。`;
}

function keyValue(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/u)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  return values;
}

function parseGateStatus(output: string): GateStatus {
  try {
    const parsed: unknown = JSON.parse(output.trim());
    if (!isGateResponse(parsed)) return { kind: 'incompatible-gate' };
    return { kind: 'available', response: parsed };
  } catch {
    return { kind: 'incompatible-gate' };
  }
}

function isGateResponse(value: unknown): value is GateResponse {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const states: readonly GateState[] = ['open', 'admitting', 'admitted', 'refused', 'unknown'];
  return record['version'] === 1
    && typeof record['state'] === 'string'
    && states.includes(record['state'] as GateState)
    && typeof record['barrier'] === 'boolean'
    && (isWriteCount(record['activeWrites']) || record['activeWrites'] === 'unknown')
    && (typeof record['activeErpAttempt'] === 'boolean' || record['activeErpAttempt'] === 'unknown')
    && (record['reason'] === undefined || record['reason'] === null || typeof record['reason'] === 'string');
}

function isWriteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function remoteShellCommand(script: string): string {
  return `sh -c ${shellQuote(script)}`;
}

export function productionSshRunner(profile: NativeProfile, remoteCommand: string, input?: Readable): Promise<SshResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      `${profile.sshUser}@${profile.host}`,
      remoteCommand,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ stdout: Buffer.concat(stdout).toString('utf8'), exitCode }));
    // A target may finish before consuming an archive when its deployment lock is
    // held. EPIPE is expected in that case; the SSH exit status remains decisive.
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    if (input) {
      input.on('error', reject);
      input.pipe(child.stdin);
    } else {
      child.stdin.end();
    }
  });
}

function uploadWithScp(profile: NativeProfile, localPath: string, targetPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('scp', [
      '-q',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      localPath,
      `${profile.sshUser}@${profile.host}:${targetPath}`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `scp exited ${exitCode ?? 'without a status'}`));
    });
  });
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
