import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import { createMockAdapter, type MockOptions } from '../mock/mock-adapter';

type Extra = Omit<MockOptions, 'seed' | 'fault'>;

function renderApp(hash: string, extra: Extra = {}) {
  window.location.hash = hash;
  const adapter = createMockAdapter({ seed: null, fault: null, inventoryPhaseMs: 5, autoStepMs: 5, ...extra });
  render(<App adapter={adapter} />);
  return adapter;
}

function editDialog() {
  return screen.getByRole('dialog', { name: '编辑项目' });
}

function dialogInput(label: '项目号' | '项目名称') {
  return within(editDialog()).getByLabelText(label) as HTMLInputElement;
}

describe('项目簿编辑', () => {
  test('opens current values, cancels without writing, and retains invalid edits for correction before saving', async () => {
    renderApp('#/projects');
    const original = await screen.findByTestId('book-row-P-2307');
    expect(original.textContent).toContain('华东客户交付');

    fireEvent.click(screen.getByRole('button', { name: '编辑 P-2307' }));
    expect(dialogInput('项目号').value).toBe('P-2307');
    expect(dialogInput('项目名称').value).toBe('华东客户交付');
    fireEvent.change(dialogInput('项目名称'), { target: { value: '取消前的名称' } });
    fireEvent.click(within(editDialog()).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog', { name: '编辑项目' })).toBeNull();
    expect(screen.getByTestId('book-row-P-2307').textContent).toContain('华东客户交付');

    fireEvent.click(screen.getByRole('button', { name: '编辑 P-2307' }));
    fireEvent.change(dialogInput('项目号'), { target: { value: 'P-2311' } });
    fireEvent.change(dialogInput('项目名称'), { target: { value: '纠正后的名称' } });
    fireEvent.click(within(editDialog()).getByRole('button', { name: '保存' }));
    expect(await within(editDialog()).findByText(/无法改为该项目号/)).toBeTruthy();
    expect(dialogInput('项目号').value).toBe('P-2311');
    expect(dialogInput('项目名称').value).toBe('纠正后的名称');

    fireEvent.change(dialogInput('项目号'), { target: { value: 'P-2200' } });
    fireEvent.click(within(editDialog()).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑项目' })).toBeNull());
    expect((await screen.findByTestId('book-row-P-2200')).textContent).toContain('纠正后的名称');
    expect(screen.queryByTestId('book-row-P-2307')).toBeNull();
    expect(screen.getByTestId('book-message').textContent).toContain('已更新为 P-2200');
  });

  test('keeps public rows read-only for members and lets an administrator edit the same public record', async () => {
    const member = createMockAdapter({ seed: null, fault: null, inventoryPhaseMs: 5, autoStepMs: 5 });
    await member.intakePublicProject({ number: 'PUBLIC-EDIT', name: '共享原名称' });
    window.location.hash = '#/projects';
    render(<App adapter={member} />);
    expect(await screen.findByTestId('book-row-PUBLIC-EDIT')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '编辑 PUBLIC-EDIT' })).toBeNull();

    cleanup();

    const admin = createMockAdapter({ seed: null, fault: null, inventoryPhaseMs: 5, autoStepMs: 5 });
    await admin.intakePublicProject({ number: 'PUBLIC-EDIT', name: '共享原名称' });
    window.location.hash = '#/admin';
    render(<App adapter={admin} />);
    await screen.findByRole('heading', { name: '管理', level: 1 });
    await screen.findByTestId('book-row-PUBLIC-EDIT');
    const publicTable = screen.getByRole('table', { name: '公共项目簿' });
    fireEvent.click(within(publicTable).getByRole('button', { name: '编辑 PUBLIC-EDIT' }));
    fireEvent.change(dialogInput('项目名称'), { target: { value: '共享新名称' } });
    fireEvent.click(within(editDialog()).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑项目' })).toBeNull());
    expect(within(publicTable).getByTestId('book-row-PUBLIC-EDIT').textContent).toContain('共享新名称');
  });
});
