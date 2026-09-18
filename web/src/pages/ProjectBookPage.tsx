import { PROJECT_BOOK_COPY, PUBLIC_PROJECT_BOOK_COPY } from '@baox/contract';
import { AppShell } from '../shell/AppShell';
import { PageHeader } from '../shell/PageHeader';
import { ProjectBookPanel } from './ProjectBookPanel';

// 全局页面 `#/projects` shows the signed-in member's personal book beside the read-only shared book. Public changes
// remain on the administrator surface so ordinary members never receive public mutation controls.
export function ProjectBookPage() {
  return (
    <AppShell nav="projects">
      <PageHeader title={PROJECT_BOOK_COPY.title} lead={PROJECT_BOOK_COPY.lead} />
      <ProjectBookPanel />
      <h2 className="app-section-title">{PUBLIC_PROJECT_BOOK_COPY.title}</h2>
      <p className="app-lead">{PUBLIC_PROJECT_BOOK_COPY.lead}</p>
      <ProjectBookPanel scope="public" canMaintain={false} />
    </AppShell>
  );
}
