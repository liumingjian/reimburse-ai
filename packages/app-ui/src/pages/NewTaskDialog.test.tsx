import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import { createMockAdapter, type MockOptions } from '../mock/mock-adapter';

function renderAt(hash: string, options: Partial<MockOptions> = {}) {
  window.location.hash = hash;
  const adapter = createMockAdapter({ seed: null, fault: null, ...options });
  render(<App adapter={adapter} />);
  return adapter;
}

const dialog = () => screen.findByRole('dialog', { name: '新建报销任务' });

describe('新建报销任务弹层', () => {
  test('点「新建报销任务」在任务列表上打开弹层；取消回到 #/tasks', async () => {
    renderAt('#/tasks');
    fireEvent.click(await screen.findByRole('button', { name: '新建报销任务' }));
    await waitFor(() => expect(window.location.hash).toBe('#/tasks/new'));
    const box = await dialog();
    expect(screen.getByRole('heading', { name: '报销任务' })).toBeTruthy();
    fireEvent.click(within(box).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(window.location.hash).toBe('#/tasks'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  test('#/tasks/new 深链：报销人只读，常驻城市预填网络位置候选并说明来源，没有名称与日期字段', async () => {
    renderAt('#/tasks/new');
    const box = await dialog();
    const employee = await within(box).findByLabelText('报销人');
    expect((employee as HTMLInputElement).value).toBe('林颂宜');
    expect((employee as HTMLInputElement).readOnly).toBe(true);
    expect((within(box).getByLabelText('常驻城市') as HTMLInputElement).value).toBe('杭州');
    expect(within(box).getByText('根据网络位置推测，不对可直接改成你的常驻城市。')).toBeTruthy();
    expect(within(box).getByText(/本地市内交通与外地市内交通/)).toBeTruthy();
    expect(within(box).queryByLabelText('任务名称')).toBeNull();
    expect(within(box).queryByLabelText('开始日期')).toBeNull();
  });

  test('常驻城市为空时就地显示错误，不创建任务', async () => {
    renderAt('#/tasks/new');
    const box = await dialog();
    const input = await within(box).findByLabelText('常驻城市');
    fireEvent.change(input, { target: { value: '  ' } });
    fireEvent.click(within(box).getByRole('button', { name: '创建并上传材料' }));
    expect((await within(box).findByRole('alert')).textContent).toBe('请填写常驻城市。');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(window.location.hash).toBe('#/tasks/new');
  });

  test('改成自己的城市后创建：进入上传页，任务名是服务端占位名，城市快照是所填城市；再次新建时默认值是上次确认的城市', async () => {
    const adapter = renderAt('#/tasks/new');
    const box = await dialog();
    fireEvent.change(await within(box).findByLabelText('常驻城市'), { target: { value: '上海' } });
    fireEvent.click(within(box).getByRole('button', { name: '创建并上传材料' }));
    await waitFor(() => expect(window.location.hash).toBe('#/task/T4/upload'));
    expect(await screen.findByRole('heading', { name: '上传材料' })).toBeTruthy();
    expect(screen.getByText(/^\d{4}-\d{2}-\d{2} 新建报销$/)).toBeTruthy();
    const snapshot = await adapter.getSnapshot('T4');
    expect(snapshot.task.homeCity).toBe('上海');
    expect(snapshot.projectAssignment.homeCity).toBe('上海');
    expect(snapshot.task.period).toBeNull();

    window.location.hash = '#/tasks/new';
    const again = await dialog();
    await waitFor(() => expect((within(again).getByLabelText('常驻城市') as HTMLInputElement).value).toBe('上海'));
    expect(within(again).getByText('上次确认的常驻城市（按报销人身份记住），可直接修改。')).toBeTruthy();
  });

  test('?location=unavailable：没有记忆也没有网络位置，常驻城市留空并提示直接填写', async () => {
    renderAt('#/tasks/new', { locationUnavailable: true });
    const box = await dialog();
    expect(((await within(box).findByLabelText('常驻城市')) as HTMLInputElement).value).toBe('');
    expect(within(box).getByText('没有获取到网络位置，请填写你的常驻城市。')).toBeTruthy();
  });
});
