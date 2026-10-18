import { describe, expect, it } from 'vitest';
import type { ExecutorEvent, Step } from '@baox/erp-executor/protocol';
import type { FrozenJob } from '../erp/fill-plan';
import { NO_ERP, type ErpRecord } from '../erp/fill-state';
import type { ErpFacts } from '../task-policy';
import { erpView } from './erp';

// 按路线的步骤文案 (#423, spec #412 part B): the snapshot words the steps of the route the job ran on. The 本地执行器
// starts a background browser, signs in with the saved 报销系统 account and ends by 暂存-ing the bill; the 浏览器扩展
// keeps its list, ending in 交接单据. The middle steps are the same on both.

const step = (name: Step, status: 'running' | 'done' | 'failed'): ExecutorEvent => ({ type: 'step', step: name, status });
const done = (...names: Step[]) => names.flatMap((name) => [step(name, 'running'), step(name, 'done')]);

function record(route: ErpRecord['route'], events: ExecutorEvent[], phase: ErpFacts['phase'] = 'running'): ErpRecord {
  return {
    ...NO_ERP,
    route,
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

describe('erp.steps by the route the job ran on', () => {
  it('gives a 本地执行器 job the 本地执行器 list', () => {
    expect(copy(record('local_executor', [step('chromium', 'running')]))).toEqual([
      ['启动后台浏览器', '在你的电脑上启动一个看不见的浏览器，专门用于这次报销。'],
      ['登录', '用你在设置页保存的报销系统账号登录。'],
      ...MIDDLE,
      ['暂存到报销系统', '你检查后自己提交'],
    ]);
  });

  it('gives a 浏览器扩展 job the list it always had, ending in 交接单据', () => {
    expect(copy(record('extension', [step('chromium', 'running')]))).toEqual([
      ['打开报销系统标签页', '通过已配对的浏览器扩展，打开这次报销专用的报销系统标签页。'],
      ['登录', '在为这次报销打开的报销系统标签页里使用本人账号登录。应用不会替你输入账号或密码。'],
      ...MIDDLE,
      ['交接单据', '不点保存、不提交审批：严格回读逐行通过后，把填好的报销单交给你，由你自己点「保存」并按流程提交。'],
    ]);
  });

  it('keeps 暂存到报销系统 running through the read-back, 暂存 and 核对暂存单, and done only when they are', () => {
    const BEFORE = done('chromium', 'login', 'catalog', 'navigate', 'compatibility', 'import', 'readback', 'fill');
    const last = (events: ExecutorEvent[], phase?: ErpFacts['phase']) => erpView(record('local_executor', events, phase)).steps.at(-1)!;
    expect(last([...BEFORE, step('handover', 'running')]).status).toBe('running');
    expect(last([...BEFORE, ...done('handover')]).status).toBe('running');
    expect(last([...BEFORE, ...done('handover', 'save'), step('draft_check', 'running')]).status).toBe('running');
    expect(last([...BEFORE, ...done('handover', 'save'), step('draft_check', 'failed')], 'unknown').status).toBe('failed');
    expect(last([...BEFORE, ...done('handover', 'save', 'draft_check')], 'drafted')).toMatchObject({ key: 'handover', title: '暂存到报销系统', status: 'done' });
  });
});
