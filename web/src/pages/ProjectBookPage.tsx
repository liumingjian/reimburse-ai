import { useState } from 'react';
import { Button } from '@carbon/react';
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
      <div className="app-btn-row" role="group" aria-label="选择项目簿">
        <Button kind={scope === 'personal' ? 'secondary' : 'ghost'} aria-pressed={scope === 'personal'} onClick={() => setScope('personal')}>
          个人项目簿
        </Button>
        <Button kind={scope === 'public' ? 'secondary' : 'ghost'} aria-pressed={scope === 'public'} onClick={() => setScope('public')}>
          公共项目簿
        </Button>
      </div>
      {scope === 'personal' ? (
        <ProjectBookPanel />
      ) : (
        <section className="app-block" aria-label="公共项目簿维护">
          <ProjectBookPanel scope="public" primaryIntake={false} canMaintain={canMaintainPublic} />
        </section>
      )}
    </AppShell>
  );
}
