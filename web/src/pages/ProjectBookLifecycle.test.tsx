import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import { createMockAdapter } from '../mock/mock-adapter';

function renderApp(hash: string) {
  window.location.hash = hash;
  const adapter = createMockAdapter({ seed: null, fault: null, inventoryPhaseMs: 5, autoStepMs: 5 });
  render(<App adapter={adapter} />);
  return adapter;
}

describe('project book lifecycle controls', () => {
  test('deactivates and restores a personal entry from the maintenance page', async () => {
    renderApp('#/projects');
    await screen.findByTestId('book-row-P-2307');

    fireEvent.click(screen.getByRole('button', { name: '停用项目 P-2307' }));
    expect((await screen.findByTestId('book-message')).textContent).toContain('已停用');
    expect(screen.getByTestId('book-row-P-2307').textContent).toContain('已停用');
    expect(screen.getByRole('button', { name: '恢复项目 P-2307' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '恢复项目 P-2307' }));
    expect((await screen.findByTestId('book-message')).textContent).toContain('已恢复');
    expect(screen.getByTestId('book-row-P-2307').textContent).toContain('可选');
    expect(screen.getByRole('button', { name: '停用项目 P-2307' })).toBeTruthy();
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
    expect(within(publicTable).queryByRole('button', { name: '停用项目 PUBLIC-LIFE' })).toBeNull();

    window.location.hash = '#/admin';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await screen.findByRole('heading', { name: '管理', level: 1 });
    expect(await screen.findByTestId('book-row-PUBLIC-LIFE')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '停用项目 PUBLIC-LIFE' }));
    expect((await screen.findByTestId('book-message')).textContent).toContain('已停用');
    expect(screen.getByRole('button', { name: '恢复项目 PUBLIC-LIFE' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '恢复项目 PUBLIC-LIFE' }));
    expect((await screen.findByTestId('book-message')).textContent).toContain('已恢复');
    expect(screen.getByRole('button', { name: '停用项目 PUBLIC-LIFE' })).toBeTruthy();
  });
});
