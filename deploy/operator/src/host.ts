import { spawn } from 'node:child_process';
import { NATIVE_PROFILE, type NativeProfile } from './profile.js';

export type HostCommand =
  | { kind: 'status' }
  | { kind: 'doctor' }
  | { kind: 'logs'; lines: number }
  | { kind: 'gate-status' };

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
  maintenanceWrapper: 'present' | 'missing' | 'unknown';
};

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
  | { kind: 'gate-status'; value: GateStatus };

export interface HostTransport {
  execute(command: HostCommand): Promise<HostResult>;
}

export type SshResult = { stdout: string; exitCode: number | null };

export type SshRunner = (profile: NativeProfile, remoteCommand: string) => Promise<SshResult>;

export type SshHostTransportOptions = {
  runner?: SshRunner;
  profile?: NativeProfile;
};

export class SshHostTransport implements HostTransport {
  private readonly runner: SshRunner;
  private readonly profile: NativeProfile;

  constructor(options: SshHostTransportOptions = {}) {
    this.runner = options.runner ?? runSsh;
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
    }
  }

  private async requireSuccess(script: string, label: string): Promise<SshResult> {
    const result = await this.runner(this.profile, remoteShellCommand(script));
    if (result.exitCode !== 0) throw new Error(`${label}无法完成。SSH 命令退出码为 ${result.exitCode ?? '未知'}。`);
    return result;
  }

  private async gateStatus(): Promise<GateStatus> {
    const result = await this.runner(this.profile, remoteShellCommand(`${this.profile.maintenanceWrapper} status`));
    if (result.exitCode === 69 || result.exitCode === 127) return { kind: 'missing-gate' };
    if (result.exitCode === 65) return { kind: 'incompatible-gate' };
    if (result.exitCode !== 0) return { kind: 'unavailable-gate' };

    return parseGateStatus(result.stdout);
  }
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
printf 'node_version='
${profile.deployRoot}/runtime/node/bin/node --version 2>/dev/null || true
printf '\\n'
printf 'gcc_version='
LD_LIBRARY_PATH=${profile.deployRoot}/runtime/gcc-12.5.0/lib64 ${profile.deployRoot}/runtime/gcc-12.5.0/bin/g++ -dumpfullversion -dumpversion 2>/dev/null || true
printf '\\n'
printf 'build_python='
/home/baox/.local/share/baox-build-venv/bin/python --version 2>/dev/null || true
printf '\\n'
printf 'maintenance_wrapper='
if [ -x ${profile.maintenanceWrapper} ]; then printf present; else printf missing; fi
printf '\\n'
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
  return {
    nodeVersion: values['node_version'] || null,
    gccVersion: values['gcc_version'] || null,
    buildPython: values['build_python'] || null,
    maintenanceWrapper: wrapper === 'present' || wrapper === 'missing' ? wrapper : 'unknown',
  };
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

function runSsh(profile: NativeProfile, remoteCommand: string): Promise<SshResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      `${profile.sshUser}@${profile.host}`,
      remoteCommand,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ stdout: Buffer.concat(stdout).toString('utf8'), exitCode }));
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
