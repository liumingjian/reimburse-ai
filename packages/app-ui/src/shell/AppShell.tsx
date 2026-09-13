import type { ReactNode } from 'react';
import { useAppState, useTaskList } from '../adapter/context';
import { IS_MOCK } from '../env';
import { PROJECTS_HASH, SETTINGS_HASH, TASKS_HASH } from '../router';

export const SERVICE_DOWN_NOTICE = '本地服务未运行，请在终端重新执行 baox';

type Props = {
  nav: 'tasks' | 'projects' | 'settings';
  stepBar?: ReactNode;
  children: ReactNode;
};

// 应用壳（DESIGN.md「表面按层级语义排」）：顶栏在着色框架里，主区是一整块白色工作面（sheet），页面内容都在里面。
// 没有侧栏：任务页的步骤条是工作面顶部的一行，工作面在所有页面都铺满宽度。
// 工作面本身不限宽：表格页铺满，表单页在页面里自己限到 720px。断连时框架里出现全宽横幅。
export function AppShell({ nav, stepBar, children }: Props) {
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
        {/* 报销人只在身份已登记后显示，只显示姓名（内核身份没有部门）；头像圆里是姓名的第一个字，只作装饰。 */}
        {employee?.binding === 'bound' ? (
          <span className="user">
            <span className="avatar" aria-hidden="true">
              {employee.displayName.slice(0, 1)}
            </span>
            <span>{employee.displayName}</span>
          </span>
        ) : null}
      </header>
      {state.connection === 'disconnected' || state.taskList.offline ? (
        <div className="banner" role="alert">
          {SERVICE_DOWN_NOTICE}
        </div>
      ) : null}
      <div className="layout">
        <main className="sheet">
          {stepBar}
          {children}
        </main>
      </div>
    </>
  );
}
