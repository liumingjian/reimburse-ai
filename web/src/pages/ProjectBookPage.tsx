import { PROJECT_BOOK_COPY } from '@baox/contract';
import { AppShell } from '../shell/AppShell';
import { PageHeader } from '../shell/PageHeader';
import { ProjectBookPanel } from './ProjectBookPanel';

// 全局页面 `#/projects`「个人项目簿」：顶栏有入口。项目簿按应用账号分簿，登录门保证进来时已经登录。
export function ProjectBookPage() {
  return (
    <AppShell nav="projects">
      <PageHeader title={PROJECT_BOOK_COPY.title} lead={PROJECT_BOOK_COPY.lead} />
      <ProjectBookPanel />
    </AppShell>
  );
}
