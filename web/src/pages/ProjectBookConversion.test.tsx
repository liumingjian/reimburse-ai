import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { App } from '../App';
import { createMockAdapter, type MockOptions } from '../mock/mock-adapter';

type Extra = Omit<MockOptions, 'seed' | 'fault'>;

afterEach(() => cleanup());

function renderApp(hash: string, extra: Extra = {}) {
  window.location.hash = hash;
  const adapter = createMockAdapter({ seed: null, fault: null, inventoryPhaseMs: 5, ...extra });
  render(<App adapter={adapter} />);
  return adapter;
}

function conversionDialog() {
  return screen.getByRole('dialog', { name: '确认转为公共项目' });
}

function editDialog() {
  return screen.getByRole('dialog', { name: '编辑项目' });
}

function editInput(label: '项目号' | '项目名称') {
  return within(editDialog()).getByLabelText(label) as HTMLInputElement;
}

describe('公共项目转换', () => {
  test('prompts before public intake, cancels without writing, confirms the explicit conversion, and refreshes the personal-book cache', async () => {
    renderApp('#/projects');
    await screen.findByTestId('book-row-P-2307');
    window.location.hash = '#/projects';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await screen.findByRole('heading', { name: '个人项目簿', level: 1 });
    fireEvent.click(screen.getByRole('tab', { name: '公共项目簿' }));
    const numberInput = screen.getByLabelText('项目号') as HTMLInputElement;
    const nameInput = screen.getByLabelText('项目名称') as HTMLInputElement;
    fireEvent.change(numberInput, { target: { value: 'P-2307' } });
    fireEvent.change(nameInput, { target: { value: '转为公共的项目' } });
    fireEvent.click(screen.getByRole('button', { name: '加入项目' }));

    const firstConversion = await screen.findByRole('dialog', { name: '确认转为公共项目' });
    expect(within(firstConversion).getByText(/所有同号个人项目将合并到公共项目簿/)).toBeTruthy();
    fireEvent.click(within(firstConversion).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '确认转为公共项目' })).toBeNull());
    expect(numberInput.value).toBe('P-2307');
    expect(nameInput.value).toBe('转为公共的项目');
    expect(screen.queryByTestId('book-row-P-2307')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '加入项目' }));
    const secondConversion = await screen.findByRole('dialog', { name: '确认转为公共项目' });
    fireEvent.click(within(secondConversion).getByRole('button', { name: '确认转换' }));
    expect((await screen.findByTestId('book-row-P-2307')).textContent).toContain('转为公共的项目');
    expect(screen.getByTestId('book-message').textContent).toContain('已转为公共项目');

    window.location.hash = '#/projects';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    fireEvent.click(screen.getByRole('tab', { name: '个人项目簿' }));
    const personalTable = await screen.findByRole('table', { name: '个人项目簿' });
    await waitFor(() => expect(within(personalTable).queryByTestId('book-row-P-2307')).toBeNull());
  });

  test('returns a public renumber conversion cancellation to the edit form with its proposed values', async () => {
    const adapter = createMockAdapter({ seed: null, fault: null, inventoryPhaseMs: 5 });
    await adapter.intakeProject({ number: 'EDIT-CONVERT', name: '个人目标项目' });
    await adapter.intakePublicProject({ number: 'PUBLIC-OLD', name: '公共原项目' });
    window.location.hash = '#/projects';
    render(<App adapter={adapter} />);

    fireEvent.click(await screen.findByRole('tab', { name: '公共项目簿' }));
    await screen.findByTestId('book-row-PUBLIC-OLD');
    fireEvent.click(screen.getByRole('button', { name: '编辑 PUBLIC-OLD' }));
    fireEvent.change(editInput('项目号'), { target: { value: 'EDIT-CONVERT' } });
    fireEvent.change(editInput('项目名称'), { target: { value: '公共新项目' } });
    fireEvent.click(within(editDialog()).getByRole('button', { name: '保存' }));
    expect(await screen.findByRole('dialog', { name: '确认转为公共项目' })).toBeTruthy();

    fireEvent.click(within(conversionDialog()).getByRole('button', { name: '取消' }));
    expect(await screen.findByRole('dialog', { name: '编辑项目' })).toBeTruthy();
    expect(editInput('项目号').value).toBe('EDIT-CONVERT');
    expect(editInput('项目名称').value).toBe('公共新项目');

    fireEvent.click(within(editDialog()).getByRole('button', { name: '保存' }));
    const confirmation = await screen.findByRole('dialog', { name: '确认转为公共项目' });
    fireEvent.click(within(confirmation).getByRole('button', { name: '确认转换' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '确认转为公共项目' })).toBeNull());
    expect((await screen.findByTestId('book-row-EDIT-CONVERT')).textContent).toContain('公共新项目');
    expect(screen.queryByTestId('book-row-PUBLIC-OLD')).toBeNull();
    expect((await adapter.getProjectBook()).projects.some((project) => project.number === 'EDIT-CONVERT')).toBe(false);
  });
});
