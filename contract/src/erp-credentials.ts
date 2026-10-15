import { z } from 'zod';
import type { ActionError } from './actions';

// ERP 凭据 (ADR-0033): the employee's ERP account and password, saved once in their own settings so the baox 本地执行器
// on their PC can sign in to ERP for each 去报销 and 对账. The server keeps the password encrypted with a key only it
// holds and never shows it again; each job carries it down to the 本地执行器, which keeps nothing on disk.
//
// none: nothing saved. untested: saved, but no 试登录 has succeeded yet (no 本地执行器 was connected, or the attempt
// did not finish). authorised: the last 试登录 succeeded, which is what ERP 自动化授权 needs. refused: ERP refused the
// password, so it was deleted at once and baox will not try it again; the employee saves a new one.
export const ERP_CREDENTIAL_STATUSES = ['none', 'untested', 'authorised', 'refused'] as const;
export type ErpCredentialStatus = (typeof ERP_CREDENTIAL_STATUSES)[number];

export const ErpCredentialsViewSchema = z.object({
  // False when this server has no key to encrypt with: nothing can be saved.
  available: z.boolean(),
  status: z.enum(ERP_CREDENTIAL_STATUSES),
  // The ERP account is shown back so the employee knows which one is saved; the password never is.
  erpAccount: z.string().nullable(),
  savedAt: z.string().nullable(),
  checkedAt: z.string().nullable(),
  // Why the last 试登录 did not succeed, in the employee's words; null after a success or before any attempt.
  message: z.string().nullable(),
});
export type ErpCredentialsView = z.infer<typeof ErpCredentialsViewSchema>;

export const SaveErpCredentialsInputSchema = z.object({
  account: z.string().trim().min(1, '请填写报销系统账号。').max(128),
  password: z.string().min(1, '请填写报销系统密码。').max(256),
});
export type SaveErpCredentialsInput = z.infer<typeof SaveErpCredentialsInputSchema>;

// Saving, 试登录 and clearing answer the new view; !ok only when the request itself was refused. A 试登录 that ran and
// failed is not a refusal: it is the view's `status` and `message`.
export type ErpCredentialsOutcome = { ok: true; credentials: ErpCredentialsView } | { ok: false; error: ActionError; credentials: ErpCredentialsView | null };

// Said before every save and before 去报销 (ADR-0033): baox's login takes the ERP account's seat.
export const ERP_SIGN_IN_KNOCKS_OFF = '每次 baox 登录报销系统（保存后的试登录、每次去报销和对账），都会把这个报销系统账号在别处的登录挤下线。';

export const ERP_CREDENTIAL_ERRORS = {
  unavailable: '这台服务器还没有配置报销系统账号密码的加密密钥，暂时不能保存报销系统账号密码。请联系管理员。',
  nothingSaved: '还没有保存报销系统账号密码，没有可以试登录的。',
  erpInUse: '这个账号正在去报销或对账，现在试登录会把它挤下线。请等它结束再试。',
  notPaired: '已保存，还没有试登录：这个账号还没有配对 baox 本地执行器。请在电脑上用设置页「浏览器扩展」一节的配对码配对本地执行器，运行它，再点「试登录」。',
  noExecutor: '已保存，还没有试登录：这个账号没有连上的 baox 本地执行器。请在电脑上运行本地执行器，再点「试登录」。',
  notLocalExecutor: '已保存，还没有试登录：这个账号配对的是浏览器扩展，不是 baox 本地执行器。报销系统账号密码只给本地执行器用。',
  timedOut: '已保存，但 baox 本地执行器在 5 分钟内没有回答试登录。请确认它在运行，再点「试登录」。',
  // 去报销 / 对账 through a 本地执行器 without authorised 凭据: nothing is started.
  missing: '还没有试登录成功的报销系统账号密码，所以现在去报销不了。请先到设置页的「报销系统账号」一节保存账号密码并试登录成功。',
} as const;

export const ERP_CREDENTIALS_MISSING_CODE = 'erp_credentials_missing';
