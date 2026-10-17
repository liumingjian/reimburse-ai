import { describe, expect, it } from 'vitest';
import type { ExecutorEvent, Step, StepProgress } from '@baox/erp-executor/protocol';
import type { FrozenJob } from '../erp/fill-plan';
import { NO_ERP, type ErpRecord } from '../erp/fill-state';
import type { ErpFacts } from '../task-policy';
import { erpView } from './erp';

// 去报销进度 (#420, spec #412 part A): a recorded event history goes in, the 去报销 page's bar (`erp.progress`) comes out.
// The percentage counts steps, never time: every shown step once, each 明细 row once, then 暂存 and 核对暂存单 where they
// ran. A history without row progress (an executor or 浏览器扩展 from before it) counts each shown step once.

const MARK = 'baox-k3m9q2x7v1';
const step = (name: Step, status: 'running' | 'done' | 'failed', progress?: StepProgress): ExecutorEvent =>
  ({ type: 'step', step: name, status, ...(progress ? { progress } : {}) });
const done = (...names: Step[]) => names.flatMap((name) => [step(name, 'running'), step(name, 'done')]);
const BEFORE_FILL = done('chromium', 'login', 'catalog', 'navigate', 'compatibility', 'import', 'readback');
const rows = (upTo: number, total: number) => Array.from({ length: upTo + 1 }, (_, n) => step('fill', 'running', { done: n, total }));

function record(events: ExecutorEvent[], { phase = 'running', draft = false, lines = 8, trigger = 'start' }: {
  phase?: ErpFacts['phase']; draft?: boolean; lines?: number; trigger?: ErpFacts['trigger'];
} = {}): ErpRecord {
  const frozen = { plan: draft ? { draft: { mark: MARK } } : {}, judge: { lines: Array.from({ length: lines }, () => ({})) } } as unknown as FrozenJob;
  return {
    ...NO_ERP,
    facts: { jobId: 'job-1', trigger, revision: 1, phase, reassign: false, reconciling: false, drafting: false },
    frozen,
    events,
  };
}
const progressOf = (events: ExecutorEvent[], options?: Parameters<typeof record>[1]) => erpView(record(events, options)).progress;

describe('erp.progress from the recorded events', () => {
  it('names the 明细 row being filled, and counts each row as a step', () => {
    // 6 steps before 填写明细, 8 rows, 交接单据: 15 steps, 6 + 3 done.
    expect(progressOf([...BEFORE_FILL, ...rows(3, 8)])).toEqual({ label: '填写明细 3/8', percent: 60 });
  });

  it('counts 暂存 and 核对暂存单 on the path that 暂存s', () => {
    // 17 steps: the same 15, then 暂存 and 核对暂存单.
    expect(progressOf([...BEFORE_FILL, ...rows(3, 8)], { draft: true })).toEqual({ label: '填写明细 3/8', percent: 52 });
    const checking = [...BEFORE_FILL, ...rows(8, 8), step('fill', 'done'), ...done('handover', 'save'), step('draft_check', 'running')];
    expect(progressOf(checking, { draft: true })).toEqual({ label: '核对暂存单', percent: 94 });
  });

  it('takes the total from the job before 填写明细 starts, so the bar does not jump back', () => {
    expect(progressOf([...done('chromium'), step('login', 'running')], { lines: 2 })).toEqual({ label: '登录', percent: 11 });
  });

  it('counts each shown step once, with no 「n/m」, for a history without row progress', () => {
    const old = [...BEFORE_FILL, step('fill', 'running')];
    expect(progressOf(old)).toEqual({ label: '填写明细', percent: 75 });
    expect(progressOf(old, { draft: true })).toEqual({ label: '填写明细', percent: 75 });
  });

  it('freezes at the failed step', () => {
    expect(progressOf([...BEFORE_FILL, ...rows(3, 8), step('fill', 'failed')], { phase: 'unknown' })).toEqual({ label: '填写明细 3/8', percent: 60 });
    const beforeWrite = [...done('chromium', 'login', 'catalog'), step('navigate', 'running'), step('compatibility', 'running'), step('compatibility', 'failed')];
    expect(progressOf(beforeWrite, { phase: 'aborted' })).toEqual({ label: '打开空白报销单', percent: 20 });
  });

  it('is at 100 only when the job has finished', () => {
    const allDone = [...BEFORE_FILL, ...rows(8, 8), step('fill', 'done'), ...done('handover')];
    expect(progressOf(allDone)?.percent).toBe(99);
    expect(progressOf(allDone, { phase: 'handed_over' })).toEqual({ label: '交接单据', percent: 100 });
    const drafted = [...allDone, ...done('save', 'draft_check')];
    expect(progressOf(drafted, { draft: true })?.percent).toBe(99);
    expect(progressOf(drafted, { draft: true, phase: 'drafted' })).toEqual({ label: '核对暂存单', percent: 100 });
  });

  it('shows the login wait as the current step', () => {
    expect(progressOf([...done('chromium'), step('login', 'running'), step('login', 'done')], { phase: 'waiting_login' })).toEqual({ label: '登录', percent: 6 });
  });

  it('is null when no 去报销 job is running or finished for the task', () => {
    expect(erpView(NO_ERP).progress).toBeNull();
    expect(progressOf(done('chromium', 'login'), { phase: 'cancelled' })).toBeNull();
    expect(progressOf([...done('chromium', 'login'), step('catalog', 'running')], { phase: 'catalog_mismatch' })).toBeNull();
  });

  it('starts again from the new run during an 自动重新去报销', () => {
    expect(progressOf([step('chromium', 'running')], { trigger: 'rerun' })).toEqual({ label: '打开报销系统标签页', percent: 0 });
    expect(progressOf([...BEFORE_FILL, ...rows(1, 8)], { trigger: 'rerun' })).toEqual({ label: '填写明细 1/8', percent: 46 });
  });
});
