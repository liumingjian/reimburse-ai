import { useState } from 'react';
import { useAppStore, useProjectBook } from '../adapter/context';
import type { AppAdapter, ProjectBookOutcome } from '../contract/adapter';
import { PROJECT_BOOK_ACCEPTED_STATUSES, PROJECT_BOOK_COPY, type ProjectBookEntry } from '../contract/project-book';

// 个人项目簿的维护面板（内核 project-book-page.mjs）：录入框、项目表、复检全部与清理全部失效。
// 全局页面 `#/projects` 与项目归属页的维护入口共用。页面只提交项目号、只显示服务端给的状态与结果说明，不做任何判定。

type Message = { ok: boolean; text: string };

export function ProjectBookPanel() {
  const store = useAppStore();
  const book = useProjectBook();
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  const run = async (action: (adapter: AppAdapter) => Promise<ProjectBookOutcome>) => {
    setBusy(true);
    setMessage(null);
    const outcome = await store.projectBookAction(action);
    setBusy(false);
    if (!outcome.ok) {
      setMessage({ ok: false, text: outcome.error.message });
      return;
    }
    setMessage({ ok: PROJECT_BOOK_ACCEPTED_STATUSES.has(outcome.result.status), text: outcome.result.note });
    if (outcome.result.status === 'admitted') setNumber('');
  };

  const projects = book.data?.projects ?? [];
  const loading = book.data === null && (book.status === 'idle' || book.status === 'loading');

  return (
    <>
      <section className="panel" aria-label="录入项目">
        <form
          className="book-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run((adapter) => adapter.intakeProject(number));
          }}
        >
          <div className="field">
            <label htmlFor="project-number">{PROJECT_BOOK_COPY.numberLabel}</label>
            <input id="project-number" className="input mono" autoComplete="off" value={number} onChange={(event) => setNumber(event.target.value)} />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy || number.trim() === ''}>
            {PROJECT_BOOK_COPY.intake}
          </button>
        </form>
        {message ? (
          <div className={`notice ${message.ok ? 'notice-ok' : 'notice-err'} book-message`} role="status" data-testid="book-message">
            {message.text}
          </div>
        ) : null}
      </section>

      <section className="panel table" aria-label="项目簿">
        {loading ? (
          <p className="caption loading">正在读取个人项目簿…</p>
        ) : book.status === 'error' && book.data === null ? (
          <div className="empty">
            <p>{book.error}</p>
            <button className="btn btn-secondary" type="button" onClick={() => void store.loadProjectBook()}>
              重试
            </button>
          </div>
        ) : (
          <table className="data" aria-label="个人项目簿">
            <thead>
              <tr>
                <th>项目号</th>
                <th>名称</th>
                <th>过期时间</th>
                <th>状态</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {projects.length > 0 ? (
                projects.map((project) => <BookRow key={project.number} project={project} busy={busy} onRemove={() => void run((adapter) => adapter.removeProject(project.number))} />)
              ) : (
                <tr>
                  <td colSpan={5} className="empty">
                    {PROJECT_BOOK_COPY.empty}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        <div className="btn-row book-actions">
          <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => void run((adapter) => adapter.recheckProjects())}>
            {PROJECT_BOOK_COPY.recheck}
          </button>
          <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => void run((adapter) => adapter.purgeInvalidProjects())}>
            {PROJECT_BOOK_COPY.purge}
          </button>
        </div>
      </section>
    </>
  );
}

function BookRow({ project, busy, onRemove }: { project: ProjectBookEntry; busy: boolean; onRemove: () => void }) {
  return (
    <tr data-testid={`book-row-${project.number}`}>
      <td className="mono">{project.number}</td>
      <td>{project.name ?? PROJECT_BOOK_COPY.noName}</td>
      <td className="mono">{project.expiresOn ?? PROJECT_BOOK_COPY.neverExpires}</td>
      <td>
        <span className={`badge ${project.selectable ? 'badge-ok' : 'badge-warn'}`}>{project.statusLabel}</span>
        {project.statusNote ? <div className="caption">{project.statusNote}</div> : null}
      </td>
      <td className="num">
        <button className="btn btn-tertiary btn-sm" type="button" aria-label={`${PROJECT_BOOK_COPY.remove} ${project.number}`} disabled={busy} onClick={onRemove}>
          {PROJECT_BOOK_COPY.remove}
        </button>
      </td>
    </tr>
  );
}
