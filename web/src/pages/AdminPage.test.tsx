import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import { MOCK_ACCOUNT, MOCK_PASSWORD } from '../mock/auth';
import { createMockAdapter } from '../mock/mock-adapter';
import { ADMIN_COPY } from './AdminPage';

describe('administrator account approval', () => {
  test('shows a pending registration and exposes only the Chinese approval action until it is approved', async () => {
    const adapter = createMockAdapter({ seed: null, fault: null });
    expect((await adapter.register({ username: '张三', password: 'correct horse' })).ok).toBe(true);
    expect((await adapter.login({ username: MOCK_ACCOUNT.username, password: MOCK_PASSWORD })).ok).toBe(true);

    window.location.hash = '#/admin';
    render(<App adapter={adapter} />);

    const row = await screen.findByTestId('account-row-张三');
    expect(within(row).getByText(ADMIN_COPY.pendingApproval)).toBeTruthy();
    expect(within(row).getByRole('button', { name: ADMIN_COPY.approve })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: ADMIN_COPY.promote })).toBeNull();
    expect(within(row).queryByRole('button', { name: ADMIN_COPY.deactivate })).toBeNull();
    expect(within(row).queryByRole('button', { name: ADMIN_COPY.temporaryPassword })).toBeNull();

    fireEvent.click(within(row).getByRole('button', { name: ADMIN_COPY.approve }));
    expect(await within(row).findByText(ADMIN_COPY.active)).toBeTruthy();
    expect(await screen.findByText(ADMIN_COPY.approvalDone('张三'))).toBeTruthy();
    expect(within(row).getByRole('button', { name: ADMIN_COPY.promote })).toBeTruthy();
  });

  test('keeps public project maintenance outside account management', async () => {
    const adapter = createMockAdapter({ seed: null, fault: null });
    await adapter.intakePublicProject({ number: 'PUBLIC-ONLY', name: '公共项目' });
    window.location.hash = '#/admin';
    render(<App adapter={adapter} />);

    expect(await screen.findByRole('heading', { name: ADMIN_COPY.title, level: 1 })).toBeTruthy();
    expect(await screen.findByRole('table', { name: ADMIN_COPY.accountsTitle })).toBeTruthy();
    expect(screen.queryByRole('table', { name: '公共项目簿' })).toBeNull();
    expect(screen.queryByRole('button', { name: '加入项目' })).toBeNull();
  });
});
