// @vitest-environment node
import { describe, expect, test } from 'vitest';
import { ADMIN_ERRORS, AUTH_ERRORS, type AccountUpdateInput } from '@baox/contract';
import { MOCK_ACCOUNT, MOCK_PASSWORD, createAuth } from './auth';

describe('mock account approval', () => {
  test('registration clears the current session and cannot gain access through other account changes', () => {
    const auth = createAuth({ seed: null, fault: null });

    expect(auth.account()).toEqual(MOCK_ACCOUNT);
    expect(auth.register({ username: '张三', password: 'correct horse' })).toEqual({ ok: true, session: { status: 'signed_out', account: null } });
    expect(auth.account()).toBeNull();
    expect(auth.session()).toEqual({ status: 'signed_out', account: null });
    expect(auth.login({ username: '张三', password: 'correct horse' })).toEqual({ ok: false, error: { code: 'pending_approval', message: AUTH_ERRORS.pendingApproval } });

    expect(auth.login({ username: MOCK_ACCOUNT.username, password: MOCK_PASSWORD }).ok).toBe(true);
    const pending = auth.listAccounts().accounts.find((account) => account.username === '张三');
    if (!pending) throw new Error('pending account was not listed');
    expect(pending).toMatchObject({ active: true, approved: false, role: 'user' });
    const blockedChanges: AccountUpdateInput[] = [{ active: true }, { role: 'admin' }, { temporaryPassword: 'temporary-1' }];
    for (const change of blockedChanges) {
      expect(auth.updateAccount(pending.accountId, change)).toMatchObject({ ok: false, error: { code: 'approval_required', message: ADMIN_ERRORS.approvalRequired } });
    }

    expect(auth.updateAccount(pending.accountId, { approved: true })).toMatchObject({ ok: true, accountList: { accounts: expect.arrayContaining([expect.objectContaining({ accountId: pending.accountId, approved: true, active: true, role: 'user' })]) } });
    expect(auth.login({ username: '张三', password: 'correct horse' })).toMatchObject({ ok: true, session: { status: 'signed_in', account: { username: '张三', role: 'user' } } });
  });
});
