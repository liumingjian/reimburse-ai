import { HTTP_ENDPOINTS, SaveErpCredentialsInputSchema } from '@baox/contract';
import type { Hono } from 'hono';
import { AuthRefusal } from '../accounts/accounts';
import { accountOf, type AppEnv } from '../accounts/http';
import type { ErpCredentialService } from './hosted-sign-in';

// ERP 凭据 over HTTP (ADR-0033), behind the session gate: each account reads and changes only its own. No answer ever
// carries the password; saving and 试登录 answer once the 试登录 has come back (or could not be run).
export function mountErpCredentialRoutes(app: Hono<AppEnv>, credentials: ErpCredentialService): void {
  app.get(HTTP_ENDPOINTS.getErpCredentials.path, async (c) => c.json(await credentials.view(accountOf(c).accountId)));
  app.post(HTTP_ENDPOINTS.saveErpCredentials.path, async (c) => {
    const input = SaveErpCredentialsInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new AuthRefusal(400, 'invalid_input', input.error.issues[0]?.message ?? '请填写 ERP 账号和密码。');
    return c.json(await credentials.save(accountOf(c).accountId, input.data));
  });
  app.post(HTTP_ENDPOINTS.testErpCredentials.path, async (c) => c.json(await credentials.test(accountOf(c).accountId)));
  app.post(HTTP_ENDPOINTS.clearErpCredentials.path, async (c) => c.json(await credentials.clear(accountOf(c).accountId)));
}
