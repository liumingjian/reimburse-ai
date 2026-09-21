// @vitest-environment node
// HTTP 适配器只做响应形状测试：给定这段 JSON（或这个 Response），适配器接受还是拒绝。不模拟服务端，不 mock fetch。
import { describe, expect, test, vi } from 'vitest';
import { ACTION_NAMES, ERP_ACTION_ERRORS, STALE_STEP_CODE, HTTP_ENDPOINTS, endpointActionNames, TASK_STAGES } from '@baox/contract';
import { INITIAL_BOOK, MOCK_TODAY, annotateProject } from '../mock/fixtures/projects';
import { t1Snapshot, t2Snapshot, t3Snapshot, toListItem } from '../mock/fixtures/tasks';
import {
  createHttpAdapter,
  INVALID_RESPONSE_CODE,
  outcomeFromResponse,
  parseActionResponse,
  parseProjectBookActionResponse,
  parseProjectBookResponse,
  parseSnapshotEvent,
  parseSnapshotResponse,
  parseAuthResponse,
  parseSessionResponse,
  parseTaskListActionResponse,
  parseTaskListResponse,
  reconnectDelay,
} from './http-adapter';

// 服务端发来的是 JSON 文本：先过一遍序列化，保证测试的是线上真实形状。
const wire = <T,>(value: T): unknown => JSON.parse(JSON.stringify(value));

describe('端点表', () => {
  test('动作端点与 ACTION_NAMES 一一对应，任务类路径都在 /api/tasks 下，账号在 /api/session 与 /api/auth 下，项目簿在 /api/project-book 下，旧数据导入在 /api/legacy-import 下，扩展配对在 /api/extension/pairing 下', () => {
    expect([...endpointActionNames()].sort()).toEqual([...ACTION_NAMES].sort());
    const book = new Set(['getProjectBook', 'intakeProject', 'editProject', 'deactivateProject', 'restoreProject', 'deleteProject']);
    const auth = new Set(['setupAdmin', 'register', 'login', 'logout', 'changePassword']);
    const admin = new Set(['listAccounts', 'updateAccount']);
    const publicBook = new Set(['getPublicProjectBook', 'intakePublicProject', 'editPublicProject', 'confirmPublicProjectConversion', 'deactivatePublicProject', 'restorePublicProject', 'deletePublicProject']);
    const legacy = new Set(['getLegacyImport', 'retryLegacyImport', 'skipLegacyImport']);
    const extension = new Set(['getExtensionPairing', 'createExtensionPairingCode', 'revokeExtensionPairing']);
    for (const [name, endpoint] of Object.entries(HTTP_ENDPOINTS)) {
      const prefix =
        name === 'getSession'
          ? '/api/session'
          : auth.has(name)
            ? '/api/auth/'
            : name === 'resetAll'
              ? '/api/reset'
              : book.has(name)
                ? '/api/project-book'
                : admin.has(name)
                  ? '/api/admin/'
                  : publicBook.has(name)
                    ? '/api/public-project-book'
                    : legacy.has(name)
                      ? '/api/legacy-import'
                      : extension.has(name)
                        ? '/api/extension/pairing'
                        : '/api/tasks';
      expect(endpoint.path.startsWith(prefix), name).toBe(true);
    }
    expect(HTTP_ENDPOINTS.uploadBatch.body).toBe('multipart');
    expect(HTTP_ENDPOINTS.addPaymentScreenshot.body).toBe('multipart');
    expect(HTTP_ENDPOINTS.subscribe.body).toBe('sse');
  });
});

describe('个人项目簿 /api/project-book', () => {
  const book = { projects: INITIAL_BOOK.map((project) => annotateProject(project, MOCK_TODAY)) };

  test('GET 接受契约形状的项目簿；缺状态标签或非 2xx 被拒绝', () => {
    expect(parseProjectBookResponse(200, wire(book)).projects).toHaveLength(6);
    expect(parseProjectBookResponse(200, wire({ projects: [] })).projects).toEqual([]);
    const bad = wire(book) as { projects: { statusLabel?: string }[] };
    delete bad.projects[0]!.statusLabel;
    expect(() => parseProjectBookResponse(200, bad)).toThrow();
    expect(() => parseProjectBookResponse(500, wire(book))).toThrow(/HTTP 500/);
  });

  test('离线录入：200 的结果（含 rejected）原样交给页面；请求失败带 error 与可选项目簿；未知状态被拒绝', () => {
    const rejected = { status: 'rejected', verdict: null, note: '请填写项目名称。', book };
    const ok = parseProjectBookActionResponse(200, wire(rejected));
    expect(ok.ok && ok.result.status).toBe('rejected');
    const unknown = parseProjectBookActionResponse(200, wire({ ...rejected, status: 'maybe' }));
    expect(!unknown.ok && unknown.error.code).toBe(INVALID_RESPONSE_CODE);
    const failed = parseProjectBookActionResponse(503, wire({ error: { code: 'down', message: '服务没有响应' }, book }));
    expect(!failed.ok && failed.error.message).toBe('服务没有响应');
    expect(!failed.ok && failed.book?.projects).toHaveLength(6);
    const bare = parseProjectBookActionResponse(500, null);
    expect(!bare.ok && bare.error.code).toBe('http_500');
  });

  test('编辑请求带上原项目号、建议项目号和名称，并接受 edited 结果', async () => {
    const response = { status: 'edited', verdict: null, note: '已修改', book: { projects: [] } };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
    try {
      const outcome = await createHttpAdapter({ baseUrl: 'http://local' }).editProject({ originalNumber: 'OLD-1', number: 'NEW-1', name: '新名称' });
      expect(fetchMock).toHaveBeenCalledWith('http://local/api/project-book/edit', {
        method: 'POST',
        body: JSON.stringify({ originalNumber: 'OLD-1', number: 'NEW-1', name: '新名称' }),
        headers: { 'content-type': 'application/json' },
      });
      expect(outcome).toMatchObject({ ok: true, result: { status: 'edited' } });
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe('任务列表 GET /api/tasks', () => {
  const list = { homeCity: { value: '杭州', source: 'remembered' }, tasks: [t1Snapshot('done'), t2Snapshot(), t3Snapshot()].map(toListItem) };

  test('接受契约形状的列表', () => {
    expect(parseTaskListResponse(200, wire(list)).tasks).toHaveLength(3);
    expect(parseTaskListResponse(200, wire({ homeCity: null, tasks: [] })).tasks).toEqual([]);
  });

  test('拒绝金额格式不对、缺字段或非 2xx', () => {
    const badAmount = wire(list) as { tasks: { grossTotal: string }[] };
    badAmount.tasks[0]!.grossTotal = '3972.5';
    expect(() => parseTaskListResponse(200, badAmount)).toThrow();
    expect(() => parseTaskListResponse(200, { tasks: [] })).toThrow();
    expect(() => parseTaskListResponse(500, wire(list))).toThrow(/HTTP 500/);
  });

  test('401 表示会话失效：抛出 UnauthenticatedError，仓库据此回到登录', () => {
    expect(() => parseTaskListResponse(401, wire({ error: { code: 'unauthenticated', message: '请先登录。' } }))).toThrow(expect.objectContaining({ name: 'UnauthenticatedError' }));
    expect(() => parseSnapshotResponse(401, null)).toThrow(expect.objectContaining({ name: 'UnauthenticatedError' }));
  });
});

describe('应用账号 /api/session 与 /api/auth/*', () => {
  const signedIn = { status: 'signed_in', account: { accountId: 'a1', username: '林颂宜', role: 'admin' } };

  test('会话：接受三种状态；角色只有 user 与 admin', () => {
    expect(parseSessionResponse(200, wire({ status: 'setup_required', account: null })).status).toBe('setup_required');
    expect(parseSessionResponse(200, wire(signedIn)).account?.role).toBe('admin');
    expect(() => parseSessionResponse(200, wire({ ...signedIn, account: { ...signedIn.account, role: 'root' } }))).toThrow();
    expect(() => parseSessionResponse(500, null)).toThrow(/HTTP 500/);
  });

  test('账号动作：成功是新会话；失败带原因；其余拒绝', () => {
    const ok = parseAuthResponse(200, wire(signedIn));
    expect(ok.ok && ok.session.account?.username).toBe('林颂宜');
    const refused = parseAuthResponse(401, wire({ error: { code: 'invalid_credentials', message: '用户名或密码不对。' } }));
    expect(!refused.ok && refused.error.code).toBe('invalid_credentials');
    // Auth refusals the server answers with 409 (setup_done, setup_required, username_taken) keep their own code:
    // only task actions map 409 to stale_step.
    const setupDone = parseAuthResponse(409, wire({ error: { code: 'setup_done', message: '管理员已经创建。' } }));
    expect(!setupDone.ok && setupDone.error.code).toBe('setup_done');
    expect(parseAuthResponse(200, { status: 'maybe' }).ok).toBe(false);
    const unknown = parseAuthResponse(500, 'oops');
    expect(!unknown.ok && unknown.error.code).toBe('http_500');
  });
});

describe('作废与重置 POST /api/tasks/:id/abandon、/api/reset', () => {
  const list = { homeCity: null, tasks: [] };

  test('成功返回整份任务列表；失败带原因与可选的最新列表；其余拒绝', () => {
    const ok = parseTaskListActionResponse(200, wire(list));
    expect(ok.ok && ok.taskList.tasks).toEqual([]);
    const failed = parseTaskListActionResponse(409, wire({ error: { code: 'not_abandonable', message: '不能作废' }, taskList: list }));
    expect(failed.ok).toBe(false);
    expect(!failed.ok && failed.error.message).toBe('不能作废');
    expect(!failed.ok && failed.taskList?.tasks).toEqual([]);
    const bare = parseTaskListActionResponse(400, wire({ error: { code: 'task_not_found', message: '没有' } }));
    expect(!bare.ok && bare.taskList).toBeNull();
    expect(parseTaskListActionResponse(200, { tasks: [] }).ok).toBe(false);
    const unknown = parseTaskListActionResponse(500, 'oops');
    expect(!unknown.ok && unknown.error.code).toBe('http_500');
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

  test('409 erp_in_use：报销系统正被另一个任务使用，保留错误码与原因，不当作 stale_step', () => {
    const outcome = parseActionResponse(409, { error: { code: 'erp_in_use', message: ERP_ACTION_ERRORS.inUse }, snapshot: wire(t1Snapshot('actions')) });
    expect(outcome).toMatchObject({ ok: false, error: { code: 'erp_in_use', message: ERP_ACTION_ERRORS.inUse } });
    if (!outcome.ok) expect(outcome.snapshot?.stage).toBe('actions');
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
