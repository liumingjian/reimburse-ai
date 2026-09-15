import {
  ADMIN_ERRORS,
  AUTH_ERRORS,
  ChangePasswordInputSchema,
  CredentialsInputSchema,
  type Account,
  type AccountList,
  type AccountListOutcome,
  type AccountUpdateInput,
  type ActionError,
  type AuthOutcome,
  type ChangePasswordInput,
  type CredentialsInput,
  type Session,
} from '@baox/contract';
import type { MockOptions, MockStorage } from './options';

// The mock server's 应用账号 (app accounts): accounts and the session live in memory, so a reload starts over from the
// `?auth=` option. By default the fixture account is signed in; `?auth=signed-out` starts at login, `?auth=setup`
// with no account at all. The remembered home city is per account in persistent storage (localStorage in the browser).
// Admin tools (#194) follow the server: at least one active admin remains, deactivated accounts cannot log in, and a
// temporary password must be changed at next login.

export const MOCK_ACCOUNT: Account = { accountId: 'A1', username: '林颂宜', role: 'admin' };
export const MOCK_PASSWORD = 'mock-password';

// localStorage in the browser; an in-memory stand-in without window (node unit tests) or when storage is blocked.
export function defaultStorage(): MockStorage {
  if (typeof window !== 'undefined') {
    try {
      const storage = window.localStorage;
      if (storage) return storage;
    } catch {
      // file:// with storage disabled falls back to memory.
    }
  }
  const memory = new Map<string, string>();
  return { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => void memory.set(key, value), removeItem: (key) => void memory.delete(key) };
}

export type MockAuth = {
  session(): Session;
  // The signed-in account, or null.
  account(): Account | null;
  setupAdmin(input: CredentialsInput): AuthOutcome;
  register(input: CredentialsInput): AuthOutcome;
  login(input: CredentialsInput): AuthOutcome;
  logout(): AuthOutcome;
  changePassword(input: ChangePasswordInput): AuthOutcome;
  listAccounts(): AccountList;
  updateAccount(accountId: string, change: AccountUpdateInput): AccountListOutcome;
  rememberedCity(): string | null;
  rememberCity(city: string): void;
  forgetCity(): void;
};

type Stored = Account & { password: string; active: boolean; mustChangePassword: boolean };

export function createAuth(options: MockOptions): MockAuth {
  const storage = options.storage ?? defaultStorage();
  let accounts: Stored[] = options.auth === 'setup' ? [] : [{ ...MOCK_ACCOUNT, password: MOCK_PASSWORD, active: true, mustChangePassword: false }];
  let currentId: string | null = options.auth ? null : MOCK_ACCOUNT.accountId;
  let nextId = 2;

  const stored = () => accounts.find((account) => account.accountId === currentId) ?? null;
  const publicAccount = ({ accountId, username, role }: Stored): Account => ({ accountId, username, role });
  const session = (): Session => {
    const me = stored();
    if (me) return { status: me.mustChangePassword ? 'password_change_required' : 'signed_in', account: publicAccount(me) };
    return { status: accounts.length === 0 ? 'setup_required' : 'signed_out', account: null };
  };
  // Only a session that has no temporary password left acts as the account.
  const account = (): Account | null => {
    const me = stored();
    return me && !me.mustChangePassword ? publicAccount(me) : null;
  };
  const refuse = (code: string, message: string): AuthOutcome => ({ ok: false, error: { code, message } });
  const validate = (input: CredentialsInput): CredentialsInput | ActionError => {
    const parsed = CredentialsInputSchema.safeParse(input);
    return parsed.success ? parsed.data : { code: 'invalid_input', message: parsed.error.issues[0]?.message ?? '请求无效。' };
  };
  const create = (input: CredentialsInput, role: Account['role']): AuthOutcome => {
    const valid = validate(input);
    if ('code' in valid) return { ok: false, error: valid };
    if (accounts.some((candidate) => candidate.username === valid.username)) return refuse('username_taken', AUTH_ERRORS.usernameTaken);
    const created: Stored = { accountId: `A${nextId}`, username: valid.username, role, password: valid.password, active: true, mustChangePassword: false };
    nextId += 1;
    accounts.push(created);
    currentId = created.accountId;
    return { ok: true, session: session() };
  };
  const cityKey = () => `baox.mock.homeCity.${currentId ?? 'none'}`;
  const listAccounts = (): AccountList => ({
    accounts: [...accounts.filter((a) => a.role === 'admin'), ...accounts.filter((a) => a.role !== 'admin')].map((a) => ({ ...publicAccount(a), active: a.active, mustChangePassword: a.mustChangePassword })),
  });
  const refuseList = (code: string, message: string): AccountListOutcome => ({ ok: false, error: { code, message }, accountList: listAccounts() });

  return {
    session,
    account,
    setupAdmin: (input) => (accounts.length > 0 ? refuse('setup_done', AUTH_ERRORS.setupDone) : create(input, 'admin')),
    register: (input) => (accounts.length === 0 ? refuse('setup_required', AUTH_ERRORS.setupRequired) : create(input, 'user')),
    login(input) {
      const valid = validate(input);
      if ('code' in valid) return { ok: false, error: valid };
      const found = accounts.find((candidate) => candidate.username === valid.username && candidate.password === valid.password && candidate.active);
      if (!found) return refuse('invalid_credentials', AUTH_ERRORS.invalidCredentials);
      currentId = found.accountId;
      return { ok: true, session: session() };
    },
    logout() {
      currentId = null;
      return { ok: true, session: session() };
    },
    changePassword(input) {
      const me = stored();
      if (!me) return refuse('unauthenticated', AUTH_ERRORS.unauthenticated);
      const parsed = ChangePasswordInputSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input', parsed.error.issues[0]?.message ?? '请求无效。');
      if (parsed.data.currentPassword !== me.password) return refuse('wrong_password', ADMIN_ERRORS.wrongPassword);
      if (parsed.data.newPassword === me.password) return refuse('same_password', ADMIN_ERRORS.samePassword);
      accounts = accounts.map((a) => (a === me ? { ...a, password: parsed.data.newPassword, mustChangePassword: false } : a));
      return { ok: true, session: session() };
    },
    listAccounts,
    updateAccount(accountId, change) {
      if (account()?.role !== 'admin') return { ok: false, error: { code: 'forbidden', message: ADMIN_ERRORS.forbidden }, accountList: null };
      const target = accounts.find((a) => a.accountId === accountId);
      if (!target) return refuseList('account_not_found', ADMIN_ERRORS.accountNotFound);
      const dropsAdmin = target.role === 'admin' && target.active && (('role' in change && change.role === 'user') || ('active' in change && !change.active));
      if (dropsAdmin && accounts.filter((a) => a.role === 'admin' && a.active).length <= 1) return refuseList('last_admin', ADMIN_ERRORS.lastAdmin);
      const next: Stored =
        'role' in change
          ? { ...target, role: change.role }
          : 'active' in change
            ? { ...target, active: change.active }
            : { ...target, password: change.temporaryPassword, mustChangePassword: true };
      accounts = accounts.map((a) => (a === target ? next : a));
      // Deactivation and a temporary password sign the account out.
      if (accountId === currentId && (!next.active || next.mustChangePassword)) currentId = null;
      return { ok: true, accountList: listAccounts() };
    },
    rememberedCity: () => storage.getItem(cityKey()) || null,
    rememberCity: (city) => storage.setItem(cityKey(), city),
    forgetCity() {
      if (storage.removeItem) storage.removeItem(cityKey());
      else storage.setItem(cityKey(), '');
    },
  };
}
