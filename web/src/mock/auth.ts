import { AUTH_ERRORS, CredentialsInputSchema, type Account, type ActionError, type AuthOutcome, type CredentialsInput, type Session } from '@baox/contract';
import type { MockOptions, MockStorage } from './options';

// The mock server's 应用账号 (app accounts): accounts and the session live in memory, so a reload starts over from the
// `?auth=` option. By default the fixture account is signed in; `?auth=signed-out` starts at login, `?auth=setup`
// with no account at all. The remembered home city is per account in persistent storage (localStorage in the browser).

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
  rememberedCity(): string | null;
  rememberCity(city: string): void;
  forgetCity(): void;
};

export function createAuth(options: MockOptions): MockAuth {
  const storage = options.storage ?? defaultStorage();
  const accounts: Array<Account & { password: string }> = options.auth === 'setup' ? [] : [{ ...MOCK_ACCOUNT, password: MOCK_PASSWORD }];
  let current: Account | null = options.auth ? null : MOCK_ACCOUNT;
  let nextId = 2;

  const session = (): Session => (current ? { status: 'signed_in', account: current } : { status: accounts.length === 0 ? 'setup_required' : 'signed_out', account: null });
  const refuse = (code: string, message: string): AuthOutcome => ({ ok: false, error: { code, message } });
  const validate = (input: CredentialsInput): CredentialsInput | ActionError => {
    const parsed = CredentialsInputSchema.safeParse(input);
    return parsed.success ? parsed.data : { code: 'invalid_input', message: parsed.error.issues[0]?.message ?? '请求无效。' };
  };
  const create = (input: CredentialsInput, role: Account['role']): AuthOutcome => {
    const valid = validate(input);
    if ('code' in valid) return { ok: false, error: valid };
    if (accounts.some((account) => account.username === valid.username)) return refuse('username_taken', AUTH_ERRORS.usernameTaken);
    const account: Account = { accountId: `A${nextId}`, username: valid.username, role };
    nextId += 1;
    accounts.push({ ...account, password: valid.password });
    current = account;
    return { ok: true, session: session() };
  };
  const cityKey = () => `baox.mock.homeCity.${current?.accountId ?? 'none'}`;

  return {
    session,
    account: () => current,
    setupAdmin: (input) => (accounts.length > 0 ? refuse('setup_done', AUTH_ERRORS.setupDone) : create(input, 'admin')),
    register: (input) => (accounts.length === 0 ? refuse('setup_required', AUTH_ERRORS.setupRequired) : create(input, 'user')),
    login(input) {
      const valid = validate(input);
      if ('code' in valid) return { ok: false, error: valid };
      const found = accounts.find((account) => account.username === valid.username && account.password === valid.password);
      if (!found) return refuse('invalid_credentials', AUTH_ERRORS.invalidCredentials);
      current = { accountId: found.accountId, username: found.username, role: found.role };
      return { ok: true, session: session() };
    },
    logout() {
      current = null;
      return { ok: true, session: session() };
    },
    rememberedCity: () => storage.getItem(cityKey()) || null,
    rememberCity: (city) => storage.setItem(cityKey(), city),
    forgetCity() {
      if (storage.removeItem) storage.removeItem(cityKey());
      else storage.setItem(cityKey(), '');
    },
  };
}
