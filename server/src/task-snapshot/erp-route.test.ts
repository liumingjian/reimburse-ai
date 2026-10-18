import { describe, expect, it } from 'vitest';
import type { ExecutorEvent, Step } from '@baox/erp-executor/protocol';
import type { FrozenJob } from '../erp/fill-plan';
import { NO_ERP, type ErpRecord } from '../erp/fill-state';
import type { ErpFacts } from '../task-policy';
import { erpView } from './erp';

// 去报销的步骤文案 (ADR-0037): one list for every job, the 本地执行器's. It starts a background browser, signs in with the
// saved 报销系统 account and ends by 暂存-ing the bill.

const step = (name: Step, status: 'running' | 'done' | 'failed'): ExecutorEvent => ({ type: 'step', step: name, status });
const done = (...names: Step[]) => names.flatMap((name) => [step(name, 'running'), step(name, 'done')]);

function record(events: ExecutorEvent[], phase: ErpFacts['phase'] = 'running'): ErpRecord {
  return {
    ...NO_ERP,
    facts: { jobId: 'job-1', trigger: 'start', revision: 1, phase, reassign: false, reconciling: false, drafting: false },
    frozen: { plan: {}, judge: { lines: [{}, {}] } } as unknown as FrozenJob,
    events,
  };
}

const MIDDLE = [
  ['报销信息核对', '只读核对项目与费用项目：在报销系统里存在、名称一致、已审核且未禁用。'],
  ['打开空白报销单', '打开费用报销单新增页，核对报销系统版本，确认是唯一一张空白单据。'],
  ['导入发票', '在发票助手里选择「不生成费用明细」，导入这次的发票。'],
  ['收票回读', '逐票回读收票单号、发票号码、不含税金额、税额与价税合计。'],
  ['填写明细', '按统一业务序号逐行写入明细，每个值写入后从单元格回读。'],
];
const copy = (r: ErpRecord) => erpView(r).steps.map((s) => [s.title, s.description]);

const LIST = [
  ['启动后台浏览器', '在你的电脑上启动一个看不见的浏览器，专门用于这次报销。'],
  ['登录', '用你在设置页保存的报销系统账号登录。'],
  ...MIDDLE,
  ['暂存到报销系统', '你检查后自己提交'],
];

describe('erp.steps: the one 本地执行器 list', () => {
  it('gives a running job the 本地执行器 list', () => {
    expect(copy(record([step('chromium', 'running')]))).toEqual(LIST);
  });

  it('gives a job that ended without a 暂存 the same list, ending in 暂存到报销系统', () => {
    expect(copy(record(done('chromium', 'login'), 'aborted'))).toEqual(LIST);
  });

  it('keeps 暂存到报销系统 running through the read-back, 暂存 and 核对暂存单, and done only when they are', () => {
    const BEFORE = done('chromium', 'login', 'catalog', 'navigate', 'compatibility', 'import', 'readback', 'fill');
    const last = (events: ExecutorEvent[], phase?: ErpFacts['phase']) => erpView(record(events, phase)).steps.at(-1)!;
    expect(last([...BEFORE, step('handover', 'running')]).status).toBe('running');
    expect(last([...BEFORE, ...done('handover')]).status).toBe('running');
    expect(last([...BEFORE, ...done('handover', 'save'), step('draft_check', 'running')]).status).toBe('running');
    expect(last([...BEFORE, ...done('handover', 'save'), step('draft_check', 'failed')], 'unknown').status).toBe('failed');
    expect(last([...BEFORE, ...done('handover', 'save', 'draft_check')], 'drafted')).toMatchObject({ key: 'handover', title: '暂存到报销系统', status: 'done' });
  });
});
