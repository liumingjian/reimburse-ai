import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { App } from '../App';
import { ALLOCATION_ERRORS, PAYMENT_SCREENSHOT_ERRORS, PENDING_ANSWER_ERRORS, STALE_STEP_NOTICE, STAY_TRIO_COPY } from '@baox/contract';
import { ALLOCATION_GIVE_UP_NOTE, GIVEN_UP_TITLE, givenUpNote } from '../mock/fixtures/inventory';
import { t1Snapshot } from '../mock/fixtures/tasks';
import { createMockAdapter } from '../mock/mock-adapter';
import type { Fault, MockOptions, SeedStage } from '../mock/options';
import { AppProvider } from '../adapter/context';
import { AppStore } from '../adapter/store';
import { PendingPage } from './PendingPage';

function renderPending(seed: SeedStage = 'pending', fault: Fault | null = null, extra: Partial<MockOptions> = {}) {
  window.location.hash = '#/task/T1/pending';
  const adapter = createMockAdapter({ ...extra, seed, fault, inventoryPhaseMs: 5 });
  render(<App adapter={adapter} />);
  return adapter;
}

// 盘点页与待确认项页不许出现规则名、字段来源 user 与「候选」。
const FORBIDDEN_TEXT = /rule:|user|候选/;

const list = () => screen.getByLabelText('待确认项清单');
const itemButton = (title: string) => within(screen.getByLabelText('待确认项清单')).getByRole('button', { name: new RegExp(`^${title}`) });
const itemByFile = (fileName: string) => within(screen.getByLabelText('待确认项清单')).getByRole('button', { name: new RegExp(fileName) });
const detail = () => screen.getByLabelText('待确认项详情');

function fill(label: string, value: string) {
  fireEvent.change(within(detail()).getByLabelText(label), { target: { value } });
}

describe('待确认项', () => {
  test('左侧列出全部待确认项，右侧显示选中项的原件预览与字段；切换选中项预览随之切换', async () => {
    renderPending();
    expect(await screen.findByRole('heading', { name: '待确认项' })).toBeTruthy();
    expect(screen.getByText('对照原件补填或作出选择。还剩 4 个。')).toBeTruthy();
    expect(list()).toBeTruthy();
    const buttons = within(screen.getByLabelText('待确认项清单')).getAllByRole('button');
    // 每行只放图标、标题与文件名；契约里的处理人不显示。
    expect(buttons.map((button) => button.textContent)).toEqual([
      '补填起点与终点IMG_4871.jpg',
      '下车时间不合法，并补填起点与终点IMG_4906.jpg',
      '不支持的材料类型办公用品_发票.pdf',
      '住宿发票「全季酒店_发票.pdf」缺少支付截图',
    ]);

    // 默认选中第一个：出租车照片用 img 预览，显示读出的字段，但不显示字段来源。
    expect(within(detail()).getByRole('heading', { name: '补填起点与终点' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('处理人');
    expect(document.body.textContent).not.toContain('要你处理');
    // 文件名与材料类别是详情列表的头两行，不拼中点串。
    const details = within(detail()).getByLabelText('材料');
    expect(within(details).getByText('文件名').nextElementSibling?.textContent).toBe('IMG_4871.jpg');
    expect(within(details).getByText('材料类别')).toBeTruthy();
    expect(within(detail()).queryByText(/IMG_4871\.jpg ·/)).toBeNull();
    const photo = within(detail()).getByRole('img', { name: 'IMG_4871.jpg 原件' });
    expect(photo.getAttribute('src')).toBe('fixtures/m09-taxi-photo.jpg');
    expect(within(detail()).getByText('04213377')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(FORBIDDEN_TEXT);

    // 切到不支持的材料：jsdom 画不了 PDF，退回 iframe 预览；出现两种选择。
    fireEvent.click(itemButton('不支持的材料类型'));
    const frame = await within(detail()).findByTitle('办公用品_发票.pdf 原件');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('src')).toBe('fixtures/m12-office-supplies-invoice.pdf');
    expect(within(detail()).getByRole('button', { name: '排除此材料' })).toBeTruthy();
    expect(within(detail()).getByRole('button', { name: '自行手工处理' })).toBeTruthy();
  });

  test('表单校验：必填与 HH:MM 格式，非法值提交不到服务端', async () => {
    const adapter = renderPending();
    await screen.findByRole('heading', { name: '待确认项' });
    fireEvent.click(within(detail()).getByRole('button', { name: '保存并标记已处理' }));
    expect(within(detail()).getAllByRole('alert').map((node) => node.textContent).filter(Boolean)).toEqual([PENDING_ANSWER_ERRORS.required, PENDING_ANSWER_ERRORS.required]);
    expect(within(detail()).getByLabelText('起点 *').getAttribute('aria-invalid')).toBe('true');

    fireEvent.click(itemButton('下车时间不合法'));
    fill('下车时间 *', '90:60');
    fill('起点 *', '静安寺');
    fill('终点 *', '虹桥枢纽');
    fireEvent.click(within(detail()).getByRole('button', { name: '保存并标记已处理' }));
    expect(within(detail()).getAllByRole('alert').map((node) => node.textContent).filter(Boolean)).toEqual([PENDING_ANSWER_ERRORS.time]);
    fill('下车时间 *', '24:00');
    fireEvent.click(within(detail()).getByRole('button', { name: '保存并标记已处理' }));
    expect(within(detail()).getAllByRole('alert').map((node) => node.textContent).filter(Boolean)).toEqual([PENDING_ANSWER_ERRORS.time]);

    // 服务端状态没有动。
    const snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.pendingItems.every((item) => item.status === 'open')).toBe(true);
  });

  test('逐项答复：补填后跳到下一项，页面不显示字段来源；排除不支持的材料后显示没有待确认项了', async () => {
    const adapter = renderPending();
    await screen.findByRole('heading', { name: '待确认项' });
    fill('起点 *', '张江高科');
    fill('终点 *', '漕河泾开发区');
    fireEvent.click(within(detail()).getByRole('button', { name: '保存并标记已处理' }));
    expect(await within(detail()).findByRole('heading', { name: '下车时间不合法，并补填起点与终点' })).toBeTruthy();
    expect(screen.getByText('对照原件补填或作出选择。还剩 3 个。')).toBeTruthy();
    // 已处理行带绿色「已处理」标签；未处理的行没有。
    expect(within(itemButton('补填起点与终点')).getByText('已处理')).toBeTruthy();
    expect(within(itemButton('下车时间不合法')).queryByText('已处理')).toBeNull();
    expect(document.body.textContent).not.toContain('要你处理');

    // 已处理的项可以回看：显示答复；补填的字段服务端记为用户来源，但页面不显示来源。
    fireEvent.click(itemButton('补填起点与终点'));
    expect((within(detail()).getByLabelText('起点 *') as HTMLInputElement).value).toBe('张江高科');
    expect(within(detail()).getByLabelText('起点 *').hasAttribute('disabled')).toBe(true);
    expect(document.body.textContent).not.toMatch(FORBIDDEN_TEXT);

    fireEvent.click(itemButton('下车时间不合法'));
    fill('下车时间 *', '19:06');
    fill('起点 *', '静安寺');
    fill('终点 *', '虹桥枢纽');
    fireEvent.click(within(detail()).getByRole('button', { name: '保存并标记已处理' }));
    expect(await within(detail()).findByRole('heading', { name: '不支持的材料类型' })).toBeTruthy();

    fireEvent.click(within(detail()).getByRole('button', { name: '排除此材料' }));
    expect(await within(detail()).findByRole('heading', { name: STAY_TRIO_COPY.screenshot.title('全季酒店_发票.pdf') })).toBeTruthy();

    // Complete the seeded legacy screenshot group; the invoice remains in the expense lines.
    await adapter.completePaymentScreenshots('T1', 'm01');
    expect(await screen.findByRole('heading', { name: '没有待确认项了' })).toBeTruthy();
    expect(screen.getByText('本次盘点的 4 个待确认项都已处理。')).toBeTruthy();
    const link = screen.getByRole('link', { name: '进入项目归属' });
    expect(link.getAttribute('href')).toBe('#/task/T1/project');

    // 答复都到了服务端：来源 user、材料已排除、形成候选明细并进入项目归属（整单确认在项目归属之后）。
    const snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.stage).toBe('project');
    expect(snapshot.step.kind).toBe('assign_projects');
    expect(snapshot.pendingItems.map((item) => item.answer)).toEqual([
      { origin: '张江高科', destination: '漕河泾开发区' },
      { alightTime: '19:06', origin: '静安寺', destination: '虹桥枢纽' },
      { choice: 'exclude' },
      null,
    ]);
    const taxi = snapshot.materials.find((material) => material.materialId === 'm09');
    expect(taxi?.fields.find((candidate) => candidate.key === 'origin')).toMatchObject({ value: '张江高科', source: 'user', evidence: 'explicit' });
    expect(snapshot.materials.find((material) => material.materialId === 'm12')?.status).toBe('excluded');
    expect(snapshot.materials.find((material) => material.materialId === 'm01')?.status).toBe('ok');
    expect(snapshot.lines).toHaveLength(9);
    // The review's total only comes with its digest (after project assignment); here the lines carry it.
    expect(snapshot.confirmation.grossTotal).toBeNull();
    expect(snapshot.lines.reduce((sum, line) => sum + Math.round(Number(line.grossAmount) * 100), 0)).toBe(397259);

    // 进入项目归属不再被守卫拦住；整单确认页还不能进（项目归属未完成）。
    fireEvent.click(link);
    expect(await screen.findByRole('heading', { name: '项目归属' })).toBeTruthy();
    window.location.hash = '#/task/T1/review';
    expect(await screen.findByText('阶段不可跳过，请按顺序完成前面的步骤。')).toBeTruthy();
  });

  test('自行手工处理同样推进', async () => {
    renderPending();
    await screen.findByRole('heading', { name: '待确认项' });
    fireEvent.click(itemButton('不支持的材料类型'));
    fireEvent.click(within(detail()).getByRole('button', { name: '自行手工处理' }));
    await screen.findByText('对照原件补填或作出选择。还剩 3 个。');
    expect(itemButton('不支持的材料类型').textContent).toContain('已处理');
    // 回看已处理的选择：已选项是选中样式（aria-pressed），不是主按钮。
    fireEvent.click(itemButton('不支持的材料类型'));
    const manual = within(detail()).getByRole('button', { name: '自行手工处理' });
    expect(manual.getAttribute('aria-pressed')).toBe('true');
    expect(within(detail()).getByRole('button', { name: '排除此材料' }).getAttribute('aria-pressed')).toBe('false');
  });

  test('stepToken 过期：答复被拒，页面换成最新快照并提示任务已在别处推进', async () => {
    const adapter = renderPending();
    await screen.findByRole('heading', { name: '待确认项' });
    const before = await adapter.getSnapshot('T1');
    // 另一个窗口先处理了 p3；本页还拿着旧凭据。
    const elsewhere = await adapter.answerPendingItem('T1', 'p3', { choice: 'exclude' }, before.step.stepToken);
    expect(elsewhere.ok).toBe(true);
    fill('起点 *', '张江高科');
    fill('终点 *', '漕河泾开发区');
    fireEvent.click(within(detail()).getByRole('button', { name: '保存并标记已处理' }));
    expect(await screen.findByText(STALE_STEP_NOTICE)).toBeTruthy();
    await screen.findByText('对照原件补填或作出选择。还剩 3 个。');
    // p1 没有被采用（旧凭据的答复被忽略）。
    const after = await adapter.getSnapshot('T1');
    expect(after.pendingItems.find((item) => item.itemId === 'p1')?.status).toBe('open');
    expect(after.pendingItems.find((item) => item.itemId === 'p3')?.status).toBe('resolved');
  });

  test('?seed=review 打开待确认项页直接是空状态', async () => {
    renderPending('review');
    expect(await screen.findByRole('heading', { name: '没有待确认项了' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '进入项目归属' })).toBeTruthy();
  });

  test('?fault=unsupported-material 多出一个不支持的材料类型待确认项', async () => {
    renderPending('pending', 'unsupported-material');
    await screen.findByRole('heading', { name: '待确认项' });
    expect(screen.getByText('对照原件补填或作出选择。还剩 5 个。')).toBeTruthy();
    const buttons = within(screen.getByLabelText('待确认项清单')).getAllByRole('button');
    expect(buttons.some((button) => button.textContent === '不支持的材料类型曹操出行_行程单.pdf')).toBe(true);
    fireEvent.click(itemByFile('曹操出行_行程单'));
    fireEvent.click(within(detail()).getByRole('button', { name: '排除此材料' }));
    await screen.findByText('对照原件补填或作出选择。还剩 4 个。');
  });
});

describe('原件查看器', () => {
  const viewer = () => within(detail()).getByTestId('doc-viewer');
  const photo = () => within(viewer()).getByRole('img', { name: /原件$/ });
  const fullscreen = () => screen.queryByRole('img', { name: /原件（全屏）$/ });
  const openFullscreen = () => fireEvent.click(within(viewer()).getByRole('button', { name: '全屏查看' }));
  const stage = () => screen.getByTestId('fullscreen-stage');

  // QA 2026-09-30: the frame is too small to read, and zooming inside it did not help. The frame only shows the whole
  // original; reading happens full screen, with just rotate and close.
  test('原件框里没有放大缩小；点「全屏查看」或原件打开全屏，只有旋转与关闭', async () => {
    renderPending();
    await screen.findByRole('heading', { name: '待确认项' });
    expect(within(viewer()).queryByRole('toolbar')).toBeNull();
    for (const name of ['放大', '缩小', '适应窗口']) expect(within(viewer()).queryByRole('button', { name })).toBeNull();
    expect(fullscreen()).toBeNull();

    openFullscreen();
    expect(fullscreen()).toBeTruthy();
    const dialog = stage().closest('[role="dialog"]') as HTMLElement;
    // Only close and rotate: no zoom anywhere.
    expect(within(dialog).getAllByRole('button')).toHaveLength(2);
    expect(within(dialog).getByRole('button', { name: '关闭' })).toBeTruthy();

    // Rotating full screen turns the frame's original too.
    fireEvent.click(within(dialog).getByRole('button', { name: '旋转 90°' }));
    expect(fullscreen()?.style.transform).toContain('rotate(90deg)');
    expect(photo().style.transform).toContain('rotate(90deg)');

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(fullscreen()).toBeNull());

    fireEvent.click(within(viewer()).getByTestId('doc-frame'));
    expect(fullscreen()).toBeTruthy();
    // A click on the image itself keeps the view; a click on the blank stage closes it.
    fireEvent.click(fullscreen() as HTMLElement);
    expect(fullscreen()).toBeTruthy();
    fireEvent.click(stage());
    expect(fullscreen()).toBeNull();
  });

  test('切换到另一个待确认项后，角度回到默认', async () => {
    renderPending();
    await screen.findByRole('heading', { name: '待确认项' });
    openFullscreen();
    fireEvent.click(within(stage().closest('[role="dialog"]') as HTMLElement).getByRole('button', { name: '旋转 90°' }));
    fireEvent.click(stage());
    expect(photo().style.transform).toContain('rotate(90deg)');
    fireEvent.click(itemButton('下车时间不合法'));
    expect(within(detail()).getByRole('img', { name: 'IMG_4906.jpg 原件' })).toBeTruthy();
    expect(photo().style.transform).toContain('rotate(0deg)');
    // 切回来也是默认。
    fireEvent.click(itemButton('补填起点与终点'));
    expect(photo().style.transform).toContain('rotate(0deg)');
  });

  test('PDF 渲染不了时退回浏览器自带预览，不提供全屏查看', async () => {
    renderPending();
    await screen.findByRole('heading', { name: '待确认项' });
    fireEvent.click(itemButton('不支持的材料类型'));
    expect((await within(detail()).findByTitle('办公用品_发票.pdf 原件')).tagName).toBe('IFRAME');
    expect(within(viewer()).queryByRole('button', { name: '全屏查看' })).toBeNull();
  });

  test('查看操作不发出任何适配器调用', async () => {
    window.location.hash = '#/task/T1/pending';
    const adapter = createMockAdapter({ seed: 'pending', fault: null, inventoryPhaseMs: 5 });
    const calls: string[] = [];
    const spied = new Proxy(adapter, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls.push(String(property));
          return value.apply(target, args);
        };
      },
    });
    render(<App adapter={spied} />);
    await screen.findByRole('heading', { name: '待确认项' });
    await screen.findByText('对照原件补填或作出选择。还剩 4 个。');
    calls.length = 0;

    openFullscreen();
    fireEvent.click(within(stage().closest('[role="dialog"]') as HTMLElement).getByRole('button', { name: '旋转 90°' }));
    fireEvent.click(stage());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([]);
    const snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.pendingItems.every((item) => item.status === 'open')).toBe(true);
  });
});

describe('逐段分摊与阻塞项', () => {
  const ALLOCATION_TITLE = '合并交通发票逐段金额';
  const segmentInput = (index: number) => within(detail()).getByLabelText(new RegExp(`^第 ${index} 段`)) as HTMLInputElement;
  const submitAmounts = () => fireEvent.click(within(detail()).getByRole('button', { name: '提交逐段金额' }));

  test('?allocation=1：不守恒时显示服务端给的错误，守恒后通过', async () => {
    const adapter = renderPending('pending', null, { allocationRequired: true });
    await screen.findByText('对照原件补填或作出选择。还剩 5 个。');
    const buttons = within(list()).getAllByRole('button');
    expect(buttons).toHaveLength(5);
    for (const button of buttons) expect(button.textContent).not.toContain('要你处理');

    expect(within(detail()).getByRole('heading', { name: ALLOCATION_TITLE })).toBeTruthy();
    // 预填行程单上的读数（第 3 段读成 21.56），合计由服务端核对。
    expect([1, 2, 3].map((index) => segmentInput(index).value)).toEqual(['26.69', '20.85', '21.56']);
    submitAmounts();
    expect(await within(detail()).findByText(ALLOCATION_ERRORS.notConserved('69.10', '69.19'))).toBeTruthy();
    expect((await adapter.getSnapshot('T1')).pendingItems[0]?.status).toBe('open');

    fireEvent.change(segmentInput(3), { target: { value: '21.65' } });
    submitAmounts();
    expect(await within(detail()).findByRole('heading', { name: '补填起点与终点' })).toBeTruthy();
    expect(itemButton(ALLOCATION_TITLE).textContent).toContain('已处理');
    const snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.pendingItems[0]).toMatchObject({ kind: 'allocation', status: 'resolved', answer: { amounts: ['26.69', '20.85', '21.65'] } });
    expect(snapshot.events.slice(0, 3).map((event) => event.grossAmount)).toEqual(['26.69', '20.85', '21.65']);
    expect(document.body.textContent).not.toMatch(FORBIDDEN_TEXT);
  });

  test('逐段金额格式不对或没填时就地报错，不提交到服务端', async () => {
    const adapter = renderPending('pending', null, { allocationRequired: true });
    await screen.findByText('对照原件补填或作出选择。还剩 5 个。');
    fireEvent.change(segmentInput(2), { target: { value: '20.8' } });
    fireEvent.change(segmentInput(3), { target: { value: '' } });
    submitAmounts();
    expect(within(detail()).getAllByRole('alert').map((node) => node.textContent).filter(Boolean)).toEqual([ALLOCATION_ERRORS.amount, PENDING_ANSWER_ERRORS.required]);
    expect(segmentInput(2).getAttribute('aria-invalid')).toBe('true');
    expect((await adapter.getSnapshot('T1')).pendingItems[0]?.status).toBe('open');
  });

  test('「这张票我认不出」照内核留下阻塞项：什么都不悄悄移走；这一项不能答复，排除这张发票连同行程单后才继续', async () => {
    const adapter = renderPending('pending', null, { allocationRequired: true });
    await screen.findByText('对照原件补填或作出选择。还剩 5 个。');
    expect(within(detail()).getByTestId('give-up-note').textContent).toBe(ALLOCATION_GIVE_UP_NOTE);
    fireEvent.click(within(detail()).getByRole('button', { name: '这张票我认不出' }));
    expect(await within(detail()).findByRole('heading', { name: '补填起点与终点' })).toBeTruthy();
    fireEvent.click(itemButton(ALLOCATION_TITLE));
    expect(within(detail()).getByTestId('give-up-note').textContent).toBe(`你选了「这张票我认不出」。${ALLOCATION_GIVE_UP_NOTE}`);
    // 新出现的阻塞项是未处理行：没有「已处理」标签。
    expect(within(itemButton(GIVEN_UP_TITLE)).queryByText('已处理')).toBeNull();

    let snapshot = await adapter.getSnapshot('T1');
    // 没有材料被排除，费用事件也还在；多出一条阻塞的 given_up 项。
    expect(snapshot.materials.filter((material) => material.status === 'excluded')).toEqual([]);
    expect(snapshot.events).toHaveLength(9);
    expect(snapshot.pendingItems.map((item) => [item.itemId, item.kind, item.status])).toEqual([
      ['p1', 'allocation', 'resolved'],
      ['p2', 'form', 'open'],
      ['p3', 'form', 'open'],
      ['p4', 'choice', 'open'],
      ['stay_screenshot_missing.m01', 'choice', 'open'],
      ['p5', 'given_up', 'open'],
    ]);
    // 服务端不接受直接答复这一项。
    const refused = await adapter.answerPendingItem('T1', 'p5', { choice: 'exclude' }, snapshot.step.stepToken);
    expect(refused).toMatchObject({ ok: false, error: { message: PENDING_ANSWER_ERRORS.notAnswerable } });

    // 其余四项处理完，仍停在待确认项：还剩 1 个，进不了项目归属。
    const answers = [
      ['p2', { origin: '张江高科', destination: '漕河泾开发区' }],
      ['p3', { alightTime: '19:06', origin: '静安寺', destination: '虹桥枢纽' }],
      ['p4', { choice: 'exclude' }],
    ] as const;
    for (const [itemId, answer] of answers) {
      snapshot = await adapter.getSnapshot('T1');
      const outcome = await adapter.answerPendingItem('T1', itemId, answer, snapshot.step.stepToken);
      expect(outcome.ok).toBe(true);
    }
    await adapter.completePaymentScreenshots('T1', 'm01');
    expect((await adapter.getSnapshot('T1')).stage).toBe('pending');
    expect(await screen.findByText('对照原件补填或作出选择。还剩 1 个。')).toBeTruthy();
    expect(screen.queryByRole('link', { name: '进入项目归属' })).toBeNull();

    fireEvent.click(itemButton(GIVEN_UP_TITLE));
    expect(within(detail()).getByText(givenUpNote(3))).toBeTruthy();
    fireEvent.click(within(detail()).getByRole('button', { name: '排除这张发票及其行程单' }));
    expect(await screen.findByRole('heading', { name: '没有待确认项了' })).toBeTruthy();
    snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.materials.filter((material) => material.status === 'excluded').map((material) => material.materialId)).toEqual(['m03', 'm04', 'm12']);
    expect(snapshot.stage).toBe('project');
    expect(snapshot.lines).toHaveLength(6);
    // The review's total only comes with its digest (after project assignment); here the lines carry it.
    expect(snapshot.confirmation.grossTotal).toBeNull();
    expect(snapshot.lines.reduce((sum, line) => sum + Math.round(Number(line.grossAmount) * 100), 0)).toBe(390340);
    expect(screen.getByText(ALLOCATION_GIVE_UP_NOTE)).toBeTruthy();
  });

  test('空文本 PDF 与多页发票：只能排除', async () => {
    window.location.hash = '#/task/T1/pending';
    const adapter = createMockAdapter({ seed: null, fault: null, inventoryPhaseMs: 1 });
    await adapter.uploadBatch('T1', [new File([], '扫描件_空白.pdf', { type: 'application/pdf' }), new File(['two pages'], '酒店_多页发票.pdf', { type: 'application/pdf' })]);
    const uploaded = await adapter.getSnapshot('T1');
    await adapter.startInventory('T1', uploaded.step.stepToken);
    await waitFor(async () => expect((await adapter.getSnapshot('T1')).stage).toBe('pending'));
    render(<App adapter={adapter} />);
    await screen.findByText('对照原件补填或作出选择。还剩 2 个。');
    for (const title of ['这份 PDF 没有可读取的内容', '多页发票']) {
      fireEvent.click(itemButton(title));
      expect(within(detail()).getByRole('heading', { name: title })).toBeTruthy();
      expect(within(detail()).getAllByRole('button').map((button) => button.textContent)).toEqual(['排除此材料']);
    }
    expect(within(detail()).getByText(/追加单页发票后重新盘点/)).toBeTruthy();
  });

  // Server titles quote the file name (「IMG_4871.jpg」缺少字段). The queue row must not name the same file a second
  // time, or the row reads 「IMG_4871.jpg」缺少字段 IMG_4871.jpg.
  test('标题已经点名文件时，队列行不再重复文件名', () => {
    const snapshot = t1Snapshot('pending');
    const [first, ...rest] = snapshot.pendingItems;
    if (!first) throw new Error('夹具里没有待确认项');
    const fileName = snapshot.materials.find((material) => material.materialId === first.materialId)?.fileName ?? '';
    const titled = { ...snapshot, pendingItems: [{ ...first, title: `「${fileName}」缺少字段` }, ...rest] };
    const store = new AppStore(createMockAdapter({ seed: 'pending', fault: null }), { validate: true });
    render(
      <AppProvider store={store}>
        <PendingPage snapshot={titled} />
      </AppProvider>,
    );
    const rows = within(list()).getAllByRole('button');
    expect(rows[0]?.textContent).toBe(`「${fileName}」缺少字段`);
    // Titles that do not name the file keep the file name line.
    expect(rows[1]?.textContent).toBe('下车时间不合法，并补填起点与终点IMG_4906.jpg');
  });

  // #342: 手工补填 is one form. The button opens it in place; the 材料种类 is picked inline and its fields follow, and one
  // answer carries the kind and the values.
  test('手工补填一步完成：选种类、填字段，一次提交', async () => {
    const snapshot = t1Snapshot('pending');
    const [first, ...rest] = snapshot.pendingItems;
    if (!first) throw new Error('夹具里没有待确认项');
    const field = (key: string, label: string, format: 'money' | 'date' | 'text', required = true) => ({ key, label, placeholder: '', required, format });
    const unrecognised = {
      ...first,
      itemId: `unrecognised.${first.materialId}`,
      title: '认不出这份材料',
      kind: 'choice' as const,
      fields: [],
      choices: [{ key: 'exclude', label: '排除这份材料' }, { key: 'reference', label: '作为参考材料' }, { key: 'manual_fill', label: '手工补填' }],
      manualKinds: [
        { kind: 'vat_invoice' as const, label: '全电发票', fields: [field('totalAmount', '价税合计', 'money')] },
        { kind: 'payment_screenshot' as const, label: '支付截图', fields: [field('amount', '支付金额', 'money'), field('payDate', '支付日期', 'date'), field('payee', '收款方', 'text', false)] },
      ],
    };
    const adapter = createMockAdapter({ seed: 'pending', fault: null });
    const answer = vi.spyOn(adapter, 'answerPendingItem');
    render(
      <AppProvider store={new AppStore(adapter, { validate: true })}>
        <PendingPage snapshot={{ ...snapshot, pendingItems: [unrecognised, ...rest] }} />
      </AppProvider>,
    );
    fireEvent.click(within(detail()).getByRole('button', { name: '手工补填' }));
    expect(answer).not.toHaveBeenCalled();
    const form = within(detail()).getByRole('form', { name: /^手工补填「/ });
    fireEvent.click(within(form).getByRole('button', { name: '保存并标记已处理' }));
    expect(within(form).getByText(PENDING_ANSWER_ERRORS.kind)).toBeTruthy();

    fireEvent.change(within(form).getByLabelText('材料种类 *'), { target: { value: 'payment_screenshot' } });
    expect(within(form).queryByLabelText('价税合计 *')).toBeNull();
    fireEvent.change(within(form).getByLabelText('支付金额 *'), { target: { value: '178.48' } });
    fireEvent.change(within(form).getByLabelText('支付日期 *'), { target: { value: '2026-09-16' } });
    fireEvent.click(within(form).getByRole('button', { name: '保存并标记已处理' }));
    await waitFor(() =>
      expect(answer).toHaveBeenCalledWith('T1', unrecognised.itemId, { choice: 'manual_fill', kind: 'payment_screenshot', amount: '178.48', payDate: '2026-09-16', payee: '' }, snapshot.step.stepToken),
    );
  });

  test('餐饮小票手工补填保留独立金额，发票选择随同一次提交', async () => {
    const snapshot = t1Snapshot('pending');
    const first = snapshot.pendingItems[0]!;
    const item = {
      ...first, itemId: `unrecognised.${first.materialId}`, kind: 'choice' as const, fields: [],
      choices: [{ key: 'manual_fill', label: '手工补填' }],
      manualKinds: [{ kind: 'dining_receipt' as const, label: '餐饮小票', fields: [{ key: 'paidAmount', label: '实付金额', placeholder: '', required: true, format: 'money' as const }], diningAssignment: {
        address: `edit.${first.materialId}.diningInvoice`, selection: { kind: 'automatic' as const }, options: [{ invoiceId: 'invoice-1', label: '餐饮发票 · 240.00 元', amount: '240.00' }],
      } }],
    };
    const adapter = createMockAdapter({ seed: 'pending', fault: null });
    const answer = vi.spyOn(adapter, 'answerPendingItem').mockResolvedValue({ ok: false, error: { code: 'check_failed', message: '金额不一致' }, snapshot: null });
    render(<AppProvider store={new AppStore(adapter, { validate: true })}><PendingPage snapshot={{ ...snapshot, pendingItems: [item] }} /></AppProvider>);
    fireEvent.click(within(detail()).getByRole('button', { name: '手工补填' }));
    fill('材料种类 *', 'dining_receipt');
    fill('实付金额 *', '239.99');
    fill('关联餐饮发票', 'invoice-1');
    expect(within(detail()).getByLabelText('实付金额 *')).toHaveProperty('value', '239.99');
    fireEvent.click(within(detail()).getByRole('button', { name: '保存并标记已处理' }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith('T1', item.itemId, { choice: 'manual_fill', kind: 'dining_receipt', paidAmount: '239.99', diningInvoiceId: 'invoice-1' }, snapshot.step.stepToken));
  });

  test('餐饮补传发送所选文件，全部拒收时停留待确认并展示原因', async () => {
    window.location.hash = '#/task/T1/pending';
    const snapshot = t1Snapshot('pending');
    const item = { ...snapshot.pendingItems[0]!, dining: { kind: 'invoice' as const, supplement: 'receipt' as const } };
    const rejected = { ...snapshot, batches: [{ batchId: 'reject', no: 2, uploadedAt: '2026-10-10T00:00:00Z', versionId: null, files: [{ fileId: 'bad', fileName: 'notes.txt', relativePath: 'notes.txt', size: 3, status: 'rejected' as const, contentHash: null, materialId: null, reasonCode: 'unsupported_type' as const, reason: '不支持的文件类型' }] }] };
    const adapter = createMockAdapter({ seed: 'pending', fault: null });
    const upload = vi.spyOn(adapter, 'supplementDiningEvidence').mockResolvedValue({ ok: true, snapshot: rejected });
    const wrapper = (value: typeof snapshot) => <AppProvider store={new AppStore(adapter, { validate: true })}><PendingPage snapshot={{ ...value, pendingItems: [item] }} /></AppProvider>;
    const rendered = render(wrapper(snapshot));
    const files = [new File(['bad'], 'notes.txt')];
    fireEvent.change(within(detail()).getByLabelText('补充账单'), { target: { files } });
    await waitFor(() => expect(upload).toHaveBeenCalledWith('T1', { pendingItemId: item.itemId, files }, snapshot.step.stepToken));
    expect(window.location.hash).toBe('#/task/T1/pending');
    rendered.rerender(wrapper(rejected));
    expect(screen.getByRole('status', { name: '本次未接收的文件' }).textContent).toContain('notes.txt：不支持的文件类型');
  });

  test('已处理的餐饮关联可重新展开并重置，确认锁定后不能展开', async () => {
    const snapshot = t1Snapshot('review');
    const item = { ...snapshot.pendingItems[0]!, itemId: 'dining_association.receipt', title: '餐饮小票关联发票', dining: {
      kind: 'receipt' as const, supplement: null, assignment: { address: 'edit.receipt.diningInvoice', selection: { kind: 'selected_valid' as const, invoiceId: 'invoice-1' }, options: [{ invoiceId: 'invoice-1', label: '餐饮发票 · 240.00 元', amount: '240.00' }] },
    }, screenshotGroup: null };
    const adapter = createMockAdapter({ seed: 'review', fault: null });
    const answer = vi.spyOn(adapter, 'answerPendingItem').mockResolvedValue({ ok: false, error: { code: 'test', message: 'test' }, snapshot: null });
    const wrapper = (allowedActions: typeof snapshot.allowedActions) => <AppProvider store={new AppStore(adapter, { validate: true })}><PendingPage snapshot={{ ...snapshot, pendingItems: [item], allowedActions }} /></AppProvider>;
    const rendered = render(wrapper(snapshot.allowedActions));
    fireEvent.click(screen.getByRole('button', { name: '查看或修改关联' }));
    fill('关联餐饮发票', '');
    fireEvent.click(within(detail()).getByRole('button', { name: '保存关联' }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith('T1', 'edit.receipt.diningInvoice', { value: 'auto' }, snapshot.step.stepToken));
    rendered.rerender(wrapper(snapshot.allowedActions.filter((action) => action !== 'change_dining_evidence')));
    expect(screen.queryByRole('button', { name: '查看或修改关联' })).toBeNull();
  });

  // #213, ADR-0032: a 住宿 invoice missing its 支付截图 takes them right here, all in one upload that the server places with
  // this invoice before it inventories again. The mock raises the item at inventory like the server does (T1 has no
  // screenshot) and, having no parser, counts the upload as covering the invoice.
  test('住宿发票缺少支付截图：多选的截图一次传上去，归到这张发票，页面转到材料盘点', async () => {
    const copy = STAY_TRIO_COPY.screenshot;
    const adapter = renderPending();
    await screen.findByRole('heading', { name: '待确认项' });
    const title = copy.title('全季酒店_发票.pdf');
    fireEvent.click(itemButton(title));
    expect(within(detail()).getByRole('heading', { name: title })).toBeTruthy();
    expect(within(detail()).getByText(copy.why('3640.00'))).toBeTruthy();
    expect(within(detail()).queryByRole('button', { name: copy.confirmNone })).toBeNull();
    expect(within(detail()).getByRole('button', { name: copy.upload })).toBeTruthy();
    expect(within(detail()).getByText(copy.uploadNote, { exact: false })).toBeTruthy();

    const png = (name: string) => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });
    const add = vi.spyOn(adapter, 'addPaymentScreenshots');
    const input = within(detail()).getByLabelText(copy.inputLabel('全季酒店_发票.pdf'));
    const files = [png('IMG_5011.png'), png('IMG_5012.png')];
    expect(input.hasAttribute('multiple')).toBe(true);
    const before = await adapter.getSnapshot('T1');
    fireEvent.change(input, { target: { files } });
    await waitFor(() => expect(window.location.hash).toBe('#/task/T1/inventory'));
    expect(add.mock.calls).toEqual([['T1', 'm01', files, before.step.stepToken]]);
    const snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.pendingItems.find((item) => item.itemId === 'stay_screenshot_missing.m01')).toMatchObject({ status: 'resolved', answer: null });
    expect(snapshot.materials.filter((material) => material.kind === 'payment_screenshot').map((material) => [material.fileName, material.payment?.invoiceId])).toEqual([
      ['IMG_5011.png', 'm01'],
      ['IMG_5012.png', 'm01'],
    ]);
  });

  test('没有支付截图的任务不会产生可重新展开的截图项', async () => {
    const copy = STAY_TRIO_COPY.screenshot;
    const adapter = renderPending('review');
    await screen.findByRole('heading', { name: '没有待确认项了' });
    expect(screen.queryByLabelText('待确认项详情')).toBeNull();
    expect(screen.queryByRole('button', { name: copy.reopen })).toBeNull();
    expect((await adapter.getSnapshot('T1')).paymentScreenshots).toEqual([]);
  });

  test('整单明细确认后，已处理的支付截图项不再能展开增删', async () => {
    renderPending('actions');
    await screen.findByRole('heading', { name: '没有待确认项了' });
    expect(screen.queryByRole('button', { name: STAY_TRIO_COPY.screenshot.reopen })).toBeNull();
  });
});

test('missing ride itinerary opens repeated actual trip fields and clears removed row amounts', async () => {
  const snapshot = t1Snapshot('pending');
  const item = { ...snapshot.pendingItems[0]!, itemId: 'ride_itinerary_missing.m09', title: '缺少行程单', kind: 'choice' as const, fields: [], choices: [{ key: 'manual_fill', label: '手工填写' }, { key: 'confirm_none', label: '确认没有账单' }], expenseDetails: [], rideTrips: { total: '69.19' }, status: 'open' as const, answer: null };
  const adapter = createMockAdapter({ seed: 'pending', fault: null });
  const answer = vi.spyOn(adapter, 'answerPendingItem').mockResolvedValue({ ok: false, error: { code: 'test', message: 'test' }, snapshot: null });
  render(<AppProvider store={new AppStore(adapter, { validate: true })}><PendingPage snapshot={{ ...snapshot, allowedActions: [...snapshot.allowedActions, 'change_dining_evidence'], pendingItems: [item] }} /></AppProvider>);
  fireEvent.click(screen.getByRole('button', { name: '确认没有账单' }));
  fill('行程段数', '2');
  expect(screen.getByLabelText('第 2 段 · 价税合计 *')).toBeTruthy();
  fill('第 2 段 · 价税合计 *', '39.19');
  fill('行程段数', '1');
  expect(screen.queryByLabelText('第 2 段 · 价税合计 *')).toBeNull();
  fill('第 1 段 · 行程日期 *', '2026-08-03');
  fill('第 1 段 · 费用城市 *', '杭州');
  fill('第 1 段 · 起点 *', '机场');
  fill('第 1 段 · 终点 *', '酒店');
  fireEvent.click(screen.getByRole('button', { name: '保存费用详情' }));
  await waitFor(() => expect(answer).toHaveBeenCalledWith('T1', item.itemId, { choice: 'confirm_none', tripCount: '1', 'segments[0].date': '2026-08-03', 'segments[0].city': '杭州', 'segments[0].origin': '机场', 'segments[0].destination': '酒店' }, snapshot.step.stepToken));
});
