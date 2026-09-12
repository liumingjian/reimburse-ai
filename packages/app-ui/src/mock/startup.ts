import { STARTUP_ERRORS, type ActionError, type ConfirmIdentityInput } from '../contract/actions';
import type { Employee, ErpSession } from '../contract/task-list';
import { LOGIN_IDENTITY } from './fixtures/tasks';
import type { MockOptions, MockStorage } from './options';

// mock 服务端的启动状态：报销系统登录会话、报销人身份登记、按身份记住的常驻城市。
// 身份登记与常驻城市写进持久存储（浏览器里是 localStorage），按 tenant + account 分键，所以刷新后仍在；登录会话不持久，
// `?erp=logged-out` 每次打开都从未登录开始。

type Identity = Omit<Employee, 'binding'>;

const identityKey = (kind: 'identity' | 'homeCity', id: Identity) => `baox.mock.${kind}.${id.tenant}/${id.account}`;

// 浏览器里用 localStorage；没有 window（node 环境的单测）或读不到时用一份内存替身。
export function defaultStorage(): MockStorage {
  if (typeof window !== 'undefined') {
    try {
      const storage = window.localStorage;
      if (storage) return storage;
    } catch {
      // file:// 下禁用存储时退回内存。
    }
  }
  const memory = new Map<string, string>();
  return { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => void memory.set(key, value), removeItem: (key) => void memory.delete(key) };
}

export type MockStartup = {
  erpSession(): ErpSession;
  employee(): Employee | null;
  complete(): boolean;
  recheckErpSession(): ActionError | null;
  confirmIdentity(input: ConfirmIdentityInput): ActionError | null;
  rememberedCity(): string | null;
  rememberCity(city: string): void;
  // 完全重置：清掉身份登记与常驻城市，登录会话也断开（回到启动页，重新登录后要重新确认身份）。
  reset(): void;
};

export function createStartup(options: MockOptions): MockStartup {
  const storage = options.storage ?? defaultStorage();
  const identity: Identity = LOGIN_IDENTITY;
  let erpSession: ErpSession = options.erpLoggedOut ? 'not_logged_in' : 'logged_in';
  // 不给 `?identity=`：未登录场景下登录后要确认身份，其余场景已登记。此前在这台浏览器里确认过的身份不再询问。
  let binding: Employee['binding'] = options.identity ?? (options.erpLoggedOut ? 'unbound' : 'bound');
  if (binding === 'unbound' && storage.getItem(identityKey('identity', identity)) === 'bound') binding = 'bound';

  const complete = () => erpSession === 'logged_in' && binding === 'bound';

  return {
    erpSession: () => erpSession,
    employee: () => (erpSession === 'logged_in' ? { ...identity, binding } : null),
    complete,
    // 「我已登录」：mock 的第一次再探测就检测到登录。
    recheckErpSession() {
      erpSession = 'logged_in';
      return null;
    },
    confirmIdentity(input) {
      if (erpSession !== 'logged_in') return { code: 'not_logged_in', message: STARTUP_ERRORS.notLoggedIn };
      if (binding === 'mismatched') return { code: 'identity_mismatched', message: STARTUP_ERRORS.identityMismatched };
      if (input.account !== identity.account || input.tenant !== identity.tenant) return { code: 'identity_changed', message: STARTUP_ERRORS.identityChanged };
      binding = 'bound';
      storage.setItem(identityKey('identity', identity), 'bound');
      return null;
    },
    rememberedCity: () => storage.getItem(identityKey('homeCity', identity)),
    rememberCity(city) {
      storage.setItem(identityKey('homeCity', identity), city);
    },
    reset() {
      for (const kind of ['identity', 'homeCity'] as const) {
        const key = identityKey(kind, identity);
        if (storage.removeItem) storage.removeItem(key);
        else storage.setItem(key, '');
      }
      erpSession = 'not_logged_in';
      binding = 'unbound';
    },
  };
}
