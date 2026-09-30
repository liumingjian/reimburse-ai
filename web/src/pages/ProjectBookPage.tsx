import { useState } from 'react';
import { ContentSwitcher, Switch } from '@carbon/react';
import { PROJECT_BOOK_COPY, PUBLIC_PROJECT_BOOK_COPY } from '@baox/contract';
import { AppShell } from '../shell/AppShell';
import { PageHeader } from '../shell/PageHeader';
import { ProjectBookPanel } from './ProjectBookPanel';
import { useSession } from '../adapter/context';

// Both books live apart from account administration. The server still enforces each book's maintenance permissions.
export function ProjectBookPage() {
  const canMaintainPublic = useSession().data?.account?.role === 'admin';
  const [scope, setScope] = useState<'personal' | 'public'>('personal');
  const copy = scope === 'personal' ? PROJECT_BOOK_COPY : PUBLIC_PROJECT_BOOK_COPY;

  return (
    <AppShell nav="projects">
      <PageHeader title={copy.title} lead={copy.lead} />
      <ContentSwitcher
        className="app-scope-switcher"
        size="md"
        aria-label="选择项目簿"
        selectedIndex={scope === 'personal' ? 0 : 1}
        onChange={({ name }) => setScope(name === 'public' ? 'public' : 'personal')}
      >
        <Switch name="personal" text="个人项目簿" />
        <Switch name="public" text="公共项目簿" />
      </ContentSwitcher>
      {scope === 'personal' ? (
        <section className="app-block" aria-label="个人项目簿维护">
          <ProjectBookPanel />
        </section>
      ) : (
        <section className="app-block" aria-label="公共项目簿维护">
          <ProjectBookPanel scope="public" primaryIntake={false} canMaintain={canMaintainPublic} />
        </section>
      )}
    </AppShell>
  );
}
