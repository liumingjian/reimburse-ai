import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import { ALLOCATION_ERRORS, PENDING_ANSWER_ERRORS, STALE_STEP_NOTICE } from '../contract/actions';
import { ALLOCATION_GIVE_UP_NOTE, GIVEN_UP_TITLE, givenUpNote } from '../mock/fixtures/inventory';
import { createMockAdapter } from '../mock/mock-adapter';
import type { Fault, MockOptions } from '../mock/options';
import type { TaskStage } from '../contract/stage';

function renderPending(seed: TaskStage = 'pending', fault: Fault | null = null, extra: Partial<MockOptions> = {}) {
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
    expect(screen.getByText('对照原件补填或作出选择。还剩 3 个。')).toBeTruthy();
    expect(list()).toBeTruthy();
    const buttons = within(screen.getByLabelText('待确认项清单')).getAllByRole('button');
    // 每条都标明处理人（照内核开放项表）。
    expect(buttons.map((button) => button.textContent)).toEqual([
      '补填起点与终点IMG_4871.jpg · 要你处理',
      '下车时间不合法，并补填起点与终点IMG_4906.jpg · 要你处理',
      '不支持的材料类型餐饮_发票.pdf · 要你处理',
    ]);

    // 默认选中第一个：出租车照片用 img 预览，显示读出的字段，但不显示字段来源。
    expect(within(detail()).getByRole('heading', { name: '补填起点与终点' })).toBeTruthy();
    expect(within(detail()).getByTestId('resolver').textContent).toBe('处理人：要你处理');
    const photo = within(detail()).getByRole('img', { name: 'IMG_4871.jpg 原件' });
    expect(photo.getAttribute('src')).toBe('fixtures/m09-taxi-photo.jpg');
    expect(within(detail()).getByText('04213377')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(FORBIDDEN_TEXT);

    // 切到不支持的材料：PDF 用 iframe 预览，出现两种选择。
    fireEvent.click(itemButton('不支持的材料类型'));
    const frame = within(detail()).getByTitle('餐饮_发票.pdf 原件');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('src')).toBe('fixtures/m11-other-invoice.pdf');
    expect(within(detail()).getByRole('button', { name: '排除此材料' })).toBeTruthy();
    expect(within(detail()).getByRole('button', { name: '自行手工处理' })).toBeTruthy();
  });

  test('表单校验：必填与 HH:MM 格式，非法值提交不到服务端', async () => {
    const adapter = renderPending();
    await screen.findByRole('heading', { name: '待确认项' });
    fireEvent.click(within(detail()).getByRole('button', { name: '保存并标记已处理' }));
    expect(within(detail()).getAllByRole('alert').map((node) => node.textContent)).toEqual([PENDING_ANSWER_ERRORS.required, PENDING_ANSWER_ERRORS.required]);
    expect(within(detail()).getByLabelText('起点 *').getAttribute('aria-invalid')).toBe('true');

    fireEvent.click(itemButton('下车时间不合法'));
    fill('下车时间 *', '90:60');
    fill('起点 *', '静安寺');
    fill('终点 *', '虹桥枢纽');
    fireEvent.click(within(detail()).getByRole('button', { name: '保存并标记已处理' }));
    expect(within(detail()).getByRole('alert').textContent).toBe(PENDING_ANSWER_ERRORS.time);
    fill('下车时间 *', '24:00');
    fireEvent.click(within(detail()).getByRole('button', { name: '保存并标记已处理' }));
    expect(within(detail()).getByRole('alert').textContent).toBe(PENDING_ANSWER_ERRORS.time);

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
    expect(screen.getByText('对照原件补填或作出选择。还剩 2 个。')).toBeTruthy();
    expect(itemButton('补填起点与终点').textContent).toContain('已处理');

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
    expect(await screen.findByRole('heading', { name: '没有待确认项了' })).toBeTruthy();
    expect(screen.getByText('本次盘点的 3 个待确认项都已处理。')).toBeTruthy();
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
    ]);
    const taxi = snapshot.materials.find((material) => material.materialId === 'm09');
    expect(taxi?.fields.find((candidate) => candidate.key === 'origin')).toMatchObject({ value: '张江高科', source: 'user', evidence: 'explicit' });
    expect(snapshot.materials.find((material) => material.materialId === 'm11')?.status).toBe('excluded');
    expect(snapshot.lines).toHaveLength(9);
    expect(snapshot.confirmation.grossTotal).toBe('3972.59');

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
    await screen.findByText('对照原件补填或作出选择。还剩 2 个。');
    expect(itemButton('不支持的材料类型').textContent).toContain('已处理');
    // 回看已处理的选择：已选项是选中样式（aria-pressed），不是主按钮。
    fireEvent.click(itemButton('不支持的材料类型'));
    const manual = within(detail()).getByRole('button', { name: '自行手工处理' });
    expect(manual.getAttribute('aria-pressed')).toBe('true');
    expect(manual.className).not.toContain('btn-primary');
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
    await screen.findByText('对照原件补填或作出选择。还剩 2 个。');
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
    expect(screen.getByText('对照原件补填或作出选择。还剩 4 个。')).toBeTruthy();
    const buttons = within(screen.getByLabelText('待确认项清单')).getAllByRole('button');
    expect(buttons.some((button) => button.textContent === '不支持的材料类型曹操出行_行程单.pdf · 要你处理')).toBe(true);
    fireEvent.click(itemByFile('曹操出行_行程单'));
    fireEvent.click(within(detail()).getByRole('button', { name: '排除此材料' }));
    await screen.findByText('对照原件补填或作出选择。还剩 3 个。');
  });
});

describe('逐段分摊与处理人', () => {
  const ALLOCATION_TITLE = '合并交通发票逐段金额';
  const segmentInput = (index: number) => within(detail()).getByLabelText(new RegExp(`^第 ${index} 段`)) as HTMLInputElement;
  const submitAmounts = () => fireEvent.click(within(detail()).getByRole('button', { name: '提交逐段金额' }));

  test('?allocation=1：每条都标明处理人；不守恒时显示服务端给的错误，守恒后通过', async () => {
    const adapter = renderPending('pending', null, { allocationRequired: true });
    await screen.findByText('对照原件补填或作出选择。还剩 4 个。');
    const buttons = within(list()).getAllByRole('button');
    expect(buttons).toHaveLength(4);
    for (const button of buttons) expect(button.textContent).toContain('要你处理');

    expect(within(detail()).getByRole('heading', { name: ALLOCATION_TITLE })).toBeTruthy();
    expect(within(detail()).getByTestId('resolver').textContent).toBe('处理人：要你处理');
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
    await screen.findByText('对照原件补填或作出选择。还剩 4 个。');
    fireEvent.change(segmentInput(2), { target: { value: '20.8' } });
    fireEvent.change(segmentInput(3), { target: { value: '' } });
    submitAmounts();
    expect(within(detail()).getAllByRole('alert').map((node) => node.textContent)).toEqual([ALLOCATION_ERRORS.amount, PENDING_ANSWER_ERRORS.required]);
    expect(segmentInput(2).getAttribute('aria-invalid')).toBe('true');
    expect((await adapter.getSnapshot('T1')).pendingItems[0]?.status).toBe('open');
  });

  test('「这张票我认不出」照内核留下阻塞项：什么都不悄悄移走；这一项不能答复，排除这张发票连同行程单后才继续', async () => {
    const adapter = renderPending('pending', null, { allocationRequired: true });
    await screen.findByText('对照原件补填或作出选择。还剩 4 个。');
    expect(within(detail()).getByTestId('give-up-note').textContent).toBe(ALLOCATION_GIVE_UP_NOTE);
    fireEvent.click(within(detail()).getByRole('button', { name: '这张票我认不出' }));
    expect(await within(detail()).findByRole('heading', { name: '补填起点与终点' })).toBeTruthy();
    fireEvent.click(itemButton(ALLOCATION_TITLE));
    expect(within(detail()).getByTestId('give-up-note').textContent).toBe(`你选了「这张票我认不出」。${ALLOCATION_GIVE_UP_NOTE}`);
    expect(itemButton(GIVEN_UP_TITLE).textContent).toContain('要你处理');

    let snapshot = await adapter.getSnapshot('T1');
    // 没有材料被排除，费用事件也还在；多出一条阻塞的 given_up 项。
    expect(snapshot.materials.filter((material) => material.status === 'excluded')).toEqual([]);
    expect(snapshot.events).toHaveLength(9);
    expect(snapshot.pendingItems.map((item) => [item.itemId, item.kind, item.status])).toEqual([
      ['p1', 'allocation', 'resolved'],
      ['p2', 'form', 'open'],
      ['p3', 'form', 'open'],
      ['p4', 'choice', 'open'],
      ['p5', 'given_up', 'open'],
    ]);
    // 服务端不接受直接答复这一项。
    const refused = await adapter.answerPendingItem('T1', 'p5', { choice: 'exclude' }, snapshot.step.stepToken);
    expect(refused).toMatchObject({ ok: false, error: { message: PENDING_ANSWER_ERRORS.notAnswerable } });

    // 其余三项处理完，仍停在待确认项：还剩 1 个，进不了项目归属。
    const answers = [{ origin: '张江高科', destination: '漕河泾开发区' }, { alightTime: '19:06', origin: '静安寺', destination: '虹桥枢纽' }, { choice: 'exclude' }];
    for (const [index, answer] of answers.entries()) {
      snapshot = await adapter.getSnapshot('T1');
      const outcome = await adapter.answerPendingItem('T1', `p${index + 2}`, answer, snapshot.step.stepToken);
      expect(outcome.ok).toBe(true);
    }
    expect((await adapter.getSnapshot('T1')).stage).toBe('pending');
    expect(await screen.findByText('对照原件补填或作出选择。还剩 1 个。')).toBeTruthy();
    expect(screen.queryByRole('link', { name: '进入项目归属' })).toBeNull();

    fireEvent.click(itemButton(GIVEN_UP_TITLE));
    expect(within(detail()).getByText(givenUpNote(3))).toBeTruthy();
    fireEvent.click(within(detail()).getByRole('button', { name: '排除这张发票及其行程单' }));
    expect(await screen.findByRole('heading', { name: '没有待确认项了' })).toBeTruthy();
    snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.materials.filter((material) => material.status === 'excluded').map((material) => material.materialId)).toEqual(['m03', 'm04', 'm11']);
    expect(snapshot.stage).toBe('project');
    expect(snapshot.lines).toHaveLength(6);
    expect(snapshot.confirmation.grossTotal).toBe('3903.40');
    expect(screen.getByText(ALLOCATION_GIVE_UP_NOTE)).toBeTruthy();
  });

  test('空文本 PDF 与多页发票：要你处理，只能排除', async () => {
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
      expect(within(detail()).getByTestId('resolver').textContent).toBe('处理人：要你处理');
      expect(within(detail()).getAllByRole('button').map((button) => button.textContent)).toEqual(['排除此材料']);
    }
    expect(within(detail()).getByText(/追加单页发票后重新盘点/)).toBeTruthy();
  });
});
