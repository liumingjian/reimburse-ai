import { useEffect, useMemo } from 'react';
import { AppProvider } from './adapter/context';
import { AppStore } from './adapter/store';
import type { AppAdapter } from './contract/adapter';
import { VALIDATE_SNAPSHOTS } from './env';
import { NewTaskPage } from './pages/NewTaskPage';
import { TaskListPage } from './pages/TaskListPage';
import { PAGE_COPY, TaskRoute } from './pages/TaskRoute';
import { navigate, useRoute, type Route } from './router';

function titleOf(route: Route): string {
  switch (route.kind) {
    case 'tasks':
      return '报销任务';
    case 'new':
      return '新建任务';
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
    case 'tasks':
      return <TaskListPage />;
    case 'new':
      return <NewTaskPage />;
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
