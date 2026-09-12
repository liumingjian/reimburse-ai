import { useEffect, useMemo } from 'react';
import { AppProvider } from './adapter/context';
import { AppStore } from './adapter/store';
import type { AppAdapter } from './contract/adapter';
import { VALIDATE_SNAPSHOTS } from './env';
import { TaskListPage } from './pages/TaskListPage';
import { PAGE_COPY, TaskRoute } from './pages/TaskRoute';
import { navigate, useRoute, type Route } from './router';

function titleOf(route: Route): string {
  switch (route.kind) {
    case 'tasks':
      return '报销任务';
    case 'new':
      return '新建报销任务';
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
    case 'task':
      return <TaskRoute key={route.taskId} taskId={route.taskId} page={route.page} />;
    case 'redirect':
      return null;
  }
}

export function App({ adapter }: { adapter: AppAdapter }) {
  const store = useMemo(() => new AppStore(adapter, { validate: VALIDATE_SNAPSHOTS }), [adapter]);
  return (
    <AppProvider store={store}>
      <Routes />
    </AppProvider>
  );
}
