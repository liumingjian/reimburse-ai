import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { productionSshRunner, remoteShellCommand, type SshRunner } from './host.js';
import { NATIVE_PROFILE, type NativeProfile } from './profile.js';

export type SnapshotRequest = Readonly<{
  candidateId: string;
  snapshotId?: string;
  retention?: number;
}>;

export type SnapshotResult =
  | { state: 'verified'; snapshotId: string; manifest: string; completion: 'reopen' }
  | { state: 'busy'; operation: string; candidateId: string }
  | { state: 'refused'; code: string }
  | { state: 'failed'; code: string; recoveryRequired?: boolean }
  | { state: 'reconcile-needed'; code: string };

export interface SnapshotTransport {
  snapshot(request: SnapshotRequest): Promise<SnapshotResult>;
}

export type SshSnapshotTransportOptions = {
  runner?: SshRunner;
  profile?: NativeProfile;
};

export class SshSnapshotTransport implements SnapshotTransport {
  private readonly runner: SshRunner;
  private readonly profile: NativeProfile;

  constructor(options: SshSnapshotTransportOptions = {}) {
    this.runner = options.runner ?? productionSshRunner;
    this.profile = options.profile ?? NATIVE_PROFILE;
  }

  async snapshot(request: SnapshotRequest): Promise<SnapshotResult> {
    if (!/^[a-f0-9]{12}-[a-f0-9]{12}$/iu.test(request.candidateId)) throw new Error('候选标识不符合维护快照格式。');
    const snapshotId = request.snapshotId ?? `snapshot-${request.candidateId}-${randomBytes(8).toString('hex')}`;
    if (!/^snapshot-[a-f0-9-]{29,80}$/iu.test(snapshotId)) throw new Error('快照标识不符合维护快照格式。');
    if (request.retention !== undefined && (!Number.isSafeInteger(request.retention) || request.retention < 1 || request.retention > 20)) {
      throw new Error('恢复快照保留数量必须介于 1 和 20 之间。');
    }
    const result = await this.runner(
      this.profile,
      remoteShellCommand(coordinatorCommand(this.profile, {
        schema: 1,
        kind: 'snapshot',
        deployRoot: this.profile.deployRoot,
        dataDir: this.profile.dataDir,
        systemdDir: this.profile.systemdDir,
        buildEnvironment: this.profile.buildEnvironment,
        buildPython: this.profile.buildPython,
        maintenanceWrapper: this.profile.maintenanceWrapper,
        candidateId: request.candidateId,
        snapshotId,
        completion: 'reopen',
        ...(request.retention === undefined ? {} : { retention: request.retention }),
      })),
    );
    return snapshotResult(result.stdout, result.exitCode);
  }
}

function coordinatorCommand(profile: NativeProfile, request: Record<string, unknown>): string {
  const source = readFileSync(new URL('./candidate-coordinator.cjs', import.meta.url), 'utf8');
  return [
    'set -eu',
    `exec env BAOX_COORDINATOR_SOURCE_BASE64=${shellQuote(Buffer.from(source).toString('base64'))} BAOX_CANDIDATE_REQUEST_BASE64=${shellQuote(Buffer.from(JSON.stringify(request)).toString('base64'))} ${shellQuote(`${profile.deployRoot}/runtime/node/bin/node`)} -e ${shellQuote(source)} -- snapshot`,
  ].join('\n');
}

function snapshotResult(stdout: string, exitCode: number | null): SnapshotResult {
  const parsed = lastJson(stdout);
  if (!isSnapshotResult(parsed)) throw new Error(`恢复快照无法完成。SSH 命令退出码为 ${exitCode ?? '未知'}。`);
  if (exitCode !== 0 && parsed.state !== 'failed') throw new Error(`恢复快照无法完成。SSH 命令退出码为 ${exitCode ?? '未知'}。`);
  return parsed;
}

function lastJson(stdout: string): unknown {
  const line = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isSnapshotResult(value: unknown): value is SnapshotResult {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.state === 'verified') return validSnapshotReference(record) && record.completion === 'reopen';
  if (record.state === 'busy') return typeof record.operation === 'string' && typeof record.candidateId === 'string';
  if (record.state === 'refused') return typeof record.code === 'string';
  if (record.state === 'failed') return typeof record.code === 'string' && (record.recoveryRequired === undefined || typeof record.recoveryRequired === 'boolean');
  return record.state === 'reconcile-needed' && typeof record.code === 'string';
}

function validSnapshotReference(record: Record<string, unknown>): boolean {
  return typeof record.snapshotId === 'string' && /^snapshot-[a-f0-9-]{29,80}$/iu.test(record.snapshotId)
    && typeof record.manifest === 'string' && record.manifest.startsWith('/');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
