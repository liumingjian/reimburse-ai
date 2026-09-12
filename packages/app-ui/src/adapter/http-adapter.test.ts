// @vitest-environment node
// HTTP 适配器只做响应形状测试：给定这段 JSON（或这个 Response），适配器接受还是拒绝。不模拟服务端，不 mock fetch。
import { describe, expect, test } from 'vitest';
import { ACTION_NAMES, STALE_STEP_CODE } from '../contract/actions';
import { HTTP_ENDPOINTS, endpointActionNames } from '../contract/http';
import { TASK_STAGES } from '../contract/stage';
import { EMPLOYEE, t1Snapshot, t2Snapshot, t3Snapshot, toListItem } from '../mock/fixtures/tasks';
import {
  INVALID_RESPONSE_CODE,
  outcomeFromResponse,
  parseActionResponse,
  parseSnapshotEvent,
  parseSnapshotResponse,
  parseTaskListResponse,
  reconnectDelay,
} from './http-adapter';

// 服务端发来的是 JSON 文本：先过一遍序列化，保证测试的是线上真实形状。
const wire = <T,>(value: T): unknown => JSON.parse(JSON.stringify(value));

describe('端点表', () => {
  test('动作端点与 ACTION_NAMES 一一对应，路径都在 /api/tasks 下', () => {
    expect([...endpointActionNames()].sort()).toEqual([...ACTION_NAMES].sort());
    for (const endpoint of Object.values(HTTP_ENDPOINTS)) expect(endpoint.path.startsWith('/api/tasks')).toBe(true);
    expect(HTTP_ENDPOINTS.uploadBatch.body).toBe('multipart');
    expect(HTTP_ENDPOINTS.addPaymentScreenshot.body).toBe('multipart');
    expect(HTTP_ENDPOINTS.subscribe.body).toBe('sse');
  });
});

describe('任务列表 GET /api/tasks', () => {
  const list = { employee: EMPLOYEE, homeCity: { value: '杭州', source: 'remembered' }, tasks: [t1Snapshot('done'), t2Snapshot(), t3Snapshot()].map(toListItem) };

  test('接受契约形状的列表', () => {
    expect(parseTaskListResponse(200, wire(list)).tasks).toHaveLength(3);
    expect(parseTaskListResponse(200, wire({ employee: null, homeCity: null, tasks: [] })).tasks).toEqual([]);
  });

  test('拒绝金额格式不对、缺字段或非 2xx', () => {
    const badAmount = wire(list) as { tasks: { grossTotal: string }[] };
    badAmount.tasks[0]!.grossTotal = '3972.5';
    expect(() => parseTaskListResponse(200, badAmount)).toThrow();
    expect(() => parseTaskListResponse(200, { tasks: [] })).toThrow();
    expect(() => parseTaskListResponse(500, wire(list))).toThrow(/HTTP 500/);
  });
});

describe('任务快照 GET /api/tasks/:id', () => {
  test('每个阶段的快照 JSON 都被接受', () => {
    for (const stage of TASK_STAGES) expect(parseSnapshotResponse(200, wire(t1Snapshot(stage))).stage).toBe(stage);
    expect(parseSnapshotResponse(200, wire(t2Snapshot())).reconcile.rows.length).toBeGreaterThan(0);
  });

  test('缺 step、日期格式不对或 404 被拒绝', () => {
    const noStep = wire(t1Snapshot('review')) as Record<string, unknown>;
    delete noStep.step;
    expect(() => parseSnapshotResponse(200, noStep)).toThrow();
    const badDate = wire(t3Snapshot()) as { task: { period: { start: string } } };
    badDate.task.period.start = '2026/06/02';
    expect(() => parseSnapshotResponse(200, badDate)).toThrow();
    expect(() => parseSnapshotResponse(404, null)).toThrow(/HTTP 404/);
  });
});

describe('动作端点 POST /api/tasks/:id/actions/<name> 等', () => {
  test('200 + 快照：成功', () => {
    const outcome = parseActionResponse(200, wire(t1Snapshot('actions')));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.snapshot.step.kind).toBe('choose_action');
  });

  test('200 但快照形状不符：按失败处理，不交给页面', () => {
    const outcome = parseActionResponse(200, { stage: 'review' });
    expect(outcome).toMatchObject({ ok: false, error: { code: INVALID_RESPONSE_CODE }, snapshot: null });
  });

  test('4xx + { error }：保留服务端的错误码与原因', () => {
    const outcome = parseActionResponse(422, { error: { code: 'invalid_answer', message: '格式应为 HH:MM，且小时 00-23、分钟 00-59。' } });
    expect(outcome).toEqual({ ok: false, error: { code: 'invalid_answer', message: '格式应为 HH:MM，且小时 00-23、分钟 00-59。' }, snapshot: null });
  });

  test('409 + { error, snapshot }：映射为 stale_step 并带最新快照', () => {
    const outcome = parseActionResponse(409, { error: { code: 'stale_step', message: '任务已在别处推进' }, snapshot: wire(t1Snapshot('actions')) });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe(STALE_STEP_CODE);
      expect(outcome.snapshot?.stage).toBe('actions');
    }
  });

  test('409 即使错误码不同或没带快照，也按 stale_step 处理（快照为空时由页面重新拉取）', () => {
    expect(parseActionResponse(409, { error: { code: 'conflict', message: 'x' } })).toMatchObject({ ok: false, error: { code: STALE_STEP_CODE }, snapshot: null });
    expect(parseActionResponse(409, { error: { code: 'stale_step', message: 'x' }, snapshot: { stage: 'nope' } })).toMatchObject({
      ok: false,
      error: { code: STALE_STEP_CODE },
      snapshot: null,
    });
  });

  test('非 JSON 或未知形状的失败响应：给出带状态码的通用原因', () => {
    expect(parseActionResponse(500, null)).toEqual({ ok: false, error: { code: 'http_500', message: '请求失败（HTTP 500）' }, snapshot: null });
    expect(parseActionResponse(400, { message: 'bad' })).toMatchObject({ error: { code: 'http_400' } });
  });

  test('解析边界上的 Response 对象：409 JSON 与 502 文本', async () => {
    const stale = new Response(JSON.stringify({ error: { code: 'stale_step', message: '任务已在别处推进' }, snapshot: t1Snapshot('review') }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    });
    expect(await outcomeFromResponse(stale)).toMatchObject({ ok: false, error: { code: STALE_STEP_CODE }, snapshot: { stage: 'review' } });
    expect(await outcomeFromResponse(new Response('Bad Gateway', { status: 502 }))).toMatchObject({ ok: false, error: { code: 'http_502' } });
  });
});

describe('事件流 GET /api/tasks/:id/events（SSE event: snapshot）', () => {
  test('data 是合法快照 JSON 时接受，否则丢弃', () => {
    expect(parseSnapshotEvent(JSON.stringify(t1Snapshot('erp')))?.stage).toBe('erp');
    expect(parseSnapshotEvent('{not json')).toBeNull();
    expect(parseSnapshotEvent(JSON.stringify({ stage: 'erp' }))).toBeNull();
  });

  test('断开后重连间隔按退避增长并封顶', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(reconnectDelay)).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000]);
  });
});
