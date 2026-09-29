import { randomBytes } from 'node:crypto';
import { createCoordinatorInvocation, parseCoordinatorResponse, readCoordinatorSource } from './coordinator-transport.js';
import { productionSshRunner, type SshRunner } from './host.js';
import { isPhaseTimings, type PhaseTiming } from './phase-timings.js';
import { NATIVE_PROFILE, type NativeProfile } from './profile.js';

export type CutoverRequest = Readonly<{
  candidateId: string;
  snapshotId?: string;
  retention?: number;
}>;

export type CutoverResult =
  | { state: 'verified'; candidateId: string; release: string; snapshotId: string; manifest: string; phaseTimings?: PhaseTiming[] }
  | { state: 'restored'; candidateId: string; snapshotId: string; code: string }
  | { state: 'busy'; operation: string; candidateId: string }
  | { state: 'refused'; code: string }
  | { state: 'failed'; code: string }
  | { state: 'recovery-required'; candidateId: string; code: string; action: string }
  | { state: 'post-access-handoff'; candidateId: string; code: string; action: string }
  | { state: 'reconcile-needed'; code: string };

export interface CutoverTransport {
  cutover(request: CutoverRequest): Promise<CutoverResult>;
}

export type SshCutoverTransportOptions = {
  runner?: SshRunner;
  profile?: NativeProfile;
  coordinatorSource?: () => string;
};

/** Runs the fixed-target cutover coordinator. Production target selection stays fixed in NativeProfile. */
export class SshCutoverTransport implements CutoverTransport {
  private readonly runner: SshRunner;
  private readonly profile: NativeProfile;
  private readonly coordinatorSource: () => string;

  constructor(options: SshCutoverTransportOptions = {}) {
    this.runner = options.runner ?? productionSshRunner;
    this.profile = options.profile ?? NATIVE_PROFILE;
    this.coordinatorSource = options.coordinatorSource ?? readCoordinatorSource;
  }

  async cutover(request: CutoverRequest): Promise<CutoverResult> {
    if (!/^[a-f0-9]{12}-[a-f0-9]{12}$/iu.test(request.candidateId)) throw new Error('候选标识不符合发布切换格式。');
    const snapshotId = request.snapshotId ?? `snapshot-${request.candidateId}-${randomBytes(8).toString('hex')}`;
    if (!/^snapshot-[a-f0-9-]{29,80}$/iu.test(snapshotId)) throw new Error('恢复快照标识不符合发布切换格式。');
    if (request.retention !== undefined && (!Number.isSafeInteger(request.retention) || request.retention < 1 || request.retention > 20)) {
      throw new Error('恢复快照保留数量必须介于 1 和 20 之间。');
    }
    const invocation = createCoordinatorInvocation({
      nodePath: `${this.profile.deployRoot}/runtime/node/bin/node`,
      mode: 'cutover',
      coordinatorSource: this.coordinatorSource(),
      request: {
        schema: 1,
        kind: 'cutover',
        externalLock: true,
        operation: 'cutover',
        deployRoot: this.profile.deployRoot,
        dataDir: this.profile.dataDir,
        serviceHome: this.profile.serviceHome,
        systemdDir: this.profile.systemdDir,
        buildEnvironment: this.profile.buildEnvironment,
        buildPython: this.profile.buildPython,
        maintenanceWrapper: this.profile.maintenanceWrapper,
        candidateId: request.candidateId,
        snapshotId,
        ...(request.retention === undefined ? {} : { retention: request.retention }),
      },
    });
    const result = await this.runner(this.profile, invocation.remoteCommand, invocation.input);
    return cutoverResult(result.stdout, result.exitCode);
  }
}

function cutoverResult(stdout: string, exitCode: number | null): CutoverResult {
  return parseCoordinatorResponse({ stdout, exitCode }, {
    isResponse: isCutoverResult,
    malformedMessage: (code) => `发布切换无法完成。SSH 命令退出码为 ${code ?? '未知'}。`,
    exitMessage: (code) => `发布切换无法完成。SSH 命令退出码为 ${code ?? '未知'}。`,
    allowsNonzeroExit: (response) => response.state === 'failed',
  });
}

function isCutoverResult(value: unknown): value is CutoverResult {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.state === 'verified') return typeof record.candidateId === 'string' && typeof record.release === 'string'
    && validSnapshot(record) && typeof record.manifest === 'string' && record.manifest.startsWith('/')
    && (record.phaseTimings === undefined || isPhaseTimings(record.phaseTimings));
  if (record.state === 'restored') return typeof record.candidateId === 'string' && validSnapshot(record) && typeof record.code === 'string';
  if (record.state === 'busy') return typeof record.operation === 'string' && typeof record.candidateId === 'string';
  if (record.state === 'refused' || record.state === 'failed') return typeof record.code === 'string';
  if (record.state === 'recovery-required' || record.state === 'post-access-handoff') {
    return typeof record.candidateId === 'string' && typeof record.code === 'string' && typeof record.action === 'string';
  }
  return record.state === 'reconcile-needed' && typeof record.code === 'string';
}

function validSnapshot(record: Record<string, unknown>): boolean {
  return typeof record.snapshotId === 'string' && /^snapshot-[a-f0-9-]{29,80}$/iu.test(record.snapshotId);
}
