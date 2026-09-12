import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import { PENDING_ANSWER_ERRORS, STALE_STEP_NOTICE } from '../contract/actions';
import { createMockAdapter } from '../mock/mock-adapter';
import type { Fault } from '../mock/options';
import type { TaskStage } from '../contract/stage';

function renderPending(seed: TaskStage = 'pending', fault: Fault | null = null) {
  window.location.hash = '#/task/T1/pending';
  const adapter = createMockAdapter({ seed, fault, inventoryPhaseMs: 5 });
  render(<App adapter={adapter} />);
  return adapter;
}

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
    expect(buttons.map((button) => button.textContent)).toEqual(['补填起点与终点IMG_4871.jpg', '下车时间不合法，并补填起点与终点IMG_4906.jpg', '不支持的材料类型餐饮_发票.pdf']);

    // 默认选中第一个：出租车照片用 img 预览，字段带来源。
    expect(within(detail()).getByRole('heading', { name: '补填起点与终点' })).toBeTruthy();
    const photo = within(detail()).getByRole('img', { name: 'IMG_4871.jpg 原件' });
    expect(photo.getAttribute('src')).toBe('fixtures/m09-taxi-photo.jpg');
    expect(within(detail()).getByText('04213377')).toBeTruthy();
    expect(within(detail()).getAllByText('rule:taxi_receipt').length).toBeGreaterThan(0);

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

  test('逐项答复：补填后跳到下一项，来源记为 user；排除不支持的材料后显示没有待确认项了', async () => {
    const adapter = renderPending();
    await screen.findByRole('heading', { name: '待确认项' });
    fill('起点 *', '张江高科');
    fill('终点 *', '漕河泾开发区');
    fireEvent.click(within(detail()).getByRole('button', { name: '保存并标记已处理' }));
    expect(await within(detail()).findByRole('heading', { name: '下车时间不合法，并补填起点与终点' })).toBeTruthy();
    expect(screen.getByText('对照原件补填或作出选择。还剩 2 个。')).toBeTruthy();
    expect(itemButton('补填起点与终点').textContent).toContain('已处理');

    // 已处理的项可以回看：显示答复与来源 user。
    fireEvent.click(itemButton('补填起点与终点'));
    expect((within(detail()).getByLabelText('起点 *') as HTMLInputElement).value).toBe('张江高科');
    expect(within(detail()).getByLabelText('起点 *').hasAttribute('disabled')).toBe(true);
    expect(within(detail()).getAllByText('user').length).toBe(2);

    fireEvent.click(itemButton('下车时间不合法'));
    fill('下车时间 *', '19:06');
    fill('起点 *', '静安寺');
    fill('终点 *', '虹桥枢纽');
    fireEvent.click(within(detail()).getByRole('button', { name: '保存并标记已处理' }));
    expect(await within(detail()).findByRole('heading', { name: '不支持的材料类型' })).toBeTruthy();

    fireEvent.click(within(detail()).getByRole('button', { name: '排除此材料' }));
    expect(await screen.findByRole('heading', { name: '没有待确认项了' })).toBeTruthy();
    expect(screen.getByText('本次盘点的 3 个待确认项都已处理。')).toBeTruthy();
    const link = screen.getByRole('link', { name: '进入整单明细确认' });
    expect(link.getAttribute('href')).toBe('#/task/T1/review');

    // 答复都到了服务端：来源 user、材料已排除、阶段进入 review 并形成候选明细。
    const snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.stage).toBe('review');
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

    // 进入整单明细确认不再被守卫拦住。
    fireEvent.click(link);
    expect(await screen.findByRole('heading', { name: '整单明细确认' })).toBeTruthy();
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
    expect(screen.getByRole('link', { name: '进入整单明细确认' })).toBeTruthy();
  });

  test('?fault=unsupported-material 多出一个不支持的材料类型待确认项', async () => {
    renderPending('pending', 'unsupported-material');
    await screen.findByRole('heading', { name: '待确认项' });
    expect(screen.getByText('对照原件补填或作出选择。还剩 4 个。')).toBeTruthy();
    const buttons = within(screen.getByLabelText('待确认项清单')).getAllByRole('button');
    expect(buttons.some((button) => button.textContent === '不支持的材料类型曹操出行_行程单.pdf')).toBe(true);
    fireEvent.click(itemByFile('曹操出行_行程单'));
    fireEvent.click(within(detail()).getByRole('button', { name: '排除此材料' }));
    await screen.findByText('对照原件补填或作出选择。还剩 3 个。');
  });
});
