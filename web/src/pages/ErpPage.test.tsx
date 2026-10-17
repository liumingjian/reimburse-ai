import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { HANDOVER_COMPLETED_NOTICE } from '@baox/contract';
import { App } from '../App';
import { createMockAdapter, type Fault } from '../mock/mock-adapter';

const STEP_TITLES = ['打开报销系统标签页', '登录', '报销信息核对', '打开空白报销单', '导入发票', '收票回读', '填写明细', '交接单据'];

// ?seed=erp has opened the task's ERP tab and is waiting for login. There is no separate start action.
function renderErp(fault: Fault | null = null, erpLoginAutoMs = 60_000) {
  window.location.hash = '#/task/T1/erp';
  const adapter = createMockAdapter({ seed: 'erp', fault, erpStepMs: 5, erpLoginAutoMs });
  render(<App adapter={adapter} />);
  return adapter;
}

const progress = () => screen.getByRole('region', { name: '填报进度' });
const stepItem = (title: string) => within(progress()).getByRole('listitem', { name: title });
const loginButton = () => screen.findByRole('button', { name: '我已登录，继续' });

async function waitingLogin() {
  await screen.findByRole('heading', { name: '填写报销单' });
  return loginButton();
}

describe('ERP 填报', () => {
  test('登录等待时可以「取消去报销」：回传 stepToken，回到整单确认页，可以再去报销', async () => {
    const adapter = renderErp();
    const cancel = vi.spyOn(adapter, 'cancelErpWrite');
    await waitingLogin();
    const { stepToken } = (await adapter.getSnapshot('T1')).step;
    fireEvent.click(screen.getByRole('button', { name: '取消去报销' }));
    expect(cancel).toHaveBeenCalledWith('T1', stepToken);
    await vi.waitFor(async () => expect((await adapter.getSnapshot('T1')).stage).toBe('actions'));
    const after = await adapter.getSnapshot('T1');
    expect(after).toMatchObject({ step: { kind: 'choose_action' }, erp: { status: 'idle' } });
    await vi.waitFor(() => expect(window.location.hash).toBe('#/task/T1/review'));
  });

  test('刷新状态只读取已记录的登录等待，不会再次去报销、填写或保存', async () => {
    const adapter = renderErp();
    const getSnapshot = vi.spyOn(adapter, 'getSnapshot');
    const start = vi.spyOn(adapter, 'startErpWrite');
    const confirm = vi.spyOn(adapter, 'confirmLogin');
    await waitingLogin();
    const before = await adapter.getSnapshot('T1');
    expect(before.erp).toMatchObject({
      currentStage: 'login',
      externalWait: 'employee_login',
      outcome: 'none',
      allowedActions: ['refresh', 'confirm_login', 'cancel'],
    });
    getSnapshot.mockClear();

    fireEvent.click(screen.getByRole('button', { name: '刷新状态' }));
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledWith('T1'));
    expect(start).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();

    const after = await adapter.getSnapshot('T1');
    expect(after).toMatchObject({ revision: before.revision, step: before.step, erp: before.erp });
  });

  // 写入前就停下的作业退回 actions，比 erp 早，于是这一页当场关上、换成守卫页。报销系统前进到 done / reconcile
  // 时不会这样（那两个阶段在 erp 之后，本页仍开放），所以只有这一种停下会把人撞到守卫页上。
  test('写入前就停下：关上的填报页说出停下的原因，不是一句「阶段不可跳过」', async () => {
    const adapter = renderErp('erp-stopped-before-write');
    fireEvent.click(await waitingLogin());

    await vi.waitFor(async () => expect((await adapter.getSnapshot('T1')).stage).toBe('actions'));
    const after = await adapter.getSnapshot('T1');
    expect(after.erp).toMatchObject({ status: 'idle', abortReason: expect.stringContaining('报销系统的版本') });

    expect(await screen.findByRole('heading', { name: '这次去报销停下了' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '还不能进入这一步' })).toBeNull();
    expect(screen.getByRole('link', { name: '回到当前阶段' }).getAttribute('href')).toBe('#/task/T1/review');

    // 回到整单确认页：原因也写在那里，而且可以直接再去报销。
    window.location.hash = '#/task/T1/review';
    expect((await screen.findByTestId('erp-abort-reason')).textContent).toBe(after.erp.abortReason);
    expect((await screen.findByRole('button', { name: '去报销' })).hasAttribute('disabled')).toBe(false);
  });

  test('页头没有孤立的「返回确认页」', async () => {
    renderErp();
    await waitingLogin();
    expect(screen.queryByRole('link', { name: '返回确认页' })).toBeNull();
  });

  test('八个事实阶段按顺序可见、没有「开始填报」；登录步有「我已登录，继续」并回传 stepToken；登录后自动写完，完成页显示交接事实与逐条回读 9/9 一致', async () => {
    const adapter = renderErp();
    const confirmLogin = vi.spyOn(adapter, 'confirmLogin');
    const button = await waitingLogin();
    expect(within(progress()).getAllByRole('listitem').map((item) => item.getAttribute('aria-label'))).toEqual(STEP_TITLES);
    expect(screen.queryByRole('button', { name: '开始填报' })).toBeNull();
    expect(stepItem('打开报销系统标签页').textContent).toContain('完成');
    expect(stepItem('登录').textContent).toContain('等待你登录');
    expect(stepItem('导入发票').textContent).not.toContain('完成');

    const { stepToken } = (await adapter.getSnapshot('T1')).step;
    fireEvent.click(button);
    expect(confirmLogin).toHaveBeenCalledWith('T1', stepToken);

    expect(await screen.findByRole('link', { name: '查看完成结果' })).toBeTruthy();
    for (const title of STEP_TITLES) expect(stepItem(title).textContent).toContain('完成');

    window.location.hash = '#/task/T1/done';
    expect(await screen.findByRole('heading', { name: '完成' })).toBeTruthy();
    // ADR-0028：交接时单据还没有保存，所以完成页没有单据编号。
    expect(screen.getByTestId('draft-no').textContent).toBe('尚无');
    expect(screen.getByTestId('erp-account').textContent).toBe('林颂宜（lin.songyi）');
    expect(screen.getByTestId('erp-tenant').textContent).toBe('安图特科技');
    expect(screen.getByText('明细 9/9 一致')).toBeTruthy();
    expect(screen.getByTestId('handover-completed').textContent).toBe(HANDOVER_COMPLETED_NOTICE);
    expect(screen.queryByTestId('human-review')).toBeNull();
    const table = screen.getByRole('table', { name: '逐条回读' });
    const bodyRows = within(table).getAllByRole('row').filter((row) => row.closest('tbody'));
    expect(bodyRows).toHaveLength(9);
    for (const row of bodyRows) {
      expect(within(row).queryByText('不一致')).toBeNull();
      expect(within(row).getByText('一致')).toBeTruthy();
    }
    // 回读行用同一个统一业务序号：No.1 是外地市内交通的首条，住宿排最后。
    expect(screen.getByTestId('readback-1').textContent).toContain('高德 · 虹桥枢纽 → 漕河泾');
    expect(screen.getByTestId('readback-9').textContent).toContain('全季酒店 13 晚');
    expect(screen.getByTestId('readback-local-total').textContent).toBe('3972.59');
    expect(screen.getByTestId('readback-erp-total').textContent).toBe('3972.59');
  });

  test('登录等待状态在步骤清单之前说明等待什么，未开始步骤的编号照常显示', async () => {
    renderErp();
    await waitingLogin();
    const notice = screen.getByText('等待你在报销系统标签页登录。');
    expect(notice.closest('[role="status"]')).toBeTruthy();
    expect(notice.compareDocumentPosition(progress()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(stepItem('导入发票').textContent).toContain('5');
  });

  test('从整单确认页点「去报销」：打开报销系统标签页后等待登录，服务端自己探测到登录也会自动写完', async () => {
    window.location.hash = '#/task/T1/review';
    const adapter = createMockAdapter({ seed: 'actions', fault: null, erpStepMs: 5, erpLoginAutoMs: 20 });
    const start = vi.spyOn(adapter, 'startErpWrite');
    render(<App adapter={adapter} />);
    fireEvent.click(await screen.findByRole('button', { name: '去报销' }));
    expect(await screen.findByRole('heading', { name: '填写报销单' })).toBeTruthy();
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '开始填报' })).toBeNull();
    expect(await screen.findByRole('link', { name: '查看完成结果' })).toBeTruthy();
  });

  test('erp-login-missing：点了继续仍未检测到登录，提示留在原地并说明，按钮可以再按；第三次检测到后继续', async () => {
    renderErp('erp-login-missing');
    fireEvent.click(await waitingLogin());
    expect(await screen.findByText(/还没有检测到登录（第 1 次检测）/)).toBeTruthy();
    expect(stepItem('登录').textContent).toContain('等待你登录');
    const again = (await loginButton()) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    fireEvent.click(again);
    expect(await screen.findByText(/还没有检测到登录（第 2 次检测）/)).toBeTruthy();
    fireEvent.click(await loginButton());
    expect(await screen.findByRole('link', { name: '查看完成结果' })).toBeTruthy();
  });

  test('erp-write-aborted：交接时没有读到结果后自动进入对账页（替换历史记录），显示中止原因与对账入口', async () => {
    renderErp('erp-write-aborted');
    fireEvent.click(await waitingLogin());
    expect(await screen.findByRole('heading', { name: '对账' })).toBeTruthy();
    expect(window.location.hash).toBe('#/task/T1/reconcile');
    expect(within(screen.getByRole('region', { name: '中止原因' })).getByText(/保存后没有读到报销系统的结果/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '开始对账' })).toBeTruthy();
  });

  test('直接打开已中止任务的 ERP 填报页不跳转，保留「进入对账」入口', async () => {
    window.location.hash = '#/task/T1/erp';
    render(<App adapter={createMockAdapter({ seed: 'reconcile', fault: null })} />);
    expect(await screen.findByRole('heading', { name: '填写报销单' })).toBeTruthy();
    expect(stepItem('交接单据').textContent).toContain('已中止');
    expect(screen.getByRole('alert').textContent).toContain('写入报销系统已停止');
    expect(screen.getByRole('link', { name: '进入对账' }).getAttribute('href')).toBe('#/task/T1/reconcile');
  });

  // 严格回读不一致：写入停下、结果不确定，先停在对账等第一次对账（服务端同此）。对账读到已保存但逐行不一致的草稿，
  // 它没有被证明与确认过的明细一致，所以仍停在对账而不是完成：done 只留给「已保存且逐行一致」，服务端也从不把它投影成 done。
  test('readback-mismatch：写入停下后进入对账页；开始对账后差异行高亮、显示人工核对固定句；只能转人工（带 stepToken），任务列表也显示已转人工', async () => {
    const adapter = renderErp('readback-mismatch');
    const handOff = vi.spyOn(adapter, 'handOff');
    fireEvent.click(await waitingLogin());
    expect(await screen.findByRole('heading', { name: '对账' })).toBeTruthy();
    expect(window.location.hash).toBe('#/task/T1/reconcile');
    expect(within(screen.getByRole('region', { name: '中止原因' })).getByText(/合计 3999.59 与任务合计 3972.59 不一致/)).toBeTruthy();
    expect(screen.getByTestId('reconcile-bucket').textContent).toBe('尚未判定');
    fireEvent.click(screen.getByRole('button', { name: '开始对账' }));
    expect(await screen.findByTestId('readback-6')).toBeTruthy();
    expect(screen.getByTestId('reconcile-draft-no').textContent).toBe('BX20260911-0173');
    expect(screen.getByTestId('reconcile-bucket').textContent).toBe('已保存');
    const bad = screen.getByTestId('readback-6');
    expect(within(bad).getByText('不一致')).toBeTruthy();
    expect(within(bad).getByText('74.00')).toBeTruthy();
    expect(within(screen.getByTestId('readback-5')).queryByText('不一致')).toBeNull();
    expect(screen.getByText('报销系统中存在草稿 BX20260911-0173，9 行明细中 8 行一致，1 行不一致。')).toBeTruthy();
    // 已保存但逐行不一致 ⇒ 转人工（human_review）：固定句，且不给「重新对账」。
    expect(screen.getByTestId('human-review').textContent).toBe('当前报销已暂停，材料和状态已保留。请在报销系统中核对；如无法判断，请联系报销管理员。');
    expect(screen.queryByRole('button', { name: '重新对账' })).toBeNull();
    // 不一致的行展开后逐项列出对不上的字段与原因。
    expect(screen.queryByTestId('readback-detail-6')).toBeNull();
    fireEvent.click(within(bad).getByRole('button', { name: '展开 No.6' }));
    const detail = screen.getByTestId('readback-detail-6');
    expect(within(detail).getByRole('list', { name: 'No.6 对不上的字段' }).textContent).toBe('申请报销金额 本地 47.00 / 报销系统 74.00');
    expect(within(detail).getByRole('list', { name: 'No.6 原因' }).textContent).toContain('任务第 6 行没有一条同时匹配项目、费用项目、日期、金额和收票关联的报销系统明细');
    fireEvent.click(within(bad).getByRole('button', { name: '收起 No.6' }));
    expect(screen.queryByTestId('readback-detail-6')).toBeNull();

    const { stepToken } = (await adapter.getSnapshot('T1')).step;
    fireEvent.click(screen.getByRole('button', { name: '转人工' }));
    expect(await screen.findByText(/已转人工处理：应用不再写入报销系统/)).toBeTruthy();
    expect(handOff).toHaveBeenCalledWith('T1', stepToken);
    expect(screen.queryByRole('button', { name: '转人工' })).toBeNull();

    window.location.hash = '#/tasks';
    const row = await screen.findByRole('row', { name: /2026-08 上海出差（产品评审）/ });
    expect(await within(row).findByText('已转人工')).toBeTruthy();
  });

  test('自动重新去报销时说明这是应用自己换了一张新单，第几次', async () => {
    window.location.hash = '#/task/T1/erp';
    const adapter = createMockAdapter({ seed: 'erp', fault: null, erpStepMs: 5, erpLoginAutoMs: 60_000 });
    const original = adapter.getSnapshot.bind(adapter);
    const notice = '上一次没有填完，应用已自动换一张新单重新填报（第 1 次）。';
    vi.spyOn(adapter, 'getSnapshot').mockImplementation(async (taskId) => {
      const snapshot = await original(taskId);
      return { ...snapshot, erp: { ...snapshot.erp, rerunNotice: notice } };
    });
    render(<App adapter={adapter} />);
    expect((await screen.findByTestId('erp-rerun-notice')).textContent).toContain(notice);
    expect(notice).not.toMatch(/ERP|重试|[\u2013\u2014]/);
  });
});

// 去报销 on the 本地执行器 ended in ERP 草稿已交接 (ticket #407): the page says, in one short line, that the bill is only
// 暂存'd and the employee submits it, and takes them to the 报销系统 the draft was written to. The address and the 内码
// are the snapshot's `erp.review`; the page never works them out.
describe('去报销系统查看暂存单', () => {
  const REVIEW = { url: 'https://erp.example.test/k3cloud/html5/index.aspx', draftId: '119946' };

  function renderDone(review: typeof REVIEW | null) {
    window.location.hash = '#/task/T1/erp';
    const adapter = createMockAdapter({ seed: 'erp', fault: null, erpStepMs: 5, erpLoginAutoMs: 60_000 });
    const original = adapter.getSnapshot.bind(adapter);
    vi.spyOn(adapter, 'getSnapshot').mockImplementation(async (taskId) => {
      const snapshot = await original(taskId);
      return { ...snapshot, erp: { ...snapshot.erp, status: 'done', outcome: review ? 'drafted' : 'filled', externalWait: 'none', review } };
    });
    render(<App adapter={adapter} />);
  }

  const HINT = '在新标签页打开报销系统，用你自己的账号登录后，到「我的费用报销」里按内码找到这张暂存单。';
  const COPIED = '内码已复制，可以粘贴到报销系统里查找这张暂存单。';
  const COPY_BY_HAND = '没能复制，请选中上面的内码手动复制。';

  // navigator.clipboard and document.execCommand as one test sets them, put back afterwards so no later test inherits
  // them. jsdom has neither, as the deployed app over plain http has no clipboard API.
  const restores: Array<() => void> = [];
  function stub(target: object, key: string, value: unknown) {
    const own = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { value, configurable: true, writable: true });
    restores.push(() => (own ? Object.defineProperty(target, key, own) : Reflect.deleteProperty(target, key)));
  }
  afterEach(() => {
    while (restores.length > 0) restores.pop()!();
  });

  test('暂存后：短提示、新标签页打开报销系统的按钮、内码和复制按钮', async () => {
    const writeText = vi.fn(async () => undefined);
    stub(navigator, 'clipboard', { writeText });
    renderDone(REVIEW);

    const notice = '已暂存到报销系统，请打开检查，确认无误后由你自己提交。';
    expect((await screen.findByTestId('handover-completed')).textContent).toBe(notice);
    const open = screen.getByRole('link', { name: '去报销系统查看' });
    expect(open.getAttribute('href')).toBe(REVIEW.url);
    expect(open.getAttribute('target')).toBe('_blank');
    expect(open.getAttribute('rel')).toContain('noopener');
    const review = screen.getByTestId('erp-review');
    expect(within(review).getByTestId('erp-review-draft-id').textContent).toBe('119946');
    expect(within(review).getByText(HINT)).toBeTruthy();
    fireEvent.click(within(review).getByRole('button', { name: '复制内码' }));
    expect(await within(review).findByText(COPIED)).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith('119946');
    expect(review.textContent + notice + HINT).not.toMatch(/ERP|重试|[\u2013\u2014]/);
  });

  test('没有剪贴板接口（内网 http 打开）：改用选中复制，照样复制成功', async () => {
    stub(navigator, 'clipboard', undefined);
    const execCommand = vi.fn(() => true);
    stub(document, 'execCommand', execCommand);
    renderDone(REVIEW);

    const review = await screen.findByTestId('erp-review');
    fireEvent.click(within(review).getByRole('button', { name: '复制内码' }));

    expect(await within(review).findByText(COPIED)).toBeTruthy();
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  test('两种复制都不行：请员工手动选中内码复制', async () => {
    stub(navigator, 'clipboard', { writeText: vi.fn(async () => { throw new Error('denied'); }) });
    stub(document, 'execCommand', vi.fn(() => false));
    renderDone(REVIEW);

    const review = await screen.findByTestId('erp-review');
    fireEvent.click(within(review).getByRole('button', { name: '复制内码' }));

    expect(await within(review).findByText(COPY_BY_HAND)).toBeTruthy();
    expect(within(review).getByTestId('erp-review-draft-id').textContent).toBe('119946');
    expect(COPY_BY_HAND).not.toMatch(/ERP|重试|[\u2013\u2014]/);
  });

  test('没有暂存单时不出现查看按钮和内码', async () => {
    renderDone(null);

    expect(await screen.findByTestId('handover-completed')).toBeTruthy();
    expect(screen.queryByRole('link', { name: '去报销系统查看' })).toBeNull();
    expect(screen.queryByTestId('erp-review')).toBeNull();
  });
});

// 写入结果不确定 after a 暂存 whose 内码 is known (ticket #408, e.g. a draft 回读 mismatch): the existing reason stays,
// and the page adds that the 暂存单 exists but its check failed, with the same button and 内码.
describe('写入结果不确定但暂存单内码已知', () => {
  const REVIEW = { url: 'https://erp.example.test/k3cloud/html5/index.aspx', draftId: '119985' };
  const REASON = '写入报销系统的结果不确定，应用已停止写入，不会重放。原因：暂存单（内码 119985）和填写时回读的不一致：申请报销金额 1000.00 与 1006.00 不同';
  const NOTICE = '暂存单已生成但核对没通过，请打开检查。';

  function renderUnknown(review: typeof REVIEW | null) {
    window.location.hash = '#/task/T1/erp';
    const adapter = createMockAdapter({ seed: 'erp', fault: null, erpStepMs: 5, erpLoginAutoMs: 60_000 });
    const original = adapter.getSnapshot.bind(adapter);
    vi.spyOn(adapter, 'getSnapshot').mockImplementation(async (taskId) => {
      const snapshot = await original(taskId);
      return { ...snapshot, erp: { ...snapshot.erp, status: 'aborted', outcome: 'none', externalWait: 'none', abortReason: REASON, review } };
    });
    render(<App adapter={adapter} />);
  }

  test('原因还在，另有一句核对没通过的提示、去报销系统查看按钮和内码', async () => {
    renderUnknown(REVIEW);

    expect(await screen.findByText(`写入报销系统已停止：${REASON}`)).toBeTruthy();
    expect(screen.getByTestId('erp-review-notice').textContent).toBe(NOTICE);
    const open = screen.getByRole('link', { name: '去报销系统查看' });
    expect(open.getAttribute('href')).toBe(REVIEW.url);
    expect(open.getAttribute('target')).toBe('_blank');
    expect(open.getAttribute('rel')).toContain('noopener');
    const review = screen.getByTestId('erp-review');
    expect(within(review).getByTestId('erp-review-draft-id').textContent).toBe('119985');
    expect(within(review).getByRole('button', { name: '复制内码' })).toBeTruthy();
    expect(review.textContent + NOTICE).not.toMatch(/ERP|重试|[\u2013\u2014]/);
  });

  test('不知道暂存单内码时只有原因，没有提示和按钮', async () => {
    renderUnknown(null);

    expect(await screen.findByText(`写入报销系统已停止：${REASON}`)).toBeTruthy();
    expect(screen.queryByTestId('erp-review-notice')).toBeNull();
    expect(screen.queryByRole('link', { name: '去报销系统查看' })).toBeNull();
  });
});

// 去报销进度 (#420): the bar names the current step and shows a percentage, both from the snapshot's `erp.progress`.
// The page computes nothing: no share of its own and no time left.
describe('去报销进度条', () => {
  const bar = () => screen.getByTestId('erp-progress');

  test('打开页面就显示当前这一步和百分比（来自快照，刷新页面后也一样）', async () => {
    const adapter = renderErp();
    await waitingLogin();
    const { erp } = await adapter.getSnapshot('T1');
    expect(erp.progress).toMatchObject({ label: '登录' });
    expect(screen.getByTestId('erp-progress-label').textContent).toBe('登录');
    expect(screen.getByTestId('erp-progress-percent').textContent).toBe(`${erp.progress!.percent}%`);
    expect(within(bar()).getByRole('progressbar').getAttribute('aria-valuenow')).toBe(String(erp.progress!.percent));
  });

  test('填写明细时逐行前进，「填写明细 n/m」，完成时才到 100%', async () => {
    const adapter = renderErp();
    const pushed: Array<{ label: string; percent: number; status: string }> = [];
    adapter.subscribe('T1', (event) => {
      if (event.type === 'snapshot' && event.snapshot.erp.progress) pushed.push({ ...event.snapshot.erp.progress, status: event.snapshot.erp.status });
    });
    fireEvent.click(await waitingLogin());
    // testing-library 的 waitFor 用 setup.ts 配的 5 秒上限；vi.waitFor 默认只等 1 秒，Mac 忙时走不完 mock 流程。
    await waitFor(() => expect(screen.getByTestId('erp-progress-percent').textContent).toBe('100%'));
    const rows = (await adapter.getSnapshot('T1')).lines.length;
    const filling = pushed.map((p) => p.label).filter((label) => label.startsWith('填写明细'));
    expect([...new Set(filling)]).toEqual(Array.from({ length: rows + 1 }, (_, n) => `填写明细 ${n}/${rows}`));
    const percents = pushed.map((p) => p.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(pushed.filter((p) => p.percent === 100).every((p) => p.status === 'done')).toBe(true);
    expect(pushed.filter((p) => p.status !== 'done').every((p) => p.percent < 100)).toBe(true);
    expect(screen.getByTestId('erp-progress-label').textContent).toBe('交接单据');
  });

  test('显示快照给出的行进度，不估算剩余时间', async () => {
    window.location.hash = '#/task/T1/erp';
    const adapter = createMockAdapter({ seed: 'erp', fault: null, erpStepMs: 5, erpLoginAutoMs: 60_000 });
    const original = adapter.getSnapshot.bind(adapter);
    vi.spyOn(adapter, 'getSnapshot').mockImplementation(async (taskId) => {
      const snapshot = await original(taskId);
      return { ...snapshot, erp: { ...snapshot.erp, status: 'running', externalWait: 'erp_response', progress: { label: '填写明细 3/8', percent: 60 } } };
    });
    render(<App adapter={adapter} />);
    await waitFor(() => expect(screen.getByTestId('erp-progress-label').textContent).toBe('填写明细 3/8'));
    expect(screen.getByTestId('erp-progress-percent').textContent).toBe('60%');
    expect(bar().textContent).not.toMatch(/剩余|预计|分钟|秒|ERP|重试|[\u2013\u2014]/);
  });

  test('没有去报销作业时不显示进度条', async () => {
    window.location.hash = '#/task/T1/erp';
    const adapter = createMockAdapter({ seed: 'erp', fault: null, erpStepMs: 5, erpLoginAutoMs: 60_000 });
    const original = adapter.getSnapshot.bind(adapter);
    vi.spyOn(adapter, 'getSnapshot').mockImplementation(async (taskId) => ({ ...(await original(taskId)), erp: { ...(await original(taskId)).erp, progress: null } }));
    render(<App adapter={adapter} />);
    await waitingLogin();
    expect(screen.queryByTestId('erp-progress')).toBeNull();
  });
});

// 按路线的步骤文案 (#423): the page shows the step list of the route the job ran on, as the snapshot words it. The
// 本地执行器 starts a background browser, signs in with the saved account and ends 暂存'd; the 浏览器扩展 keeps its list.
describe('按路线的步骤文案', () => {
  const steps = () => within(progress()).getAllByRole('listitem').map((item) => [item.querySelector('.step-title')?.textContent, item.querySelector('.desc')?.textContent]);
  const MIDDLE = ['报销信息核对', '打开空白报销单', '导入发票', '收票回读', '填写明细'];

  test('本地执行器：第一步「启动后台浏览器」，登录用设置页保存的账号，最后一步「暂存到报销系统」，到 100% 时是核对暂存单', async () => {
    window.location.hash = '#/task/T1/review';
    render(<App adapter={createMockAdapter({ seed: 'actions', fault: null, erpStepMs: 5, erpRoute: 'local_executor' })} />);
    fireEvent.click(await screen.findByRole('button', { name: '去报销' }));
    await screen.findByRole('heading', { name: '填写报销单' });

    const shown = steps();
    expect(shown.map(([title]) => title)).toEqual(['启动后台浏览器', '登录', ...MIDDLE, '暂存到报销系统']);
    expect(shown[0]![1]).toBe('在你的电脑上启动一个看不见的浏览器，专门用于这次报销。');
    expect(shown[1]![1]).toBe('用你在设置页保存的报销系统账号登录。');
    expect(shown.at(-1)![1]).toBe('你检查后自己提交');
    expect(progress().textContent).not.toMatch(/浏览器扩展|标签页|交接单据|ERP|重试|[\u2013\u2014]/);

    // No login wait on this route: it runs through to the 暂存单.
    await waitFor(() => expect(screen.getByTestId('erp-progress-percent').textContent).toBe('100%'));
    expect(screen.getByTestId('erp-progress-label').textContent).toBe('核对暂存单');
    expect(screen.queryByRole('button', { name: '我已登录，继续' })).toBeNull();
    expect(steps().map(([title]) => title)).toEqual(['启动后台浏览器', '登录', ...MIDDLE, '暂存到报销系统']);
  });

  test('浏览器扩展：步骤清单不变，第一步打开报销系统标签页，最后一步交接单据', async () => {
    renderErp();
    await waitingLogin();

    const shown = steps();
    expect(shown.map(([title]) => title)).toEqual(STEP_TITLES);
    expect(shown[0]![1]).toBe('通过已配对的浏览器扩展，打开这次报销专用的报销系统标签页。');
    expect(shown[1]![1]).toBe('在为这次报销打开的报销系统标签页里使用本人账号登录。应用不会替你输入账号或密码。');
    expect(shown.at(-1)![1]).toBe('不点保存、不提交审批：严格回读逐行通过后，把填好的报销单交给你，由你自己点「保存」并按流程提交。');
    expect(progress().textContent).not.toMatch(/启动后台浏览器|暂存到报销系统/);
  });
});
