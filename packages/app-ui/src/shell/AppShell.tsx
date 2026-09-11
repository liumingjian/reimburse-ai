import type { ReactNode } from 'react';
import { useAppState, useTaskList } from '../adapter/context';
import { IS_MOCK } from '../env';
import { TASKS_HASH } from '../router';

export const SERVICE_DOWN_NOTICE = '本地服务未运行，请在终端重新执行 baox';

type Props = {
  nav: 'tasks';
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
        </nav>
        <div className="spacer" />
        {IS_MOCK ? <span className="mode-tag">模拟数据</span> : null}
        {employee ? (
          <span className="muted">
            {employee.name} · {employee.department}
          </span>
        ) : null}
      </header>
      {state.connection === 'disconnected' ? (
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
