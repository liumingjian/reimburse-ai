import { useState } from 'react';
import { Button, InlineNotification, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TextInput } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { StatusTag } from '../shell/StatusTag';
import { useAppStore, useBook } from '../adapter/context';
import type { BookScope } from '../adapter/store';
import { type AppAdapter, type ProjectBookOutcome, PROJECT_BOOK_ACCEPTED_STATUSES, PROJECT_BOOK_COPY, PUBLIC_PROJECT_BOOK_COPY, type ProjectBookEntry } from '@baox/contract';

// The same table presents both scopes. Personal intake is available wherever the personal panel appears; the public
// panel becomes editable only on the administrator surface, while the project page always shows its read-only view.

type Message = { ok: boolean; text: string };

type BookOps = {
  title: string;
  empty: string;
  intake: (adapter: AppAdapter, input: { number: string; name: string }) => Promise<ProjectBookOutcome>;
};

const OPS: Readonly<Record<BookScope, BookOps>> = {
  personal: {
    title: PROJECT_BOOK_COPY.title,
    empty: PROJECT_BOOK_COPY.empty,
    intake: (adapter, input) => adapter.intakeProject(input),
  },
  public: {
    title: PUBLIC_PROJECT_BOOK_COPY.title,
    empty: PUBLIC_PROJECT_BOOK_COPY.empty,
    intake: (adapter, input) => adapter.intakePublicProject(input),
  },
};

const NUMBER_PLACEHOLDER = '如：P-2307';
const NAME_PLACEHOLDER = '如：华东客户交付';

export function ProjectBookPanel({
  primaryIntake = true,
  autoFocus = false,
  scope = 'personal',
  canMaintain = scope === 'personal',
}: {
  primaryIntake?: boolean;
  autoFocus?: boolean;
  scope?: BookScope;
  canMaintain?: boolean;
}) {
  const store = useAppStore();
  const book = useBook(scope);
  const ops = OPS[scope];
  const [number, setNumber] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const inputId = scope === 'personal' ? 'project-number' : 'public-project-number';
  const nameId = scope === 'personal' ? 'project-name' : 'public-project-name';

  const run = async () => {
    setBusy(true);
    setMessage(null);
    const outcome = await store.projectBookAction((adapter) => ops.intake(adapter, { number, name }), scope);
    setBusy(false);
    if (!outcome.ok) {
      setMessage({ ok: false, text: outcome.error.message });
      return;
    }
    setMessage({ ok: PROJECT_BOOK_ACCEPTED_STATUSES.has(outcome.result.status), text: outcome.result.note });
    if (outcome.result.status === 'admitted') {
      setNumber('');
      setName('');
    }
  };

  const projects = book.data?.projects ?? [];
  const loading = book.data === null && (book.status === 'idle' || book.status === 'loading');

  return (
    <>
      {canMaintain ? (
        <section className="app-book-intake" aria-label={`录入${ops.title}`}>
          <form
            className="app-book-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run();
            }}
          >
            <TextInput
              id={inputId}
              className="app-code"
              labelText={PROJECT_BOOK_COPY.numberLabel}
              placeholder={NUMBER_PLACEHOLDER}
              autoComplete="off"
              autoFocus={autoFocus}
              {...(autoFocus ? { 'data-modal-primary-focus': true } : {})}
              value={number}
              onChange={(event) => setNumber(event.target.value)}
            />
            <TextInput
              id={nameId}
              labelText={PROJECT_BOOK_COPY.nameLabel}
              placeholder={NAME_PLACEHOLDER}
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <Button type="submit" size="md" kind={primaryIntake ? 'primary' : 'secondary'} renderIcon={Add} disabled={busy || number.trim() === '' || name.trim() === ''}>
              {PROJECT_BOOK_COPY.intake}
            </Button>
          </form>
          {message ? (
            <InlineNotification
              className="app-book-message"
              kind={message.ok ? 'success' : 'error'}
              role="status"
              lowContrast
              hideCloseButton
              statusIconDescription={message.ok ? '成功' : '错误'}
            >
              <span data-testid="book-message">{message.text}</span>
            </InlineNotification>
          ) : null}
        </section>
      ) : null}

      <section className="app-block" aria-label={ops.title}>
        <div className="app-table-toolbar bleed">
          <span className="app-table-toolbar-title">{projects.length} 个项目</span>
        </div>
        {loading ? (
          <p className="app-loading">正在读取{ops.title}…</p>
        ) : book.status === 'error' && book.data === null ? (
          <div className="app-empty">
            <p>{book.error}</p>
            <Button kind="secondary" onClick={() => void (scope === 'public' ? store.loadPublicBook() : store.loadProjectBook())}>
              重试
            </Button>
          </div>
        ) : (
          <div className="bleed app-table">
            <Table aria-label={ops.title}>
              <TableHead>
                <TableRow>
                  <TableHeader className="app-sticky-start">项目号</TableHeader>
                  <TableHeader>名称</TableHeader>
                  <TableHeader>状态</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {projects.length > 0 ? (
                  projects.map((project) => <BookRow key={project.number} project={project} />)
                ) : (
                  <TableRow>
                    <TableCell colSpan={3} className="app-muted">
                      {ops.empty}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </>
  );
}

function BookRow({ project }: { project: ProjectBookEntry }) {
  return (
    <TableRow data-testid={`book-row-${project.number}`}>
      <TableCell className="app-sticky-start app-nowrap">
        <span className="app-code">{project.number}</span>
      </TableCell>
      <TableCell>{project.name ?? PROJECT_BOOK_COPY.noName}</TableCell>
      <TableCell>
        <StatusTag tone={project.selectable ? 'success' : 'warning'}>{project.statusLabel}</StatusTag>
        {project.statusNote ? <div className="app-caption">{project.statusNote}</div> : null}
      </TableCell>
    </TableRow>
  );
}
