import { createHash } from 'node:crypto';
import { createCoordinatorInvocation, parseCoordinatorResponse, readCoordinatorSource } from './coordinator-transport.js';
import { productionSshRunner, type SshRunner } from './host.js';
import { isPhaseTimings, type PhaseTiming } from './phase-timings.js';
import { NATIVE_PROFILE, type NativeProfile } from './profile.js';
import type { SourceArchive } from './source.js';

export type CandidateArtifactOrigin = 'direct' | 'relay';

export type CandidatePreparation =
  | { state: 'prepared'; candidateId: string; manifest: string; phaseTimings?: PhaseTiming[] }
  | { state: 'busy'; operation: string; candidateId: string }
  | { state: 'not-ready'; issues: string[] }
  | { state: 'failed'; code: string; issues?: string[] }
  | { state: 'recovery-required'; candidateId: string; action: string }
  | { state: 'reconcile-needed'; code: string };

export type CandidateInspection = {
  state: 'inspection';
  lock: { state: 'active' | 'inactive' | 'unknown-owner' | 'unlocked'; owner?: { operation: string; candidateId: string; pid: number } };
  journal: Record<string, unknown> | null;
  manifest: Record<string, unknown> | null;
};

export type CandidatePrepareRequest = {
  source: SourceArchive;
  artifact: Buffer;
  artifactOrigin: CandidateArtifactOrigin;
};

export interface CandidateTransport {
  prepare(request: CandidatePrepareRequest): Promise<CandidatePreparation>;
  inspect(): Promise<CandidateInspection>;
}

export type SshCandidateTransportOptions = {
  runner?: SshRunner;
  profile?: NativeProfile;
  coordinatorSource?: () => string;
};

export class SshCandidateTransport implements CandidateTransport {
  private readonly runner: SshRunner;
  private readonly profile: NativeProfile;
  private readonly coordinatorSource: () => string;

  constructor(options: SshCandidateTransportOptions = {}) {
    this.runner = options.runner ?? productionSshRunner;
    this.profile = options.profile ?? NATIVE_PROFILE;
    this.coordinatorSource = options.coordinatorSource ?? readCoordinatorSource;
  }

  async prepare(request: CandidatePrepareRequest): Promise<CandidatePreparation> {
    if (sha256(request.artifact) !== request.source.plan.archiveSha256) {
      throw new Error('候选归档的 SHA-256 与已提交 Git 归档不一致。');
    }
    const invocation = createCoordinatorInvocation({
      nodePath: `${this.profile.deployRoot}/runtime/node/bin/node`,
      mode: 'receive',
      coordinatorSource: this.coordinatorSource(),
      request: {
        schema: 1,
        deployRoot: this.profile.deployRoot,
        serviceHome: this.profile.serviceHome,
        systemdDir: this.profile.systemdDir,
        buildEnvironment: this.profile.buildEnvironment,
        buildPython: this.profile.buildPython,
        candidateId: candidateId(request.source.plan.commit, request.source.plan.archiveSha256),
        source: {
          ref: request.source.plan.ref,
          commit: request.source.plan.commit,
          archiveSha256: request.source.plan.archiveSha256,
          artifactOrigin: request.artifactOrigin,
        },
      },
      archive: [request.artifact],
    });
    const result = await this.runner(this.profile, invocation.remoteCommand, invocation.input);
    return preparationResult(result.stdout, result.exitCode);
  }

  async inspect(): Promise<CandidateInspection> {
    const invocation = createCoordinatorInvocation({
      nodePath: `${this.profile.deployRoot}/runtime/node/bin/node`,
      mode: 'report',
      coordinatorSource: this.coordinatorSource(),
      request: {
        schema: 1,
        inspect: true,
        deployRoot: this.profile.deployRoot,
        serviceHome: this.profile.serviceHome,
        systemdDir: this.profile.systemdDir,
        buildEnvironment: this.profile.buildEnvironment,
        buildPython: this.profile.buildPython,
      },
    });
    const result = await this.runner(this.profile, invocation.remoteCommand, invocation.input);
    return parseCoordinatorResponse(result, {
      isResponse: isInspection,
      malformedMessage: () => '候选状态检查返回了不兼容的响应。',
      exitMessage: () => '候选状态检查无法完成。',
      rejectNonzeroBeforeParsing: true,
    });
  }
}

function candidateId(commit: string, archiveSha256: string): string {
  return `${commit.slice(0, 12)}-${archiveSha256.slice(0, 12)}`;
}

function preparationResult(stdout: string, exitCode: number | null): CandidatePreparation {
  const result = { stdout, exitCode };
  return parseCoordinatorResponse(result, {
    isResponse: isPreparation,
    malformedMessage: (code) => `候选准备无法完成。SSH 命令退出码为 ${code ?? '未知'}。`,
    exitMessage: (code) => `候选准备无法完成。SSH 命令退出码为 ${code ?? '未知'}。`,
    allowsNonzeroExit: (response) => response.state === 'failed',
  });
}

function isPreparation(value: unknown): value is CandidatePreparation {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.state === 'prepared') {
    return typeof record.candidateId === 'string' && typeof record.manifest === 'string'
      && (record.phaseTimings === undefined || isPhaseTimings(record.phaseTimings));
  }
  if (record.state === 'busy') return typeof record.operation === 'string' && typeof record.candidateId === 'string';
  if (record.state === 'not-ready') return stringArray(record.issues);
  if (record.state === 'failed') return typeof record.code === 'string' && (record.issues === undefined || stringArray(record.issues));
  if (record.state === 'recovery-required') return typeof record.candidateId === 'string' && typeof record.action === 'string';
  return record.state === 'reconcile-needed' && typeof record.code === 'string';
}

function isInspection(value: unknown): value is CandidateInspection {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.state !== 'inspection' || !record.lock || typeof record.lock !== 'object') return false;
  const lock = record.lock as Record<string, unknown>;
  return (lock.state === 'active' || lock.state === 'inactive' || lock.state === 'unknown-owner' || lock.state === 'unlocked')
    && (record.journal === null || typeof record.journal === 'object')
    && (record.manifest === null || typeof record.manifest === 'object');
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
