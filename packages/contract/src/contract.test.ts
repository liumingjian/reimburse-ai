// 纯 schema 测试：只依赖契约本身。夹具快照与 mock 行为的一致性测试在 web/src/mock/contract-consistency.test.ts。
import { describe, expect, test } from 'vitest';
import { CREATE_TASK_ERRORS, CreateTaskInputSchema, PENDING_ANSWER_ERRORS, isRealDate, validatePendingAnswer } from './actions';
import { STAGE_DEFAULT_PAGE, pageAllowed, stageReached } from './stage';
import { CONFIRMATION_NO_COLUMN, CONFIRMATION_TABLE_COLUMNS } from './snapshot';

describe('整单确认表', () => {
  test('13 列的列名与顺序与内核 preparationConfirmationTable（next.mjs:522-535）逐字一致，No. 另加在最前', () => {
    expect(CONFIRMATION_TABLE_COLUMNS.join(' | ')).toBe('发票 | 项目号 | 起始日期 | 结束日期 | 住宿地/城市 | 出发点 | 目的地 | 费用分类 | 费用项目 | 发票类型 | 费用金额 | 税额 | 总额');
    expect(CONFIRMATION_TABLE_COLUMNS).toHaveLength(13);
    expect(CONFIRMATION_NO_COLUMN).toBe('No.');
  });
});

describe('契约 schema', () => {
  test('新建任务输入：只有常驻城市，去掉空白后必填', () => {
    const messages = (input: unknown) => {
      const result = CreateTaskInputSchema.safeParse(input);
      return result.success ? [] : result.error.issues.map((issue) => issue.message);
    };
    expect(messages({ homeCity: '  ' })).toEqual([CREATE_TASK_ERRORS.homeCityRequired]);
    expect(messages({ homeCity: '' })).toEqual([CREATE_TASK_ERRORS.homeCityRequired]);
    expect(messages({ homeCity: '杭州' })).toEqual([]);
    expect(CreateTaskInputSchema.parse({ homeCity: ' 上海 ' })).toEqual({ homeCity: '上海' });
    expect(isRealDate('2024-02-29')).toBe(true);
    expect(isRealDate('2026-02-29')).toBe(false);
    expect(isRealDate('2026/09/03')).toBe(false);
  });

  test('待确认项答复校验：必填、HH:MM、日期与选择', () => {
    const form = {
      kind: 'form' as const,
      fields: [
        { key: 'alightTime', label: '下车时间', placeholder: '', required: true, format: 'time' as const },
        { key: 'origin', label: '起点', placeholder: '', required: true, format: 'text' as const },
        { key: 'day', label: '日期', placeholder: '', required: false, format: 'date' as const },
      ],
      choices: [],
    };
    expect(validatePendingAnswer(form, { alightTime: '19:06', origin: ' 静安寺 ' })).toEqual({});
    expect(validatePendingAnswer(form, { alightTime: '90:60', origin: '' })).toEqual({ alightTime: PENDING_ANSWER_ERRORS.time, origin: PENDING_ANSWER_ERRORS.required });
    expect(validatePendingAnswer(form, { alightTime: '24:00', origin: 'x', day: '2026-02-30' })).toEqual({ alightTime: PENDING_ANSWER_ERRORS.time, day: PENDING_ANSWER_ERRORS.date });
    const choice = { kind: 'choice' as const, fields: [], choices: [{ key: 'exclude', label: '排除此材料' }] };
    expect(validatePendingAnswer(choice, { choice: 'exclude' })).toEqual({});
    expect(validatePendingAnswer(choice, { choice: 'nope' })).toEqual({ choice: PENDING_ANSWER_ERRORS.choice });
  });
});

describe('报销任务阶段', () => {
  test('页面守卫：阶段不可跳过；项目归属在整单确认之前，打印稿在确认之后，ERP 填报在去报销之后', () => {
    expect(stageReached('review', 'inventory')).toBe(true);
    expect(stageReached('upload', 'inventory')).toBe(false);
    expect(pageAllowed('upload', 'inventory')).toBe(false);
    expect(pageAllowed('pending', 'project')).toBe(false);
    expect(pageAllowed('project', 'project')).toBe(true);
    expect(pageAllowed('project', 'review')).toBe(false);
    expect(pageAllowed('catalog', 'review')).toBe(true);
    expect(pageAllowed('review', 'print')).toBe(false);
    expect(pageAllowed('actions', 'print')).toBe(true);
    expect(pageAllowed('actions', 'project')).toBe(true);
    expect(pageAllowed('actions', 'erp')).toBe(false);
    expect(pageAllowed('erp', 'erp')).toBe(true);
    expect(pageAllowed('reconcile', 'reconcile')).toBe(true);
    expect(pageAllowed('done', 'reconcile')).toBe(false);
    expect(STAGE_DEFAULT_PAGE.catalog).toBe('review');
    expect(STAGE_DEFAULT_PAGE.preparation).toBe('review');
  });
});
