import { NATIVE_PROFILE } from './profile.js';
import type { DoctorReport, GateStatus, HostResult, HostStatus, HostTransport } from './host.js';
import { redact, redactValue } from './redact.js';
import type { SourcePlan, SourceRepository } from './source.js';
import { SourceSelectionError } from './source.js';

export type CliIo = {
  out: (line: string) => void;
  err: (line: string) => void;
};

export type OperatorDependencies = {
  source: SourceRepository;
  host: HostTransport;
};

const USAGE = [
  '用法：baox-operator <命令> [选项]',
  '命令：plan [Git 引用]、status、doctor、logs [--lines N]、deploy --dry-run [Git 引用]',
].join('\n');

export async function runOperatorCli(argv: readonly string[], dependencies: OperatorDependencies, io: CliIo): Promise<number> {
  try {
    const { argumentsWithoutJson, json } = extractJson(argv);
    const [command, ...rest] = argumentsWithoutJson;
    switch (command) {
      case 'plan':
        return await plan(rest, dependencies, io, json);
      case 'status':
        return await status(rest, dependencies, io, json);
      case 'doctor':
        return await doctor(rest, dependencies, io, json);
      case 'logs':
        return await logs(rest, dependencies, io, json);
      case 'deploy':
        return await deployDryRun(rest, dependencies, io, json);
      default:
        io.err(USAGE);
        return 2;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '命令无法完成。';
    io.err(redact(message));
    return error instanceof SourceSelectionError ? 2 : 3;
  }
}

async function plan(args: readonly string[], dependencies: OperatorDependencies, io: CliIo, json: boolean): Promise<number> {
  if (args.length > 1) return usage(io);
  const source = await dependencies.source.plan(args[0]);
  emit(io, json, { command: 'plan', source, profile: publicProfile() }, planLines(source));
  return 0;
}

async function status(args: readonly string[], dependencies: OperatorDependencies, io: CliIo, json: boolean): Promise<number> {
  if (args.length > 0) return usage(io);
  const host = statusValue(await dependencies.host.execute({ kind: 'status' }));
  const gate = gateValue(await dependencies.host.execute({ kind: 'gate-status' }));
  emit(io, json, { command: 'status', profile: publicProfile(), host, maintenanceGate: gate }, statusLines(host, gate));
  return 0;
}

async function doctor(args: readonly string[], dependencies: OperatorDependencies, io: CliIo, json: boolean): Promise<number> {
  if (args.length > 0) return usage(io);
  const host = statusValue(await dependencies.host.execute({ kind: 'status' }));
  const report = doctorValue(await dependencies.host.execute({ kind: 'doctor' }));
  const gate = gateValue(await dependencies.host.execute({ kind: 'gate-status' }));
  const healthy = host.baoxService === 'active'
    && host.caddyService === 'active'
    && host.dataDirectory === 'present'
    && report.nodeVersion !== null
    && report.gccVersion !== null
    && report.buildPython !== null
    && report.maintenanceWrapper === 'present'
    && gateAllowsRoutineDeployment(gate);
  emit(io, json, { command: 'doctor', healthy, profile: publicProfile(), host, runtime: report, maintenanceGate: gate }, doctorLines(host, report, gate, healthy));
  return healthy ? 0 : 1;
}

async function logs(args: readonly string[], dependencies: OperatorDependencies, io: CliIo, json: boolean): Promise<number> {
  const lines = parseLogLines(args);
  if (lines === null) return usage(io);
  const value = logsValue(await dependencies.host.execute({ kind: 'logs', lines }));
  emit(io, json, { command: 'logs', lines, output: value }, [value]);
  return 0;
}

async function deployDryRun(args: readonly string[], dependencies: OperatorDependencies, io: CliIo, json: boolean): Promise<number> {
  const sourceRef = parseDryRun(args);
  if (sourceRef === null) return usage(io);
  const source = await dependencies.source.plan(sourceRef ?? undefined);
  const gate = gateValue(await dependencies.host.execute({ kind: 'gate-status' }));
  const allowed = gateAllowsRoutineDeployment(gate);
  const refusal = allowed ? null : gateRefusal(gate);
  emit(
    io,
    json,
    { command: 'deploy', dryRun: true, source, profile: publicProfile(), maintenanceGate: gate, ...(refusal ? { refusal } : {}) },
    [...planLines(source), ...(allowed ? ['只读预检通过。候选准备和切换由后续运维命令完成。'] : refusal ? [refusal] : [])],
  );
  return allowed ? 0 : 1;
}

function extractJson(argv: readonly string[]): { argumentsWithoutJson: string[]; json: boolean } {
  let json = false;
  const argumentsWithoutJson: string[] = [];
  for (const argument of argv) {
    if (argument === '--json') {
      if (json) throw new SourceSelectionError('选项 --json 只能出现一次。');
      json = true;
    } else {
      argumentsWithoutJson.push(argument);
    }
  }
  return { argumentsWithoutJson, json };
}

function parseLogLines(args: readonly string[]): number | null {
  if (args.length === 0) return 200;
  if (args.length !== 2 || args[0] !== '--lines' || !/^\d+$/u.test(args[1] ?? '')) return null;
  const lines = Number.parseInt(args[1] as string, 10);
  return lines >= 1 && lines <= 1_000 ? lines : null;
}

function parseDryRun(args: readonly string[]): string | null | undefined {
  const dryRunIndexes = args.flatMap((argument, index) => argument === '--dry-run' ? [index] : []);
  if (dryRunIndexes.length !== 1) return null;
  const sourceRefs = args.filter((argument) => argument !== '--dry-run');
  return sourceRefs.length <= 1 ? sourceRefs[0] : null;
}

function statusValue(result: HostResult): HostStatus {
  if (result.kind !== 'status') throw new Error('状态检查返回了不匹配的响应。');
  return result.value;
}

function doctorValue(result: HostResult): DoctorReport {
  if (result.kind !== 'doctor') throw new Error('诊断检查返回了不匹配的响应。');
  return result.value;
}

function logsValue(result: HostResult): string {
  if (result.kind !== 'logs') throw new Error('日志收集返回了不匹配的响应。');
  return result.value;
}

function gateValue(result: HostResult): GateStatus {
  if (result.kind !== 'gate-status') throw new Error('维护闸门检查返回了不匹配的响应。');
  return result.value;
}

function gateAllowsRoutineDeployment(gate: GateStatus): boolean {
  return gate.kind === 'available' && gate.response.state !== 'unknown';
}

function gateRefusal(gate: GateStatus): string {
  if (gate.kind === 'missing-gate') {
    return '拒绝常规部署：主机没有维护闸门。首次启用必须由维护人员执行单独、明确的受控变更，不能以检查后停止服务的方式切换。';
  }
  if (gate.kind === 'incompatible-gate') return '拒绝常规部署：维护闸门协议不兼容，无法安全判断写入状态。';
  if (gate.kind === 'unavailable-gate') return '拒绝常规部署：维护闸门不可用，无法安全判断写入状态。';
  return '拒绝常规部署：维护闸门报告未知写入状态。';
}

function publicProfile() {
  return { host: NATIVE_PROFILE.host, deployRoot: NATIVE_PROFILE.deployRoot, dataDir: NATIVE_PROFILE.dataDir };
}

function planLines(source: SourcePlan): string[] {
  const changes = source.excludedWorkingTreeChanges.length;
  return [
    `已锁定源代码：${source.ref} -> ${source.commit}`,
    `提交归档 SHA-256：${source.archiveSha256}`,
    changes === 0 ? '工作树没有排除项。' : `已排除 ${changes} 个本地工作树变更。`,
  ];
}

function statusLines(host: HostStatus, gate: GateStatus): string[] {
  return [
    `当前发布：${host.currentRelease ?? '未找到'}`,
    `baox 服务：${host.baoxService}`,
    `Caddy 服务：${host.caddyService}`,
    `数据目录：${host.dataDirectory}`,
    `维护闸门：${gate.kind}`,
  ];
}

function doctorLines(host: HostStatus, report: DoctorReport, gate: GateStatus, healthy: boolean): string[] {
  return [
    ...statusLines(host, gate),
    `Node：${report.nodeVersion ?? '未找到'}`,
    `GCC：${report.gccVersion ?? '未找到'}`,
    `构建 Python：${report.buildPython ?? '未找到'}`,
    `维护闸门包装器：${report.maintenanceWrapper}`,
    healthy ? '诊断通过。' : gateAllowsRoutineDeployment(gate) ? '诊断未通过。' : gateRefusal(gate),
  ];
}

function emit(io: CliIo, json: boolean, value: unknown, lines: readonly string[]): void {
  if (json) {
    io.out(JSON.stringify(redactValue(value)));
    return;
  }
  for (const line of lines) io.out(redact(line));
}

function usage(io: CliIo): 2 {
  io.err(USAGE);
  return 2;
}
