import { useEffect, useMemo, type ReactNode } from 'react';
import { merge as mergeCarbonFlags } from '@carbon/feature-flags';
import { FeatureFlags } from '@carbon/react';
import { type AppAdapter, PROJECT_BOOK_COPY } from '@baox/contract';
import { AppProvider, useSession } from './adapter/context';
import { AppStore } from './adapter/store';
import { VALIDATE_SNAPSHOTS } from './env';
import { AdminPage, ADMIN_COPY } from './pages/AdminPage';
import { AuthPage, AuthPending, ChangePasswordPage } from './pages/AuthPage';
import { ProjectBookPage } from './pages/ProjectBookPage';
import { SettingsPage } from './pages/SettingsPage';
import { ExtensionTutorialPage } from './pages/ExtensionTutorialPage';
import { TaskListPage } from './pages/TaskListPage';
import { PAGE_COPY, TaskRoute } from './pages/TaskRoute';
import { navigate, useRoute, type Route } from './router';

// Carbon 的 OverflowMenu 浮层（FloatingMenu）读 @carbon/feature-flags 的全局开关，不读下面 <FeatureFlags> 的上下文：
// 不打开的话，菜单打开时会多出两个写着英文「Focus sentinel」的读屏链接。
mergeCarbonFlags({ 'enable-focus-wrap-without-sentinels': true });

function titleOf(route: Route): string {
  switch (route.kind) {
    case 'tasks':
      return '报销任务';
    case 'new':
      return '新建报销任务';
    case 'projects':
      return PROJECT_BOOK_COPY.title;
    case 'settings':
      return '设置';
    case 'password':
      return '修改密码';
    case 'settingsTutorial':
      return '浏览器扩展安装教程';
    case 'admin':
      return ADMIN_COPY.title;
    case 'task':
      return route.page ? PAGE_COPY[route.page].title : '报销任务';
    case 'redirect':
      return '报销任务';
  }
}

function Routes() {
  const route = useRoute();
  useEffect(() => {
    if (route.kind === 'redirect') navigate(route.to, true);
  }, [route]);
  useEffect(() => {
    document.title = `baox · ${titleOf(route)}`;
    window.scrollTo(0, 0);
  }, [route]);
  switch (route.kind) {
    // `#/tasks/new` 是新建任务弹层的深链：同一个任务列表页，弹层打开（同一位置同一组件，切换时不重新挂载）。
    case 'tasks':
      return <TaskListPage newTask={false} />;
    case 'new':
      return <TaskListPage newTask />;
    case 'projects':
      return <ProjectBookPage />;
    case 'settings':
      return <SettingsPage />;
    case 'password':
      return <ChangePasswordPage required={false} />;
    case 'settingsTutorial':
      return <ExtensionTutorialPage />;
    case 'admin':
      return <AdminPage />;
    case 'task':
      return <TaskRoute key={route.taskId} taskId={route.taskId} page={route.page} />;
    case 'redirect':
      return null;
  }
}

// 登录门 (auth gate, ADR-0018): until the browser has a session every route shows the create-admin / login page instead
// (the route is kept, so a deep link opens in place after signing in). Every page is behind the gate.
function AuthGate({ children }: { children: ReactNode }) {
  const session = useSession();
  const data = session.data;
  if (data) return data.status === 'signed_in' ? children : data.status === 'password_change_required' ? <ChangePasswordPage /> : <AuthPage session={data} />;
  return <AuthPending error={session.status === 'error' ? session.error : null} />;
}

export function App({ adapter }: { adapter: AppAdapter }) {
  const store = useMemo(() => new AppStore(adapter, { validate: VALIDATE_SNAPSHOTS }), [adapter]);
  // Carbon 弹层默认用两个写着英文「Focus sentinel」的隐藏元素兜住焦点；打开这个开关改用不带哨兵元素的焦点循环。
  // 弹层（Modal）读这里的上下文开关；OverflowMenu 的浮层读全局开关，见文件顶部的 mergeCarbonFlags。
  return (
    <FeatureFlags enableFocusWrapWithoutSentinels>
      <AppProvider store={store}>
        <AuthGate>
          <Routes />
        </AuthGate>
      </AppProvider>
    </FeatureFlags>
  );
}
