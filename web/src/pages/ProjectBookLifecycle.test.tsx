import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import { createMockAdapter } from '../mock/mock-adapter';

function renderApp(hash: string) {
  window.location.hash = hash;
  const adapter = createMockAdapter({ seed: null, fault: null, inventoryPhaseMs: 5, autoStepMs: 5 });
  render(<App adapter={adapter} />);
  return adapter;
}

async function openMore(number: string): Promise<HTMLElement> {
  const row = screen.getByTestId(`book-row-${number}`);
  fireEvent.click(within(row).getByRole('button', { name: '更多' }));
  const label = `项目 ${number} 的更多操作`;
  return waitFor(() => {
    const menu = screen.queryAllByRole('menu', { hidden: true }).find((element) => element.getAttribute('aria-label') === label);
    if (!menu) throw new Error(`Menu "${label}" did not open`);
    return menu;
  });
}

function lifecycleItem(menu: HTMLElement, label: string): HTMLButtonElement {
  const items = within(menu).getAllByRole('menuitem', { hidden: true });
  expect(items).toHaveLength(1);
  const item = items[0] as HTMLButtonElement;
  expect(item.getAttribute('aria-label') ?? item.textContent).toBe(label);
  return item;
}

describe('project book lifecycle controls', () => {
  test('deactivates and restores a personal entry from the maintenance page', async () => {
    renderApp('#/projects');
    await screen.findByTestId('book-row-P-2307');

    const row = screen.getByTestId('book-row-P-2307');
    expect(within(row).getAllByRole('button')).toHaveLength(2);
    expect(within(row).getByRole('button', { name: '编辑 P-2307' })).toBeTruthy();
    fireEvent.click(lifecycleItem(await openMore('P-2307'), '停用项目 P-2307'));
    expect((await screen.findByTestId('book-message')).textContent).toContain('已停用');
    expect(screen.getByTestId('book-row-P-2307').textContent).toContain('已停用');
    const restore = lifecycleItem(await openMore('P-2307'), '恢复项目 P-2307');
    expect(restore).toBeTruthy();

    fireEvent.click(restore);
    expect((await screen.findByTestId('book-message')).textContent).toContain('已恢复');
    expect(screen.getByTestId('book-row-P-2307').textContent).toContain('可选');
    expect(lifecycleItem(await openMore('P-2307'), '停用项目 P-2307')).toBeTruthy();
  });

  test('updates mock assignment availability without discarding a draft permanently', async () => {
    const adapter = createMockAdapter({ seed: 'project', fault: null, inventoryPhaseMs: 5, autoStepMs: 5 });
    const before = await adapter.getSnapshot('T1');
    expect(before.projectAssignment.working.some((entry) => entry.projectNumber === 'P-2307')).toBe(true);

    expect(await adapter.deactivateProject({ number: 'P-2307' })).toMatchObject({ ok: true, result: { status: 'deactivated' } });
    const inactive = await adapter.getSnapshot('T1');
    expect(inactive.projectAssignment.projects.some((entry) => entry.number === 'P-2307')).toBe(false);
    expect(inactive.projectAssignment.working.some((entry) => entry.projectNumber === 'P-2307')).toBe(false);
    expect(inactive.projectAssignment.reselect.some((entry) => entry.projectNumber === 'P-2307')).toBe(true);

    expect(await adapter.restoreProject({ number: 'P-2307' })).toMatchObject({ ok: true, result: { status: 'restored' } });
    const restored = await adapter.getSnapshot('T1');
    expect(restored.projectAssignment.projects.some((entry) => entry.number === 'P-2307')).toBe(true);
    expect(restored.projectAssignment.working.some((entry) => entry.projectNumber === 'P-2307')).toBe(true);
  });

  test('keeps the member public view read-only while the administrator can deactivate and restore a public entry', async () => {
    const adapter = createMockAdapter({ seed: null, fault: null, inventoryPhaseMs: 5, autoStepMs: 5 });
    await adapter.intakePublicProject({ number: 'PUBLIC-LIFE', name: '公共生命周期项目' });
    window.location.hash = '#/projects';
    render(<App adapter={adapter} />);

    const publicTable = await screen.findByRole('table', { name: '公共项目簿' });
    expect(within(publicTable).getByTestId('book-row-PUBLIC-LIFE')).toBeTruthy();
    expect(within(publicTable).queryByRole('button', { name: '更多' })).toBeNull();

    window.location.hash = '#/admin';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await screen.findByRole('heading', { name: '管理', level: 1 });
    expect(await screen.findByTestId('book-row-PUBLIC-LIFE')).toBeTruthy();

    fireEvent.click(lifecycleItem(await openMore('PUBLIC-LIFE'), '停用项目 PUBLIC-LIFE'));
    expect((await screen.findByTestId('book-message')).textContent).toContain('已停用');
    const restore = lifecycleItem(await openMore('PUBLIC-LIFE'), '恢复项目 PUBLIC-LIFE');
    expect(restore).toBeTruthy();

    fireEvent.click(restore);
    expect((await screen.findByTestId('book-message')).textContent).toContain('已恢复');
    expect(lifecycleItem(await openMore('PUBLIC-LIFE'), '停用项目 PUBLIC-LIFE')).toBeTruthy();
  });
});
