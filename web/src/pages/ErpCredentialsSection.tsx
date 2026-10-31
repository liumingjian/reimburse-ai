import { useEffect, useState } from 'react';
import { Button, InlineNotification, TextInput } from '@carbon/react';
import { ERP_SIGN_IN_KNOCKS_OFF, type ErpCredentialStatus, type ErpCredentialsOutcome, type ErpCredentialsView } from '@baox/contract';
import { useAppStore } from '../adapter/context';
import { formatDateTime } from '../format';
import { ActionGroup } from '../shell/ActionGroup';
import { ConfirmDialog } from '../shell/Dialog';

// ERP 凭据 (ADR-0033): the ERP account and password the baox 本地执行器 signs in with for each 去报销 and 对账. The
// password field is write-only: what was saved is never shown, only the account and whether the 试登录 succeeded. Every
// save runs a 试登录 on the employee's PC through the paired 本地执行器, which takes up to a few minutes, and every
// login there knocks the ERP account's other logins off, which is said before saving.
// It renders inside the 本地执行器 section of the 设置页 (#429).

export const ERP_CREDENTIALS_COPY = {
  title: '报销系统账号密码',
  lead: 'baox 本地执行器在你的电脑上替你登录报销系统时用的账号和密码。密码加密保存在应用服务器上，保存后谁都看不到，你可以随时清除。',
  account: '报销系统账号',
  password: '报销系统密码',
  passwordHint: '保存后不再显示。要换密码就重新填写保存。',
  save: '保存并试登录',
  replace: '换一组账号密码',
  trying: '正在电脑上试登录，最长约 5 分钟…',
  test: '再试登录一次',
  clear: '清除报销系统账号密码',
  clearTitle: '清除报销系统账号密码？',
  clearBody: '清除后，baox 本地执行器不能再替你登录报销系统，去报销会停在开始之前。要恢复就重新保存。',
  unavailable: '这台服务器还没有配置报销系统账号密码的加密密钥，暂时不能保存。请联系管理员。',
  loading: '正在读取报销系统账号密码情况…',
  loadFailed: '报销系统账号密码情况加载失败',
  retryLoad: '重新加载',
  savedAccount: '已保存的账号',
  checkedAt: '最近一次试登录',
} as const;

export const ERP_CREDENTIAL_STATUS_LABELS: Record<ErpCredentialStatus, string> = {
  none: '还没有保存',
  untested: '已保存，还没有试登录成功',
  authorised: '试登录成功，可以去报销',
  refused: '报销系统拒绝了这个密码，已删除',
};

export function ErpCredentialsSection() {
  const store = useAppStore();
  const [view, setView] = useState<ErpCredentialsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | 'clear' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = async () => {
    setLoadError(null);
    try {
      setView(await store.adapter.getErpCredentials());
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  useEffect(() => {
    void load();
    // Loaded once per visit; every action answers the new view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (which: 'save' | 'test' | 'clear', run: () => Promise<ErpCredentialsOutcome>) => {
    setBusy(which);
    setError(null);
    const outcome = await run();
    setBusy(null);
    if (!outcome.ok) {
      setError(outcome.error.message);
      return;
    }
    setView(outcome.credentials);
    setConfirming(false);
    if (which !== 'test') {
      setPassword('');
      setEditing(false);
    }
  };

  const saved = view !== null && view.status !== 'none';
  const showForm = view !== null && view.available && (!saved || view.status === 'refused' || editing);
  return (
    <section className="app-form-section" aria-label={ERP_CREDENTIALS_COPY.title}>
      <h3 className="app-section-title">{ERP_CREDENTIALS_COPY.title}</h3>
      <p>{ERP_CREDENTIALS_COPY.lead}</p>
      {loadError ? (
        <div className="app-empty">
          <p>{ERP_CREDENTIALS_COPY.loadFailed}</p>
          <p>{loadError}</p>
          <Button size="md" kind="secondary" onClick={() => void load()}>
            {ERP_CREDENTIALS_COPY.retryLoad}
          </Button>
        </div>
      ) : !view ? (
        <p className="app-loading" role="status">
          {ERP_CREDENTIALS_COPY.loading}
        </p>
      ) : !view.available ? (
        <InlineNotification kind="info" lowContrast hideCloseButton title={ERP_CREDENTIALS_COPY.unavailable} />
      ) : (
        <>
          <h4>{ERP_CREDENTIAL_STATUS_LABELS[view.status]}</h4>
          {view.erpAccount ? (
            <p>
              {ERP_CREDENTIALS_COPY.savedAccount}：{view.erpAccount}
              {view.checkedAt ? `；${ERP_CREDENTIALS_COPY.checkedAt}：${formatDateTime(view.checkedAt)}` : ''}
            </p>
          ) : null}
          {view.employeeProfile.status === 'ready' ? (
            <p>报销汇总表员工信息：{view.employeeProfile.name}；部门：{view.employeeProfile.department}</p>
          ) : saved ? (
            <InlineNotification kind="warning" lowContrast hideCloseButton title={view.employeeProfile.status === 'failed' ? view.employeeProfile.message : '尚未读取报销汇总表员工信息，请重新试登录读取。'} />
          ) : null}
          {view.message ? <InlineNotification kind={view.status === 'refused' ? 'error' : 'warning'} lowContrast hideCloseButton title={view.message} /> : null}
          {showForm ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void act('save', () => store.adapter.saveErpCredentials({ account, password }));
              }}
            >
              <TextInput id="erp-account" labelText={ERP_CREDENTIALS_COPY.account} autoComplete="off" value={account} onChange={(event) => setAccount(event.target.value)} />
              <TextInput id="erp-password" type="password" labelText={ERP_CREDENTIALS_COPY.password} helperText={ERP_CREDENTIALS_COPY.passwordHint} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
              <p>{ERP_SIGN_IN_KNOCKS_OFF}</p>
              <ActionGroup>
                <Button type="submit" size="md" disabled={busy !== null || !account.trim() || !password}>
                  {busy === 'save' ? ERP_CREDENTIALS_COPY.trying : ERP_CREDENTIALS_COPY.save}
                </Button>
              </ActionGroup>
            </form>
          ) : null}
          {saved && view.status !== 'refused' ? (
            <ActionGroup>
              <Button kind="secondary" size="md" disabled={busy !== null} onClick={() => void act('test', () => store.adapter.testErpCredentials())}>
                {busy === 'test' ? ERP_CREDENTIALS_COPY.trying : ERP_CREDENTIALS_COPY.test}
              </Button>
              {!editing ? (
                <Button kind="tertiary" size="md" disabled={busy !== null} onClick={() => setEditing(true)}>
                  {ERP_CREDENTIALS_COPY.replace}
                </Button>
              ) : null}
              <Button kind="danger--tertiary" size="md" disabled={busy !== null} onClick={() => setConfirming(true)}>
                {ERP_CREDENTIALS_COPY.clear}
              </Button>
            </ActionGroup>
          ) : null}
          {error ? <InlineNotification kind="error" lowContrast hideCloseButton title={error} /> : null}
        </>
      )}
      {confirming ? (
        <ConfirmDialog
          danger
          title={ERP_CREDENTIALS_COPY.clearTitle}
          confirmLabel={ERP_CREDENTIALS_COPY.clear}
          busy={busy === 'clear'}
          error={error}
          onConfirm={() => void act('clear', () => store.adapter.clearErpCredentials())}
          onCancel={() => {
            setConfirming(false);
            setError(null);
          }}
        >
          <p>{ERP_CREDENTIALS_COPY.clearBody}</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
