import { useState, type ReactNode } from 'react';
import { Button, Header, HeaderGlobalBar, HeaderMenuItem, HeaderName, HeaderNavigation, InlineNotification, Tag } from '@carbon/react';
import { UserAvatar } from '@carbon/icons-react';
import { useAppState, useAppStore } from '../adapter/context';
import { IS_MOCK } from '../env';
import { ADMIN_HASH, PROJECTS_HASH, SETTINGS_HASH, TASKS_HASH, navigate } from '../router';

export const SERVICE_DOWN_NOTICE = '连不上报销服务，请检查网络后重试；如果一直这样，请联系维护者';
export const LOGOUT_LABEL = '退出登录';
export const ADMIN_TAG = '管理员';

type Nav = 'tasks' | 'projects' | 'settings' | 'admin';

type Props = {
  nav: Nav;
  stepBar?: ReactNode;
  children: ReactNode;
};

// 「管理」只对管理员显示（#194）。
const NAV_ITEMS: readonly { key: Nav; label: string; href: string; adminOnly?: true }[] = [
  { key: 'tasks', label: '报销任务', href: TASKS_HASH },
  { key: 'projects', label: '个人项目簿', href: PROJECTS_HASH },
  { key: 'admin', label: '管理', href: ADMIN_HASH, adminOnly: true },
  { key: 'settings', label: '设置', href: SETTINGS_HASH },
];

// 应用壳：Carbon UI Shell 顶栏（全局导航、模拟数据标签、当前应用账号与退出登录），下面是工作区；任务页的步骤条是工作区顶部的一条。
// 没登录时顶栏只有产品名（登录页也用这个壳）。工作区不限宽：表格页铺满，表单页在页面里自己限宽。断连时顶栏下出现全宽横幅。
export function AppShell({ nav, stepBar, children }: Props) {
  const state = useAppState();
  const store = useAppStore();
  const [leaving, setLeaving] = useState(false);
  const account = state.session.data?.account ?? null;
  // Logging out lands on the task list route, so whoever signs in next does not open the previous account's page.
  const logout = async () => {
    setLeaving(true);
    const outcome = await store.auth((adapter) => adapter.logout());
    setLeaving(false);
    if (outcome.ok) navigate(TASKS_HASH);
  };
  return (
    <>
      <Header aria-label="baox 本地报销">
        <HeaderName href={TASKS_HASH} prefix="baox">
          本地报销
        </HeaderName>
        {account ? (
          <HeaderNavigation aria-label="全局">
            {NAV_ITEMS.filter((item) => !item.adminOnly || account.role === 'admin').map((item) => (
              <HeaderMenuItem key={item.key} href={item.href} isActive={nav === item.key} {...(nav === item.key ? { 'aria-current': 'page' } : {})}>
                {item.label}
              </HeaderMenuItem>
            ))}
          </HeaderNavigation>
        ) : null}
        <HeaderGlobalBar>
          <div className="app-header-tools">
            {IS_MOCK ? (
              <Tag type="cool-gray" size="sm">
                模拟数据
              </Tag>
            ) : null}
            {account ? (
              <>
                <span className="app-user">
                  <UserAvatar size={20} aria-hidden="true" />
                  <span>{account.username}</span>
                  {account.role === 'admin' ? (
                    <Tag type="blue" size="sm">
                      {ADMIN_TAG}
                    </Tag>
                  ) : null}
                </span>
                <Button kind="ghost" size="sm" disabled={leaving} onClick={() => void logout()}>
                  {LOGOUT_LABEL}
                </Button>
              </>
            ) : null}
          </div>
        </HeaderGlobalBar>
      </Header>
      <div className="app-frame">
        {state.connection === 'disconnected' || state.taskList.offline ? (
          <InlineNotification className="app-banner" kind="error" role="alert" lowContrast hideCloseButton statusIconDescription="错误" title={SERVICE_DOWN_NOTICE} />
        ) : null}
        <main className="sheet">
          {stepBar}
          {children}
        </main>
      </div>
    </>
  );
}
