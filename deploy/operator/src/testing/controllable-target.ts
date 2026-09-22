import type { BootstrapResponse, LocalBootstrapArtifact } from '../bootstrap.js';
import type { DoctorReport, GateStatus, HostCommand, HostResult, HostStatus, HostTransport, TargetArtifactHandle } from '../host.js';

export type ControllableTargetOptions = {
  status?: HostStatus;
  doctor?: DoctorReport;
  gate?: GateStatus;
  logs?: string;
  bootstrapPreview?: BootstrapResponse;
  bootstrapApply?: BootstrapResponse;
};

const DEFAULT_STATUS: HostStatus = {
  currentRelease: '/opt/tools/baox/releases/baox-current',
  baoxService: 'active',
  caddyService: 'active',
  dataDirectory: 'present',
  availableKib: 4_000_000,
};

const DEFAULT_DOCTOR: DoctorReport = {
  nodeVersion: 'v24.13.0',
  gccVersion: '12.5.0',
  buildPython: 'Python 3.12.14',
  pnpmVersion: '10.17.1',
  caddyVersion: 'v2.10.2',
  serviceAccount: 'ready',
  maintenanceWrapper: 'present',
  issues: [],
};

export class ControllableTarget implements HostTransport {
  readonly commands: HostCommand[] = [];
  readonly uploads: LocalBootstrapArtifact[] = [];
  private readonly status: HostStatus;
  private readonly doctor: DoctorReport;
  private readonly gate: GateStatus;
  private readonly logs: string;
  private readonly bootstrapPreview: BootstrapResponse;
  private readonly bootstrapApply: BootstrapResponse;

  constructor(options: ControllableTargetOptions = {}) {
    this.status = options.status ?? DEFAULT_STATUS;
    this.doctor = options.doctor ?? DEFAULT_DOCTOR;
    this.gate = options.gate ?? { kind: 'missing-gate' };
    this.logs = options.logs ?? '';
    this.bootstrapPreview = options.bootstrapPreview ?? previewResponse();
    this.bootstrapApply = options.bootstrapApply ?? appliedResponse();
  }

  async execute(command: HostCommand): Promise<HostResult> {
    this.commands.push(command);
    switch (command.kind) {
      case 'status':
        return { kind: 'status', value: this.status };
      case 'doctor':
        return { kind: 'doctor', value: this.doctor };
      case 'logs':
        return { kind: 'logs', value: this.logs };
      case 'gate-status':
        return { kind: 'gate-status', value: this.gate };
      case 'bootstrap-preview':
        return { kind: 'bootstrap-preview', value: this.bootstrapPreview };
      case 'bootstrap-apply':
        return { kind: 'bootstrap-apply', value: this.bootstrapApply };
    }
  }

  async uploadArtifact(artifact: LocalBootstrapArtifact): Promise<TargetArtifactHandle> {
    this.uploads.push(artifact);
    return { fileName: artifact.fileName, sha256: artifact.sha256 };
  }

  clearCommands(): void {
    this.commands.length = 0;
  }
}

function previewResponse(): BootstrapResponse {
  return {
    version: 1,
    state: 'preview',
    plan: {
      transaction: [{ action: 'install', name: 'gmp-devel', nevra: 'gmp-devel-6.2.0-2.ky10.x86_64' }],
      transactionDigest: 'a'.repeat(64),
      protectedActions: [],
    },
  };
}

function appliedResponse(): BootstrapResponse {
  return {
    version: 1,
    state: 'applied',
    plan: previewResponse().plan,
    readiness: {
      serviceAccount: 'ready',
      gccVersion: '12.5.0',
      pythonVersion: '3.12.14',
      uvVersion: '0.12.17',
      pnpmVersion: '10.17.1',
      buildEnvironmentSha256: 'b'.repeat(64),
    },
  };
}
