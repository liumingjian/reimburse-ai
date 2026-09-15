import { z } from 'zod';
import { ActionErrorSchema, type ActionError } from './actions';
import { IdSchema } from './primitives';

// 应用账号 (app accounts, ADR-0018): local username + password accounts, independent of ERP accounts.
// The browser holds only an HttpOnly session cookie; every other endpoint answers 401 `unauthenticated` without it.

export const ACCOUNT_ROLES = ['user', 'admin'] as const;
export const AccountRoleSchema = z.enum(ACCOUNT_ROLES);
export type AccountRole = z.infer<typeof AccountRoleSchema>;

export const AccountSchema = z.object({
  accountId: IdSchema,
  username: z.string().min(1),
  role: AccountRoleSchema,
});
export type Account = z.infer<typeof AccountSchema>;

// setup_required: no account exists yet, the page offers only "create admin".
// signed_out: accounts exist, this browser has no live session (login or register).
// signed_in: `account` is who this browser acts as.
export const SESSION_STATUSES = ['setup_required', 'signed_out', 'signed_in'] as const;
export const SessionSchema = z.object({
  status: z.enum(SESSION_STATUSES),
  account: AccountSchema.nullable(),
});
export type Session = z.infer<typeof SessionSchema>;

export const USERNAME_MAX_LENGTH = 32;
export const PASSWORD_MIN_LENGTH = 8;

// Page and server share these messages.
export const AUTH_ERRORS = {
  usernameRequired: '请填写用户名。',
  usernameTooLong: `用户名最多 ${USERNAME_MAX_LENGTH} 个字符。`,
  passwordTooShort: `密码至少 ${PASSWORD_MIN_LENGTH} 位。`,
  usernameTaken: '这个用户名已被使用，请换一个。',
  invalidCredentials: '用户名或密码不对。',
  setupDone: '管理员已经创建，请登录或注册。',
  setupRequired: '还没有管理员，请先创建管理员。',
  unauthenticated: '请先登录。',
} as const;

// 发票占用 (invoice occupancy) is global; a clash with another account's task names no account and no task.
export const OCCUPANCY_COPY = {
  otherAccount: '这张发票已被另一个账号的任务占用。',
} as const;

export const UNAUTHENTICATED_CODE = 'unauthenticated';
export const UNAUTHENTICATED_HTTP_STATUS = 401;

// Setup, register and login take the same credentials. The username is trimmed; the password is taken as typed.
export const CredentialsInputSchema = z.object({
  username: z.string().trim().min(1, AUTH_ERRORS.usernameRequired).max(USERNAME_MAX_LENGTH, AUTH_ERRORS.usernameTooLong),
  password: z.string().min(PASSWORD_MIN_LENGTH, AUTH_ERRORS.passwordTooShort),
});
export type CredentialsInput = z.infer<typeof CredentialsInputSchema>;

export const AuthFailureSchema = z.object({ error: ActionErrorSchema });

// Auth actions answer the new session on success, `{ error }` otherwise.
export type AuthOutcome = { ok: true; session: Session } | { ok: false; error: ActionError };
