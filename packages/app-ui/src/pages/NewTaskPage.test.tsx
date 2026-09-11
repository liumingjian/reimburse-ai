import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import { createMockAdapter } from '../mock/mock-adapter';

function renderNewTask() {
  window.location.hash = '#/tasks/new';
  return render(<App adapter={createMockAdapter({ seed: null, fault: null })} />);
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('新建报销任务表单', () => {
  test('名称必填：空提交显示错误并停留在本页', async () => {
    renderNewTask();
    fireEvent.click(await screen.findByRole('button', { name: '创建并上传材料' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '任务名称必填。');
    expect(screen.getByLabelText('任务名称').getAttribute('aria-invalid')).toBe('true');
    expect(window.location.hash).toBe('#/tasks/new');
  });

  test('结束日期不能早于开始日期', async () => {
    renderNewTask();
    fill('任务名称', '2026-09 杭州出差（客户验收）');
    fill('开始日期', '2026-09-05');
    fill('结束日期', '2026-09-03');
    fireEvent.click(screen.getByRole('button', { name: '创建并上传材料' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '结束日期不能早于开始日期。');
    expect(screen.getByLabelText('结束日期').getAttribute('aria-invalid')).toBe('true');
    expect(window.location.hash).toBe('#/tasks/new');
  });

  test('日期范围要起止一起填', async () => {
    renderNewTask();
    fill('任务名称', '2026-09 杭州出差（客户验收）');
    fill('开始日期', '2026-09-03');
    fireEvent.click(screen.getByRole('button', { name: '创建并上传材料' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '开始日期与结束日期要一起填写，或都留空。');
  });

  test('填好后创建任务并跳到该任务的上传页', async () => {
    renderNewTask();
    fill('任务名称', '2026-09 杭州出差（客户验收）');
    fill('开始日期', '2026-09-03');
    fill('结束日期', '2026-09-05');
    fireEvent.click(screen.getByRole('button', { name: '创建并上传材料' }));
    await waitFor(() => expect(window.location.hash).toBe('#/task/T4/upload'));
    expect(await screen.findByRole('heading', { name: '上传材料' })).toBeTruthy();
    expect(screen.getByText('2026-09 杭州出差（客户验收）')).toBeTruthy();
    expect(screen.getByText('拖入文件，或点击选择')).toBeTruthy();
  });

  test('只填名称也能创建（费用期间留空）', async () => {
    renderNewTask();
    fill('任务名称', '2026-09 杭州出差');
    fireEvent.click(screen.getByRole('button', { name: '创建并上传材料' }));
    await waitFor(() => expect(window.location.hash).toBe('#/task/T4/upload'));
  });
});
