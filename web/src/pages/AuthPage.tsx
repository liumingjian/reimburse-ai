import { useEffect, useState, type FormEvent } from 'react';
import { Button, TextInput } from '@carbon/react';
import { CredentialsInputSchema, type AppAdapter, type AuthOutcome, type CredentialsInput, type Session } from '@baox/contract';
import { useAppStore } from '../adapter/context';
import { ActionError } from '../shell/ActionError';
import { AppShell } from '../shell/AppShell';

// 应用账号 (app accounts, ADR-0018): before anything else the browser needs a session. Which form shows is decided by
// the server's session status: no account yet → create the admin; otherwise log in, or register a new account.
// The route stays as it is, so a deep link opens in place once signed in.
export const AUTH_COPY = {
  setupTitle: '创建管理员',
  setupLead: '这台电脑上还没有应用账号。先创建管理员账号：它是第一个账号，创建后其他人可以自行注册。',
  loginTitle: '登录',
  loginLead: '用你的应用账号登录。应用账号只在这台电脑上使用，与报销系统的账号无关。',
  registerTitle: '注册',
  registerLead: '注册一个新的应用账号。你的报销任务、个人项目簿和常驻城市只有你自己看得到。',
  username: '用户名',
  password: '密码',
  setupSubmit: '创建管理员',
  loginSubmit: '登录',
  registerSubmit: '注册',
  toRegister: '没有账号？注册',
  toLogin: '已有账号？登录',
  checking: '正在读取登录状态…',
  loadFailed: '登录状态读取失败',
  retry: '重试',
} as const;

type Mode = 'setup' | 'login' | 'register';

const MODES: Readonly<Record<Mode, { title: string; lead: string; submit: string; run: (adapter: AppAdapter, input: CredentialsInput) => Promise<AuthOutcome> }>> = {
  setup: { title: AUTH_COPY.setupTitle, lead: AUTH_COPY.setupLead, submit: AUTH_COPY.setupSubmit, run: (adapter, input) => adapter.setupAdmin(input) },
  login: { title: AUTH_COPY.loginTitle, lead: AUTH_COPY.loginLead, submit: AUTH_COPY.loginSubmit, run: (adapter, input) => adapter.login(input) },
  register: { title: AUTH_COPY.registerTitle, lead: AUTH_COPY.registerLead, submit: AUTH_COPY.registerSubmit, run: (adapter, input) => adapter.register(input) },
};

function CredentialsForm({ mode, onSwitch }: { mode: Mode; onSwitch: (() => void) | null }) {
  const store = useAppStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof CredentialsInput, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const copy = MODES[mode];

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const parsed = CredentialsInputSchema.safeParse({ username, password });
    if (!parsed.success) {
      const errors: Partial<Record<keyof CredentialsInput, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof CredentialsInput;
        errors[key] ??= issue.message;
      }
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setError(null);
    setBusy(true);
    const outcome = await store.auth((adapter) => copy.run(adapter, parsed.data));
    setBusy(false);
    if (!outcome.ok) setError(outcome.error.message);
  };

  return (
    <section className="app-form-page app-startup" aria-labelledby="auth-title">
      <h1 className="app-page-title" id="auth-title">
        {copy.title}
      </h1>
      <p className="app-lead">{copy.lead}</p>
      <form className="app-form" onSubmit={(event) => void submit(event)} noValidate>
        <TextInput
          id="auth-username"
          name="username"
          labelText={AUTH_COPY.username}
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          invalid={fieldErrors.username !== undefined}
          invalidText={<span role="alert">{fieldErrors.username}</span>}
        />
        <TextInput
          id="auth-password"
          name="password"
          type="password"
          labelText={AUTH_COPY.password}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          invalid={fieldErrors.password !== undefined}
          invalidText={<span role="alert">{fieldErrors.password}</span>}
        />
        <div className="app-btn-row">
          <Button type="submit" disabled={busy}>
            {copy.submit}
          </Button>
          {onSwitch ? (
            <Button kind="ghost" onClick={onSwitch}>
              {mode === 'login' ? AUTH_COPY.toRegister : AUTH_COPY.toLogin}
            </Button>
          ) : null}
          <ActionError message={error} />
        </div>
      </form>
    </section>
  );
}

export function AuthPage({ session }: { session: Session }) {
  const [register, setRegister] = useState(false);
  const mode: Mode = session.status === 'setup_required' ? 'setup' : register ? 'register' : 'login';
  const title = MODES[mode].title;
  useEffect(() => {
    document.title = `baox · ${title}`;
  }, [title]);
  return (
    <AppShell nav="tasks">
      {/* key: switching modes starts from an empty form. */}
      <CredentialsForm key={mode} mode={mode} onSwitch={mode === 'setup' ? null : () => setRegister(!register)} />
    </AppShell>
  );
}

// Before the session has been read; on a read failure (not an unreachable server) says why and offers a retry.
export function AuthPending({ error }: { error: string | null }) {
  const store = useAppStore();
  return (
    <AppShell nav="tasks">
      {error ? (
        <div className="app-empty">
          <h2>{AUTH_COPY.loadFailed}</h2>
          <p>{error}</p>
          <Button kind="secondary" onClick={() => void store.loadSession()}>
            {AUTH_COPY.retry}
          </Button>
        </div>
      ) : (
        <p className="app-loading">{AUTH_COPY.checking}</p>
      )}
    </AppShell>
  );
}
