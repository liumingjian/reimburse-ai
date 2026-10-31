import type { ErpCredentialsOutcome, ErpCredentialsView, SaveErpCredentialsInput } from '@baox/contract';

// ERP 凭据 as the mock server plays them. There is no 本地执行器 in the mock, so every 试登录 succeeds except for the
// password `wrong`, which ERP "refuses": the password is dropped, as on the server.

const NONE: ErpCredentialsView = { employeeProfile: { status: 'missing' }, available: true, status: 'none', erpAccount: null, savedAt: null, checkedAt: null, message: null };

export type ErpCredentialsFlow = {
  getErpCredentials(): Promise<ErpCredentialsView>;
  saveErpCredentials(input: SaveErpCredentialsInput): Promise<ErpCredentialsOutcome>;
  testErpCredentials(): Promise<ErpCredentialsOutcome>;
  clearErpCredentials(): Promise<ErpCredentialsOutcome>;
};

export function createErpCredentialsFlow(): ErpCredentialsFlow {
  let current = NONE;
  let password: string | null = null;
  const trial = (): ErpCredentialsView => {
    const at = new Date().toISOString();
    return password === 'wrong'
      ? { ...current, status: 'refused', checkedAt: at, message: '报销系统拒绝了这组账号密码：密码错误。baox 不会再用它重试。' }
      : { ...current, status: 'authorised', checkedAt: at, message: null };
  };
  return {
    getErpCredentials: async () => current,
    async saveErpCredentials(input) {
      password = input.password;
      current = { ...NONE, status: 'untested', erpAccount: input.account.trim(), savedAt: new Date().toISOString() };
      current = trial();
      if (current.status === 'refused') password = null;
      return { ok: true, credentials: current };
    },
    async testErpCredentials() {
      if (password === null) return { ok: false, error: { code: 'erp_credentials_none', message: '还没有保存报销系统账号密码，没有可以试登录的。' }, credentials: null };
      current = trial();
      return { ok: true, credentials: current };
    },
    async clearErpCredentials() {
      password = null;
      current = NONE;
      return { ok: true, credentials: current };
    },
  };
}
