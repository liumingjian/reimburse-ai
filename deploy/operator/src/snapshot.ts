import { randomBytes } from 'node:crypto';
import { createCoordinatorInvocation, parseCoordinatorResponse, readCoordinatorSource } from './coordinator-transport.js';
import { productionSshRunner, type SshRunner } from './host.js';
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
  coordinatorSource?: () => string;
};

export class SshSnapshotTransport implements SnapshotTransport {
  private readonly runner: SshRunner;
  private readonly profile: NativeProfile;
  private readonly coordinatorSource: () => string;

  constructor(options: SshSnapshotTransportOptions = {}) {
    this.runner = options.runner ?? productionSshRunner;
    this.profile = options.profile ?? NATIVE_PROFILE;
    this.coordinatorSource = options.coordinatorSource ?? readCoordinatorSource;
  }

  async snapshot(request: SnapshotRequest): Promise<SnapshotResult> {
    if (!/^[a-f0-9]{12}-[a-f0-9]{12}$/iu.test(request.candidateId)) throw new Error('候选标识不符合维护快照格式。');
    const snapshotId = request.snapshotId ?? `snapshot-${request.candidateId}-${randomBytes(8).toString('hex')}`;
    if (!/^snapshot-[a-f0-9-]{29,80}$/iu.test(snapshotId)) throw new Error('快照标识不符合维护快照格式。');
    if (request.retention !== undefined && (!Number.isSafeInteger(request.retention) || request.retention < 1 || request.retention > 20)) {
      throw new Error('恢复快照保留数量必须介于 1 和 20 之间。');
    }
    const invocation = createCoordinatorInvocation({
      nodePath: `${this.profile.deployRoot}/runtime/node/bin/node`,
      mode: 'snapshot',
      coordinatorSource: this.coordinatorSource(),
      request: {
        schema: 1,
        kind: 'snapshot',
        deployRoot: this.profile.deployRoot,
        dataDir: this.profile.dataDir,
        serviceHome: this.profile.serviceHome,
        systemdDir: this.profile.systemdDir,
        buildEnvironment: this.profile.buildEnvironment,
        buildPython: this.profile.buildPython,
        maintenanceWrapper: this.profile.maintenanceWrapper,
        candidateId: request.candidateId,
        snapshotId,
        completion: 'reopen',
        ...(request.retention === undefined ? {} : { retention: request.retention }),
      },
    });
    const result = await this.runner(this.profile, invocation.remoteCommand, invocation.input);
    return snapshotResult(result.stdout, result.exitCode);
  }
}

function snapshotResult(stdout: string, exitCode: number | null): SnapshotResult {
  return parseCoordinatorResponse({ stdout, exitCode }, {
    isResponse: isSnapshotResult,
    malformedMessage: (code) => `恢复快照无法完成。SSH 命令退出码为 ${code ?? '未知'}。`,
    exitMessage: (code) => `恢复快照无法完成。SSH 命令退出码为 ${code ?? '未知'}。`,
    allowsNonzeroExit: (response) => response.state === 'failed',
  });
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
