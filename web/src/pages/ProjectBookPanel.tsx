import { useState } from 'react';
import { Button, InlineNotification, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TextInput } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { StatusTag } from '../shell/StatusTag';
import { useAppStore, useBook } from '../adapter/context';
import type { BookScope } from '../adapter/store';
import { type AppAdapter, type ProjectBookEditInput, type ProjectBookOutcome, type PublicProjectConversionInput, PROJECT_BOOK_ACCEPTED_STATUSES, PROJECT_BOOK_COPY, PUBLIC_PROJECT_BOOK_COPY, type ProjectBookEntry } from '@baox/contract';
import { ConfirmDialog } from '../shell/Dialog';

// The same table presents both scopes. Personal intake belongs to its owner; public maintenance controls are shown
// only to administrators. The server independently checks the caller's permission for every mutation.

type Message = { ok: boolean; text: string };
type ConversionPrompt = { input: PublicProjectConversionInput; editEntry: ProjectBookEntry | null };

type BookOps = {
  title: string;
  empty: string;
  intake: (adapter: AppAdapter, input: { number: string; name: string; deadlineOn?: string | null }) => Promise<ProjectBookOutcome>;
  edit: (adapter: AppAdapter, input: ProjectBookEditInput) => Promise<ProjectBookOutcome>;
  deactivate: (adapter: AppAdapter, input: { number: string }) => Promise<ProjectBookOutcome>;
  delete: (adapter: AppAdapter, input: { number: string }) => Promise<ProjectBookOutcome>;
  restore: (adapter: AppAdapter, input: { number: string }) => Promise<ProjectBookOutcome>;
};

const OPS: Readonly<Record<BookScope, BookOps>> = {
  personal: {
    title: PROJECT_BOOK_COPY.title,
    empty: PROJECT_BOOK_COPY.empty,
    intake: (adapter, input) => adapter.intakeProject(input),
    edit: (adapter, input) => adapter.editProject(input),
    deactivate: (adapter, input) => adapter.deactivateProject(input),
    restore: (adapter, input) => adapter.restoreProject(input),
    delete: (adapter, input) => adapter.deleteProject(input),
  },
  public: {
    title: PUBLIC_PROJECT_BOOK_COPY.title,
    empty: PUBLIC_PROJECT_BOOK_COPY.empty,
    intake: (adapter, input) => adapter.intakePublicProject(input),
    edit: (adapter, input) => adapter.editPublicProject(input),
    deactivate: (adapter, input) => adapter.deactivatePublicProject(input),
    restore: (adapter, input) => adapter.restorePublicProject(input),
    delete: (adapter, input) => adapter.deletePublicProject(input),
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
  const [deadlineOn, setDeadlineOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [deleting, setDeleting] = useState<ProjectBookEntry | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProjectBookEntry | null>(null);
  const [editNumber, setEditNumber] = useState('');
  const [editName, setEditName] = useState('');
  const [editDeadlineOn, setEditDeadlineOn] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [conversion, setConversion] = useState<ConversionPrompt | null>(null);
  const [conversionError, setConversionError] = useState<string | null>(null);
  const inputId = scope === 'personal' ? 'project-number' : 'public-project-number';
  const nameId = scope === 'personal' ? 'project-name' : 'public-project-name';

  const run = async () => {
    setBusy(true);
    setMessage(null);
    const outcome = await store.projectBookAction((adapter) => ops.intake(adapter, { number, name, deadlineOn: deadlineOn || null }), scope);
    setBusy(false);
    if (!outcome.ok) {
      setMessage({ ok: false, text: outcome.error.message });
      return;
    }
    if (scope === 'public' && outcome.result.status === 'conversion_required') {
      setConversion({ input: { operation: 'intake', number, name, deadlineOn: deadlineOn || null }, editEntry: null });
      setConversionError(null);
      return;
    }
    setMessage({ ok: PROJECT_BOOK_ACCEPTED_STATUSES.has(outcome.result.status), text: outcome.result.note });
    if (outcome.result.status === 'admitted') {
      setNumber('');
      setName('');
      setDeadlineOn('');
    }
  };

  const openEdit = (project: ProjectBookEntry) => {
    setEditing(project);
    setEditNumber(project.number);
    setEditName(project.name ?? '');
    setEditDeadlineOn(project.deadlineOn ?? '');
    setEditError(null);
  };

  const openDelete = (project: ProjectBookEntry) => {
    setDeleting(project);
    setDeleteError(null);
  };

  const closeEdit = () => {
    setEditing(null);
    setEditError(null);
  };

  const saveEdit = async () => {
    if (!editing) return;
    setBusy(true);
    setEditError(null);
    const outcome = await store.projectBookAction((adapter) => ops.edit(adapter, { originalNumber: editing.number, number: editNumber, name: editName, deadlineOn: editDeadlineOn || null }), scope);
    setBusy(false);
    if (!outcome.ok) {
      setEditError(outcome.error.message);
      return;
    }
    if (scope === 'public' && outcome.result.status === 'conversion_required') {
      setEditing(null);
      setConversion({
        input: {
          operation: 'edit',
          originalNumber: editing.number,
          originalName: editing.name,
          originalActive: editing.active,
          originalDeadlineOn: editing.deadlineOn ?? null,
          number: editNumber,
          name: editName,
          deadlineOn: editDeadlineOn || null,
        },
        editEntry: editing,
      });
      setConversionError(null);
      return;
    }
    if (!PROJECT_BOOK_ACCEPTED_STATUSES.has(outcome.result.status)) {
      setEditError(outcome.result.note);
      return;
    }
    setMessage({ ok: true, text: outcome.result.note });
    closeEdit();
  };

  const cancelConversion = () => {
    const pending = conversion;
    setConversion(null);
    setConversionError(null);
    if (!pending?.editEntry) return;
    setEditing(pending.editEntry);
    setEditNumber(pending.input.number);
    setEditName(pending.input.name);
    setEditDeadlineOn(pending.input.deadlineOn ?? '');
  };

  const confirmConversion = async () => {
    if (!conversion) return;
    setBusy(true);
    setConversionError(null);
    const outcome = await store.projectBookAction((adapter) => adapter.confirmPublicProjectConversion(conversion.input), 'public');
    setBusy(false);
    if (!outcome.ok) {
      setConversionError(outcome.error.message);
      return;
    }
    if (outcome.result.status !== 'converted') {
      setConversionError(outcome.result.note);
      return;
    }
    setMessage({ ok: true, text: outcome.result.note });
    if (conversion.input.operation === 'intake') {
      setNumber('');
      setName('');
      setDeadlineOn('');
    }
    setConversion(null);
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    setDeleteError(null);
    const outcome = await store.projectBookAction((adapter) => ops.delete(adapter, { number: deleting.number }), scope);
    setBusy(false);
    if (!outcome.ok) {
      setDeleteError(outcome.error.message);
      return;
    }
    if (outcome.result.status !== 'deleted') {
      setDeleteError(outcome.result.note);
      return;
    }
    setMessage({ ok: true, text: outcome.result.note });
    setDeleting(null);
  };

  const runLifecycle = async (action: 'deactivate' | 'restore', projectNumber: string) => {
    setBusy(true);
    setMessage(null);
    const outcome = await store.projectBookAction((adapter) => ops[action](adapter, { number: projectNumber }), scope);
    setBusy(false);
    if (!outcome.ok) {
      setMessage({ ok: false, text: outcome.error.message });
      return;
    }
    setMessage({ ok: PROJECT_BOOK_ACCEPTED_STATUSES.has(outcome.result.status), text: outcome.result.note });
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
            <TextInput
              id={scope === 'personal' ? 'project-deadline' : 'public-project-deadline'}
              type="date"
              labelText={PROJECT_BOOK_COPY.deadlineLabel}
              helperText={PROJECT_BOOK_COPY.deadlineHint}
              value={deadlineOn}
              onChange={(event) => setDeadlineOn(event.target.value)}
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
            <Button size="md" kind="secondary" onClick={() => void (scope === 'public' ? store.loadPublicBook() : store.loadProjectBook())}>
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
                  <TableHeader>{PROJECT_BOOK_COPY.deadlineLabel}</TableHeader>
                  <TableHeader>状态</TableHeader>
                  {canMaintain ? <TableHeader className="app-sticky-end" aria-label="操作" /> : null}
                </TableRow>
              </TableHead>
              <TableBody>
                {projects.length > 0 ? (
                  projects.map((project) => (
                    <BookRow
                      key={project.number}
                      project={project}
                      canMaintain={canMaintain}
                      busy={busy}
                      onEdit={openEdit}
                      onLifecycle={runLifecycle}
                      onDelete={openDelete}
                    />
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={canMaintain ? 5 : 4} className="app-muted">
                      {ops.empty}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
      {deleting ? (
        <ConfirmDialog
          title={scope === 'personal' ? '删除个人项目' : '删除公共项目'}
          confirmLabel={PROJECT_BOOK_COPY.delete}
          busy={busy}
          error={deleteError}
          danger
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        >
          <p>确定删除项目 {deleting.number}「{deleting.name}」吗？删除后将从{ops.title}移除{scope === 'public' ? '，所有成员将无法再选择该公共项目' : ''}，未提交任务中使用该项目的明细需要重新选择项目。已有报销记录保持不变。</p>
        </ConfirmDialog>
      ) : null}
      {editing ? (
        <ConfirmDialog
          title={PROJECT_BOOK_COPY.edit}
          confirmLabel={PROJECT_BOOK_COPY.save}
          busy={busy}
          error={editError}
          focusCancel={false}
          onConfirm={() => void saveEdit()}
          onCancel={closeEdit}
        >
          <div className="app-book-form">
            <TextInput
              id={scope === 'personal' ? 'edit-project-number' : 'edit-public-project-number'}
              className="app-code"
              labelText={PROJECT_BOOK_COPY.numberLabel}
              autoComplete="off"
              data-modal-primary-focus
              value={editNumber}
              onChange={(event) => setEditNumber(event.target.value)}
            />
            <TextInput
              id={scope === 'personal' ? 'edit-project-name' : 'edit-public-project-name'}
              labelText={PROJECT_BOOK_COPY.nameLabel}
              autoComplete="off"
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
            />
            <TextInput
              id={scope === 'personal' ? 'edit-project-deadline' : 'edit-public-project-deadline'}
              type="date"
              labelText={PROJECT_BOOK_COPY.deadlineLabel}
              helperText={PROJECT_BOOK_COPY.deadlineHint}
              value={editDeadlineOn}
              onChange={(event) => setEditDeadlineOn(event.target.value)}
            />
          </div>
        </ConfirmDialog>
      ) : null}
      {conversion ? (
        <ConfirmDialog
          title={PUBLIC_PROJECT_BOOK_COPY.conversionTitle}
          confirmLabel={PUBLIC_PROJECT_BOOK_COPY.conversionConfirm}
          busy={busy}
          error={conversionError}
          danger
          onConfirm={() => void confirmConversion()}
          onCancel={cancelConversion}
        >
          <p>{PUBLIC_PROJECT_BOOK_COPY.conversionLead(conversion.input.number.trim())}</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function BookRow({
  project,
  canMaintain,
  busy,
  onEdit,
  onLifecycle,
  onDelete,
}: {
  project: ProjectBookEntry;
  canMaintain: boolean;
  busy: boolean;
  onEdit: (project: ProjectBookEntry) => void;
  onDelete: (project: ProjectBookEntry) => void;
  onLifecycle: (action: 'deactivate' | 'restore', projectNumber: string) => void;
}) {
  return (
    <TableRow data-testid={`book-row-${project.number}`}>
      <TableCell className="app-sticky-start app-nowrap">
        <span className="app-code">{project.number}</span>
      </TableCell>
      <TableCell className="app-project-book-name">{project.name ?? PROJECT_BOOK_COPY.noName}</TableCell>
      <TableCell className="app-nowrap">{project.deadlineOn ?? PROJECT_BOOK_COPY.deadlineUnset}</TableCell>
      <TableCell>
        <StatusTag tone={project.selectable ? 'success' : 'warning'}>{project.statusLabel}</StatusTag>
        {project.statusNote ? <div className="app-caption">{project.statusNote}</div> : null}
      </TableCell>
      {canMaintain ? (
        <TableCell className="app-sticky-end app-num">
          <div className="app-row-actions">
            <Button kind="ghost" size="sm" aria-label={`编辑 ${project.number}`} disabled={busy} onClick={() => onEdit(project)}>编辑</Button>
            <Button kind="ghost" size="sm" aria-label={`${project.active ? '停用' : '恢复'}项目 ${project.number}`} disabled={busy} onClick={() => onLifecycle(project.active ? 'deactivate' : 'restore', project.number)}>
              {project.active ? PROJECT_BOOK_COPY.deactivate : PROJECT_BOOK_COPY.restore}
            </Button>
            <Button kind="danger--ghost" size="sm" aria-label={`删除项目 ${project.number}`} disabled={busy} onClick={() => onDelete(project)}>{PROJECT_BOOK_COPY.delete}</Button>
          </div>
        </TableCell>
      ) : null}
    </TableRow>
  );
}
