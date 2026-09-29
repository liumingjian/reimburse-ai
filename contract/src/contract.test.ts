// Pure schema tests that depend on the contract alone. Fixture-snapshot and mock-behaviour consistency tests live in web/src/mock/contract-consistency.test.ts.
import { describe, expect, test } from 'vitest';
import { CREATE_TASK_ERRORS, CreateTaskInputSchema, PENDING_ANSWER_ERRORS, isRealDate, validatePendingAnswer } from './actions';
import { STAGE_DEFAULT_PAGE, pageAllowed, stageReached, type TaskStage } from './stage';
import { UrlSchema } from './primitives';
import { EXTENSION_BRIDGE_NAMESPACE, bridgeMessage, ExtensionBridgeExtensionMessageSchema, ExtensionBridgePageMessageSchema, extensionVersionRefusal } from './extension';
import { CONFIRMATION_NO_COLUMN, CONFIRMATION_TABLE_COLUMNS, ERP_HANDOVER_STEP_COPY, ERP_PROGRESS_STEPS, ERP_SAVED_OUTCOME_NOTICE, HANDOVER_COMPLETED_NOTICE } from './snapshot';
import { KERNEL_PHASES } from './stage';

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

describe('地址字段', () => {
  test('只收同源地址：伪协议与站外地址进不了 href / src', () => {
    const accepts = (value: string) => UrlSchema.safeParse(value).success;
    // 服务端与 mock 真正用到的形状。
    for (const good of ['/api/tasks/t1/erp-capture', 'fixtures/m09-taxi-photo.jpg', 'fixtures/print-pg1.png', 'mock/screenshot/s1']) {
      expect(accepts(good), good).toBe(true);
    }
    // 页面会把这些直接放进 href / src，伪协议就是以本源身份执行脚本。
    for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'http://evil.example.com/x', 'https://evil.example.com/x', '//evil.example.com/x']) {
      expect(accepts(bad), bad).toBe(false);
    }
    // 页面自己用 URL.createObjectURL 造的支付截图预览地址，不来自服务端。
    expect(accepts('blob:http://127.0.0.1:4319/6f1b-4c2a')).toBe(true);
  });
});

describe('报销任务阶段', () => {
  // A task at `stage` with no action admitted: the gate falls back to the stage alone.
  const at = (stage: TaskStage) => ({ stage, allowedActions: [] });

  test('页面守卫：阶段不可跳过；项目归属在整单确认之前，打印稿在确认之后，ERP 填报在去报销之后', () => {
    expect(stageReached('review', 'inventory')).toBe(true);
    expect(stageReached('upload', 'inventory')).toBe(false);
    expect(pageAllowed(at('upload'), 'inventory')).toBe(false);
    expect(pageAllowed(at('pending'), 'project')).toBe(false);
    expect(pageAllowed(at('project'), 'project')).toBe(true);
    expect(pageAllowed(at('project'), 'review')).toBe(false);
    expect(pageAllowed(at('catalog'), 'review')).toBe(true);
    expect(pageAllowed(at('review'), 'print')).toBe(false);
    expect(pageAllowed(at('actions'), 'print')).toBe(true);
    expect(pageAllowed(at('actions'), 'project')).toBe(true);
    expect(pageAllowed(at('actions'), 'erp')).toBe(false);
    expect(pageAllowed(at('erp'), 'erp')).toBe(true);
    expect(pageAllowed(at('reconcile'), 'reconcile')).toBe(true);
    expect(pageAllowed(at('done'), 'reconcile')).toBe(false);
    expect(STAGE_DEFAULT_PAGE.catalog).toBe('review');
    expect(STAGE_DEFAULT_PAGE.preparation).toBe('review');
  });

  test('页面守卫：页面上的动作被服务端接受时，页面一定开放；作废的任务只留上传页', () => {
    expect(pageAllowed({ stage: 'erp', allowedActions: [] }, 'reconcile')).toBe(false);
    expect(pageAllowed({ stage: 'erp', allowedActions: ['reconcile'] }, 'reconcile')).toBe(true);
    expect(pageAllowed({ stage: 'review', allowedActions: ['confirm_review'] }, 'review')).toBe(true);
    expect(pageAllowed({ stage: 'voided', allowedActions: ['confirm_review'] }, 'review')).toBe(false);
    expect(pageAllowed({ stage: 'voided', allowedActions: [] }, 'upload')).toBe(true);
  });
});

// The hand-over copy records a filled form, not a saved or submitted reimbursement.
describe('交接文案', () => {
  test('完成页固定句说明单据还没有保存或提交，并交给员工完成这两个动作', () => {
    expect(HANDOVER_COMPLETED_NOTICE).toContain('还没有保存或提交');
    expect(HANDOVER_COMPLETED_NOTICE).toContain('由你自己点「保存」');
    expect(HANDOVER_COMPLETED_NOTICE).toContain('按流程提交');
    expect(HANDOVER_COMPLETED_NOTICE).toContain('不代表已保存、已提交、已审批或已付款');
  });

  test('完成页固定句带上 ADR-0028 的两条要求：报错回来重新去报销、保存后对账收尾', () => {
    for (const required of ['字段必录提示', '处理结果', '重新去报销', '不要手工补填']) {
      expect(HANDOVER_COMPLETED_NOTICE).toContain(required);
    }
    expect(HANDOVER_COMPLETED_NOTICE).toContain('保存后回到这里再对一次账。');
  });

  test('交接步、全部写入步骤与任务列表徽标都不再说草稿', () => {
    expect(ERP_HANDOVER_STEP_COPY.key).toBe('handover');
    for (const text of [...ERP_PROGRESS_STEPS.flatMap((step) => [step.title, step.description]), ...KERNEL_PHASES]) {
      expect(text).not.toContain('草稿');
    }
  });

  test('已保存结果只陈述报销系统实际读到的保存事实', () => {
    expect(ERP_SAVED_OUTCOME_NOTICE).toContain('已保存');
    expect(ERP_SAVED_OUTCOME_NOTICE).toContain('没有读到提交、审批或付款事实');
  });
});

// ADR-0021: overwriting the same unpacked directory keeps the stored pairing, so an upgrade is download, overwrite, reload.
describe('扩展版本太旧的拒绝文案', () => {
  test('只说下载、覆盖原来的目录、重新加载，不再要求重新配对', () => {
    for (const reported of ['0.9.0', null]) {
      const refusal = extensionVersionRefusal(reported, '2.0.0') ?? '';
      for (const step of ['重新下载扩展包', '覆盖原来的目录', '“重新加载”']) expect(refusal).toContain(step);
      expect(refusal).not.toContain('配对');
    }
  });
});

// #290: the page and the extension ignore everything on the page's message bus that is not tagged as theirs.
describe('page bridge messages', () => {
  test('a presence parses only with the namespace tag', () => {
    const presence = { namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'presence', version: '1.1.0', paired: true, accountId: 'a1' };
    expect(ExtensionBridgeExtensionMessageSchema.safeParse(presence).success).toBe(true);
    expect(ExtensionBridgeExtensionMessageSchema.safeParse({ ...presence, namespace: 'someone-else' }).success).toBe(false);
    expect(ExtensionBridgeExtensionMessageSchema.safeParse({ kind: 'presence', version: '1.1.0', paired: false, accountId: null }).success).toBe(false);
  });

  test('bridgeMessage adds the namespace tag, so what it builds parses', () => {
    expect(bridgeMessage({ kind: 'probe' })).toEqual({ namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'probe' });
    expect(ExtensionBridgePageMessageSchema.safeParse(bridgeMessage({ kind: 'pair', code: 'K7MQ2PXD', accountId: 'a1' })).success).toBe(true);
    expect(ExtensionBridgeExtensionMessageSchema.safeParse(bridgeMessage({ kind: 'switch_outcome', outcome: 'accepted' })).success).toBe(true);
  });

  test('page and extension messages do not parse as each other', () => {
    const probe = { namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'probe' };
    expect(ExtensionBridgePageMessageSchema.safeParse(probe).success).toBe(true);
    expect(ExtensionBridgeExtensionMessageSchema.safeParse(probe).success).toBe(false);
    const pair = { namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'pair', code: 'K7MQ2PXD', accountId: 'a1' };
    expect(ExtensionBridgePageMessageSchema.safeParse(pair).success).toBe(true);
    expect(ExtensionBridgeExtensionMessageSchema.safeParse(pair).success).toBe(false);
    const change = { namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'switch', accountId: 'a1' };
    expect(ExtensionBridgePageMessageSchema.safeParse(change).success).toBe(true);
    expect(ExtensionBridgeExtensionMessageSchema.safeParse(change).success).toBe(false);
  });

  // #292: the extension can only tell a switch of accounts before redeeming if the page says whom the code is for.
  test('a pair request names the account the code was issued for', () => {
    expect(ExtensionBridgePageMessageSchema.safeParse({ namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'pair', code: 'K7MQ2PXD' }).success).toBe(false);
    expect(ExtensionBridgePageMessageSchema.safeParse({ namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'switch' }).success).toBe(false);
  });

  test('a switch outcome is accepted or declined', () => {
    const outcome = (value: unknown) => ExtensionBridgeExtensionMessageSchema.safeParse({ namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'switch_outcome', outcome: value }).success;
    expect(outcome('accepted')).toBe(true);
    expect(outcome('declined')).toBe(true);
    expect(outcome('maybe')).toBe(false);
  });

  // #291: a failed pairing carries the code and message the popup's redeem gets, so the page can show the same reason.
  test('a pair outcome is paired with the account, failed with a code and message, or declined', () => {
    const outcome = (value: unknown) => ExtensionBridgeExtensionMessageSchema.safeParse({ namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'pair_outcome', outcome: value }).success;
    expect(outcome({ status: 'paired', accountId: 'a1' })).toBe(true);
    expect(outcome({ status: 'failed', code: 'version_too_old', message: '请升级' })).toBe(true);
    expect(outcome({ status: 'declined' })).toBe(true);
    expect(outcome({ status: 'failed', message: '请升级' })).toBe(false);
    expect(outcome({ status: 'paired' })).toBe(false);
    expect(outcome({ status: 'somewhere-else' })).toBe(false);
  });
});
