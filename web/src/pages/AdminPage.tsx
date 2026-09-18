import { useState } from 'react';
import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TextInput } from '@carbon/react';
import { AUTH_ERRORS, PASSWORD_MIN_LENGTH, PUBLIC_PROJECT_BOOK_COPY, type AccountListOutcome, type AccountUpdateInput, type AdminAccount, type AppAdapter } from '@baox/contract';
import { useAccounts, useAppStore, useSession } from '../adapter/context';
import { ActionError } from '../shell/ActionError';
import { AppShell } from '../shell/AppShell';
import { ConfirmDialog } from '../shell/Dialog';
import { PageHeader } from '../shell/PageHeader';
import { StatusTag } from '../shell/StatusTag';
import { ProjectBookPanel } from './ProjectBookPanel';

// 管理页 `#/admin`（#194，ADR-0018）：只有管理员看得到入口。上半是账号管理：设为管理员 / 取消管理员、停用 / 启用、
// 设置临时密码（对方下次登录必须先改密码）；账号只停用、不删除。下半是公共项目簿维护面板。
// 能否执行都由服务端判定（例如不能取消或停用最后一位管理员），页面只显示结果与原因。
export const ADMIN_COPY = {
  title: '管理',
  lead: '管理这台电脑上的应用账号和所有人共用的公共项目簿。账号只停用、不删除，停用账号的任务与记录都会保留。',
  accountsTitle: '应用账号',
  onlyAdmins: '只有管理员可以打开这个页面。',
  loading: '正在读取账号…',
  retry: '重试',
  roleAdmin: '管理员',
  roleUser: '用户',
  active: '在用',
  inactive: '已停用',
  mustChange: '待改密码',
  promote: '设为管理员',
  demote: '取消管理员',
  deactivate: '停用',
  reactivate: '启用',
  temporaryPassword: '设置临时密码',
  temporaryPasswordLabel: '临时密码',
  temporaryPasswordLead: (username: string) => `为 ${username} 设置临时密码。对方现有的登录会退出，用临时密码登录后必须先改成自己的密码。请当面或私下把临时密码告诉对方。`,
  temporaryPasswordConfirm: '设置',
  temporaryPasswordDone: (username: string) => `已为 ${username} 设置临时密码。`,
  you: '（你）',
} as const;

export function AdminPage() {
  const session = useSession();
  const account = session.data?.account ?? null;
  return (
    <AppShell nav="admin">
      <PageHeader title={ADMIN_COPY.title} lead={ADMIN_COPY.lead} />
      {account?.role === 'admin' ? (
        <>
          <AccountsSection myId={account.accountId} />
          <section className="app-block" aria-label={PUBLIC_PROJECT_BOOK_COPY.title}>
            <h2 className="app-section-title">{PUBLIC_PROJECT_BOOK_COPY.title}</h2>
            <p className="app-lead">{PUBLIC_PROJECT_BOOK_COPY.lead}</p>
            <ProjectBookPanel scope="public" primaryIntake={false} canMaintain />
          </section>
        </>
      ) : (
        <p className="app-empty">{ADMIN_COPY.onlyAdmins}</p>
      )}
    </AppShell>
  );
}

function AccountsSection({ myId }: { myId: string }) {
  const store = useAppStore();
  const accounts = useAccounts();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resetting, setResetting] = useState<AdminAccount | null>(null);
  const [password, setPassword] = useState('');
  const [dialogError, setDialogError] = useState<string | null>(null);

  const run = async (accountId: string, change: AccountUpdateInput): Promise<AccountListOutcome> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const outcome = await store.accountAction((adapter: AppAdapter) => adapter.updateAccount(accountId, change));
    setBusy(false);
    if (!outcome.ok) setError(outcome.error.message);
    return outcome;
  };

  const closeReset = () => {
    setResetting(null);
    setPassword('');
    setDialogError(null);
  };

  const confirmReset = async () => {
    if (!resetting) return;
    if (password.length < PASSWORD_MIN_LENGTH) {
      setDialogError(AUTH_ERRORS.passwordTooShort);
      return;
    }
    const outcome = await run(resetting.accountId, { temporaryPassword: password });
    if (!outcome.ok) {
      setDialogError(outcome.error.message);
      return;
    }
    setNotice(ADMIN_COPY.temporaryPasswordDone(resetting.username));
    closeReset();
  };

  const rows = accounts.data?.accounts ?? [];
  return (
    <section className="app-block" aria-label={ADMIN_COPY.accountsTitle}>
      <h2 className="app-section-title">{ADMIN_COPY.accountsTitle}</h2>
      {accounts.data === null && accounts.status === 'error' ? (
        <div className="app-empty">
          <p>{accounts.error}</p>
          <Button kind="secondary" onClick={() => void store.loadAccounts()}>
            {ADMIN_COPY.retry}
          </Button>
        </div>
      ) : accounts.data === null ? (
        <p className="app-loading">{ADMIN_COPY.loading}</p>
      ) : (
        <div className="bleed app-table">
          <Table aria-label={ADMIN_COPY.accountsTitle}>
            <TableHead>
              <TableRow>
                <TableHeader>用户名</TableHeader>
                <TableHeader>角色</TableHeader>
                <TableHeader>状态</TableHeader>
                <TableHeader className="app-sticky-end" aria-label="操作" />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.accountId} data-testid={`account-row-${row.username}`}>
                  <TableCell>
                    {row.username}
                    {row.accountId === myId ? <span className="app-muted">{ADMIN_COPY.you}</span> : null}
                  </TableCell>
                  <TableCell>{row.role === 'admin' ? ADMIN_COPY.roleAdmin : ADMIN_COPY.roleUser}</TableCell>
                  <TableCell>
                    <StatusTag tone={row.active ? 'success' : 'locked'}>{row.active ? ADMIN_COPY.active : ADMIN_COPY.inactive}</StatusTag>
                    {row.mustChangePassword ? <StatusTag tone="warning">{ADMIN_COPY.mustChange}</StatusTag> : null}
                  </TableCell>
                  <TableCell className="app-num app-sticky-end">
                    <div className="app-btn-row">
                      {/* 自己这一行不给「取消管理员」和「停用」：服务端也会拒绝（self_change），这里就不摆出来了。 */}
                      {row.accountId === myId ? null : (
                        <>
                          <Button kind="ghost" size="sm" disabled={busy} onClick={() => void run(row.accountId, { role: row.role === 'admin' ? 'user' : 'admin' })}>
                            {row.role === 'admin' ? ADMIN_COPY.demote : ADMIN_COPY.promote}
                          </Button>
                          <Button kind="ghost" size="sm" disabled={busy} onClick={() => void run(row.accountId, { active: !row.active })}>
                            {row.active ? ADMIN_COPY.deactivate : ADMIN_COPY.reactivate}
                          </Button>
                        </>
                      )}
                      <Button kind="ghost" size="sm" disabled={busy} onClick={() => setResetting(row)}>
                        {ADMIN_COPY.temporaryPassword}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <ActionError message={error} />
      {notice ? (
        <p className="app-caption" role="status">
          {notice}
        </p>
      ) : null}
      {resetting ? (
        <ConfirmDialog
          title={ADMIN_COPY.temporaryPassword}
          confirmLabel={ADMIN_COPY.temporaryPasswordConfirm}
          busy={busy}
          error={dialogError}
          focusCancel={false}
          onConfirm={() => void confirmReset()}
          onCancel={closeReset}
        >
          <p>{ADMIN_COPY.temporaryPasswordLead(resetting.username)}</p>
          <TextInput
            id="temporary-password"
            labelText={ADMIN_COPY.temporaryPasswordLabel}
            autoComplete="off"
            data-modal-primary-focus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
