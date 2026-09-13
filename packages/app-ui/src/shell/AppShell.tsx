import type { ReactNode } from 'react';
import { Header, HeaderGlobalBar, HeaderMenuItem, HeaderName, HeaderNavigation, InlineNotification, Tag } from '@carbon/react';
import { UserAvatar } from '@carbon/icons-react';
import { useAppState, useTaskList } from '../adapter/context';
import { IS_MOCK } from '../env';
import { PROJECTS_HASH, SETTINGS_HASH, TASKS_HASH } from '../router';

export const SERVICE_DOWN_NOTICE = '本地服务未运行，请在终端重新执行 baox';

type Nav = 'tasks' | 'projects' | 'settings';

type Props = {
  nav: Nav;
  stepBar?: ReactNode;
  children: ReactNode;
};

const NAV_ITEMS: readonly { key: Nav; label: string; href: string }[] = [
  { key: 'tasks', label: '报销任务', href: TASKS_HASH },
  { key: 'projects', label: '个人项目簿', href: PROJECTS_HASH },
  { key: 'settings', label: '设置', href: SETTINGS_HASH },
];

// 应用壳：Carbon UI Shell 顶栏（全局导航、模拟数据标签与报销人），下面是工作区；任务页的步骤条是工作区顶部的一条。
// 工作区不限宽：表格页铺满，表单页在页面里自己限宽。断连时顶栏下出现全宽横幅。
export function AppShell({ nav, stepBar, children }: Props) {
  const state = useAppState();
  const taskList = useTaskList();
  const employee = taskList.data?.employee ?? null;
  return (
    <>
      <Header aria-label="baox 本地报销">
        <HeaderName href={TASKS_HASH} prefix="baox">
          本地报销
        </HeaderName>
        <HeaderNavigation aria-label="全局">
          {NAV_ITEMS.map((item) => (
            <HeaderMenuItem key={item.key} href={item.href} isActive={nav === item.key} {...(nav === item.key ? { 'aria-current': 'page' } : {})}>
              {item.label}
            </HeaderMenuItem>
          ))}
        </HeaderNavigation>
        <HeaderGlobalBar>
          <div className="app-header-tools">
            {IS_MOCK ? (
              <Tag type="cool-gray" size="sm">
                模拟数据
              </Tag>
            ) : null}
            {/* 报销人只在身份已登记后显示，只显示姓名（内核身份没有部门）。 */}
            {employee?.binding === 'bound' ? (
              <span className="app-user">
                <UserAvatar size={20} aria-hidden="true" />
                <span>{employee.displayName}</span>
              </span>
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
