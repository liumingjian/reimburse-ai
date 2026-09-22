import type { DoctorReport, GateStatus, HostCommand, HostResult, HostStatus, HostTransport } from '../host.js';

export type ControllableTargetOptions = {
  status?: HostStatus;
  doctor?: DoctorReport;
  gate?: GateStatus;
  logs?: string;
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
  maintenanceWrapper: 'present',
};

export class ControllableTarget implements HostTransport {
  readonly commands: HostCommand[] = [];
  private readonly status: HostStatus;
  private readonly doctor: DoctorReport;
  private readonly gate: GateStatus;
  private readonly logs: string;

  constructor(options: ControllableTargetOptions = {}) {
    this.status = options.status ?? DEFAULT_STATUS;
    this.doctor = options.doctor ?? DEFAULT_DOCTOR;
    this.gate = options.gate ?? { kind: 'missing-gate' };
    this.logs = options.logs ?? '';
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
    }
  }

  clearCommands(): void {
    this.commands.length = 0;
  }
}
