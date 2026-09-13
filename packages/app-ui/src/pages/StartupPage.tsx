import { useEffect, useState } from 'react';
import { Button, InlineNotification, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@carbon/react';
import { useAppStore } from '../adapter/context';
import type { AppAdapter, StartupOutcome } from '../contract/adapter';
import type { Employee, TaskList } from '../contract/task-list';
import { ActionError } from '../shell/ActionError';
import { AppShell } from '../shell/AppShell';

// 启动页：任何任务之前先登录报销系统、确认报销人身份（内核 env_not_logged_in / env_identity_unknown /
// env_identity_unbound / env_identity_mismatched，next.mjs:654-727）。显示哪一态完全由服务端的 erpSession 与 employee.binding 决定；
// 「我已登录」只请服务端再探测，「确认」只登记服务端读到的身份，页面不断言、不改值。
export const STARTUP_COPY = {
  loginTitle: '登录报销系统',
  loginLead: '请在报销系统中使用本人账号登录。登录完成后点「我已登录」继续。',
  loginCaption: '登录页上显示的上次登录账号不算已登录；检测到登录表单消失、读到当前身份后才会继续。',
  unknownLead: '暂时无法确认报销系统当前登录的是谁。请检查登录页面，完成后点「我已登录」。身份未确认前不会继续。',
  loggedIn: '我已登录',
  identityTitle: '确认报销人身份',
  identityLead: '当前登录身份还没有登记。请核对身份表；确认是本人后点「确认」。如果不是，请先在报销系统切换到本人账号。',
  identityCaption: '绑定判据是登录账号加账套，不含姓名。表里的值都读自报销系统当前登录，不能修改；记下之后这台电脑就只替这个身份报销。',
  confirm: '确认',
  mismatchTitle: '报销人身份不一致',
  mismatchLead: '当前登录身份与已登记的报销人不一致。请在报销系统切换回本人账号；已有报销不能中途更换报销人。',
  mismatchCaption: '判据是登录账号加账套，换账套也算换人。切换回本人账号后刷新本页。',
  checking: '正在检查报销系统登录与报销人身份…',
  loadFailed: '启动状态读取失败',
  retry: '重试',
} as const;

function useStartupAction() {
  const store = useAppStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: (adapter: AppAdapter) => Promise<StartupOutcome>) => {
    setBusy(true);
    setError(null);
    const outcome = await store.startup(action);
    setBusy(false);
    if (!outcome.ok) setError(outcome.error.message);
  };
  return { busy, error, run };
}

// 启动页是表单页：内容限宽，不画卡片边框。
function StartupSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="app-form-page app-startup" aria-labelledby="startup-title">
      <h1 className="app-page-title" id="startup-title">
        {title}
      </h1>
      {children}
    </section>
  );
}

function LoginStep({ identityUnknown }: { identityUnknown: boolean }) {
  const { busy, error, run } = useStartupAction();
  return (
    <StartupSection title={STARTUP_COPY.loginTitle}>
      <p className="app-lead">{identityUnknown ? STARTUP_COPY.unknownLead : STARTUP_COPY.loginLead}</p>
      <p className="app-caption">{STARTUP_COPY.loginCaption}</p>
      <div className="app-btn-row">
        <Button disabled={busy} onClick={() => void run((adapter) => adapter.recheckErpSession())}>
          {STARTUP_COPY.loggedIn}
        </Button>
        <ActionError message={error} />
      </div>
    </StartupSection>
  );
}

function IdentityStep({ employee }: { employee: Employee }) {
  const { busy, error, run } = useStartupAction();
  const rows: ReadonlyArray<readonly [string, string, string]> = [
    ['姓名', employee.displayName, '只给你认人，不作判据'],
    ['登录账号', employee.account, '判据'],
    ['账套', employee.tenant, '判据，换账套等于换人'],
  ];
  return (
    <StartupSection title={STARTUP_COPY.identityTitle}>
      <p className="app-lead">{STARTUP_COPY.identityLead}</p>
      <Table aria-label="报销人身份" size="md">
        <TableHead>
          <TableRow>
            <TableHeader scope="col">项</TableHeader>
            <TableHeader scope="col">当前登录信息</TableHeader>
            <TableHeader scope="col">说明</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map(([field, value, note]) => (
            <TableRow key={field}>
              <TableHeader scope="row">{field}</TableHeader>
              <TableCell className={field === '姓名' ? '' : 'app-code'}>{value}</TableCell>
              <TableCell className="app-muted">{note}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="app-caption">{STARTUP_COPY.identityCaption}</p>
      <div className="app-btn-row">
        <Button disabled={busy} onClick={() => void run((adapter) => adapter.confirmIdentity({ account: employee.account, tenant: employee.tenant }))}>
          {STARTUP_COPY.confirm}
        </Button>
        <ActionError message={error} />
      </div>
    </StartupSection>
  );
}

// 身份不一致：整页阻塞，没有任何可推进的按钮。
function MismatchStep() {
  return (
    <StartupSection title={STARTUP_COPY.mismatchTitle}>
      <InlineNotification kind="error" role="alert" lowContrast hideCloseButton statusIconDescription="错误" title={STARTUP_COPY.mismatchLead} />
      <p className="app-caption">{STARTUP_COPY.mismatchCaption}</p>
    </StartupSection>
  );
}

function titleOf(taskList: TaskList): string {
  if (taskList.erpSession !== 'logged_in' || !taskList.employee) return STARTUP_COPY.loginTitle;
  return taskList.employee.binding === 'mismatched' ? STARTUP_COPY.mismatchTitle : STARTUP_COPY.identityTitle;
}

export function StartupPage({ taskList }: { taskList: TaskList }) {
  const title = titleOf(taskList);
  useEffect(() => {
    document.title = `baox · ${title}`;
  }, [title]);
  const employee = taskList.employee;
  return (
    <AppShell nav="tasks">
      {taskList.erpSession !== 'logged_in' || !employee ? (
        <LoginStep identityUnknown={taskList.erpSession === 'logged_in'} />
      ) : employee.binding === 'mismatched' ? (
        <MismatchStep />
      ) : (
        <IdentityStep employee={employee} />
      )}
    </AppShell>
  );
}

// 启动状态还没读到时的占位；读取失败（不是连不上服务）时给出原因与重试。
export function StartupPending({ error }: { error: string | null }) {
  const store = useAppStore();
  return (
    <AppShell nav="tasks">
      {error ? (
        <div className="app-empty">
          <h2>{STARTUP_COPY.loadFailed}</h2>
          <p>{error}</p>
          <Button kind="secondary" onClick={() => void store.loadTaskList()}>
            {STARTUP_COPY.retry}
          </Button>
        </div>
      ) : (
        <p className="app-loading">{STARTUP_COPY.checking}</p>
      )}
    </AppShell>
  );
}
