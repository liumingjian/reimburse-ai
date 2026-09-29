/**
 * One measured deploy phase, as the host coordinator records it in the
 * deployment journal (`phaseTimings`). Candidate phases: upload, extract,
 * install, build, native, config. Cutover phases: snapshot, cutover, verify, reopen.
 * `reused` marks a phase that carried the running release's output over
 * (node_modules, the native module, or every package build); `rebuilt` lists
 * the only packages an incremental build ran.
 */
export type PhaseTiming = {
  phase: string;
  startedAt: string;
  durationMs: number;
  failed?: boolean;
  reused?: boolean;
  rebuilt?: string[];
};

const PHASE_LABELS: Readonly<Record<string, string>> = {
  upload: '上传归档',
  extract: '解压源码',
  install: '安装依赖',
  build: '构建软件包',
  native: '原生模块检查',
  config: '渲染配置',
  snapshot: '恢复快照',
  cutover: '切换发布',
  verify: '验证候选',
  reopen: '重新开放',
};

export function isPhaseTimings(value: unknown): value is PhaseTiming[] {
  return Array.isArray(value) && value.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as Record<string, unknown>;
    return typeof record.phase === 'string'
      && typeof record.startedAt === 'string'
      && typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs >= 0
      && (record.failed === undefined || typeof record.failed === 'boolean')
      && (record.reused === undefined || typeof record.reused === 'boolean')
      && (record.rebuilt === undefined || (Array.isArray(record.rebuilt) && record.rebuilt.every((name) => typeof name === 'string')));
  });
}

/** Renders the phase table printed at the end of a deploy. */
export function phaseTimingLines(timings: readonly PhaseTiming[]): string[] {
  if (timings.length === 0) return [];
  const rows = timings.map((timing) => ({
    name: `${timing.phase}（${PHASE_LABELS[timing.phase] ?? timing.phase}）`,
    seconds: `${seconds(timing.durationMs)}${timing.failed ? '（失败）' : ''}${reuseNote(timing)}`,
  }));
  const total = timings.reduce((sum, timing) => sum + timing.durationMs, 0);
  const width = Math.max(...rows.map((row) => row.name.length), '合计'.length);
  return [
    '阶段耗时：',
    ...rows.map((row) => `  ${row.name.padEnd(width)}  ${row.seconds}`),
    `  ${'合计'.padEnd(width)}  ${seconds(total)}`,
  ];
}

function reuseNote(timing: PhaseTiming): string {
  if (timing.reused) return '（沿用运行中版本）';
  if (timing.rebuilt) return `（仅构建 ${timing.rebuilt.join('、')}）`;
  return '';
}

function seconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)} s`;
}
