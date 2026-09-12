import type { ReactNode } from 'react';
import { useAppState, useTaskList } from '../adapter/context';
import { IS_MOCK } from '../env';
import { PROJECTS_HASH, SETTINGS_HASH, TASKS_HASH } from '../router';

export const SERVICE_DOWN_NOTICE = '本地服务未运行，请在终端重新执行 baox';

type Props = {
  nav: 'tasks' | 'projects' | 'settings';
  sidebar?: ReactNode;
  children: ReactNode;
};

// 应用壳：顶栏（品牌、全局导航、员工身份）+ 可选侧栏 + 主区。断连时全页横幅。
export function AppShell({ nav, sidebar, children }: Props) {
  const state = useAppState();
  const taskList = useTaskList();
  const employee = taskList.data?.employee ?? null;
  return (
    <>
      <header className="topbar">
        <div className="brand">
          baox<span>本地报销</span>
        </div>
        <nav aria-label="全局">
          <a href={TASKS_HASH} aria-current={nav === 'tasks' ? 'page' : undefined}>
            报销任务
          </a>
          <a href={PROJECTS_HASH} aria-current={nav === 'projects' ? 'page' : undefined}>
            个人项目簿
          </a>
          <a href={SETTINGS_HASH} aria-current={nav === 'settings' ? 'page' : undefined}>
            设置
          </a>
        </nav>
        <div className="spacer" />
        {IS_MOCK ? <span className="mode-tag">模拟数据</span> : null}
        {/* 报销人只在身份已登记后显示，只显示姓名（内核身份没有部门）。 */}
        {employee?.binding === 'bound' ? <span className="muted">{employee.displayName}</span> : null}
      </header>
      {state.connection === 'disconnected' || state.taskList.offline ? (
        <div className="banner" role="alert">
          {SERVICE_DOWN_NOTICE}
        </div>
      ) : null}
      {sidebar ? (
        <div className="layout">
          {sidebar}
          <main className="main">{children}</main>
        </div>
      ) : (
        <main className="main centered">{children}</main>
      )}
    </>
  );
}
