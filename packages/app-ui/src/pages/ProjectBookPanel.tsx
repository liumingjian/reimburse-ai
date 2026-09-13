import { useState } from 'react';
import { Button, InlineNotification, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tag, TextInput } from '@carbon/react';
import { Add, CheckmarkFilled, Renew, TrashCan, WarningAltFilled } from '@carbon/icons-react';
import { useAppStore, useProjectBook } from '../adapter/context';
import type { AppAdapter, ProjectBookOutcome } from '../contract/adapter';
import { PROJECT_BOOK_ACCEPTED_STATUSES, PROJECT_BOOK_COPY, type ProjectBookEntry } from '../contract/project-book';

// 个人项目簿的维护面板（内核 project-book-page.mjs）：录入框、项目表、复检全部与清理全部失效。
// 全局页面 `#/projects`、项目归属页的维护门与就地新增弹层共用。页面只提交项目号、只显示服务端给的状态与结果说明，不做任何判定。
// 版式：录入是表格上方的一行；复检与清理是表级动作，放在工具栏右侧；表格通栏、窄时横向滚动，项目号固定在左、操作列固定在右。

type Message = { ok: boolean; text: string };

// primaryIntake：「核验并加入」是否用主按钮样式（每屏一个主按钮；项目簿门可以继续时由「开始归属」当主按钮）。
// autoFocus：放在弹层里时打开即聚焦项目号输入框。
export function ProjectBookPanel({ primaryIntake = true, autoFocus = false }: { primaryIntake?: boolean; autoFocus?: boolean }) {
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
      <section className="app-book-intake" aria-label="录入项目">
        <form
          className="app-book-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run((adapter) => adapter.intakeProject(number));
          }}
        >
          <TextInput
            id="project-number"
            className="app-code"
            labelText={PROJECT_BOOK_COPY.numberLabel}
            autoComplete="off"
            autoFocus={autoFocus}
            {...(autoFocus ? { 'data-modal-primary-focus': true } : {})}
            value={number}
            onChange={(event) => setNumber(event.target.value)}
          />
          <Button type="submit" kind={primaryIntake ? 'primary' : 'secondary'} renderIcon={Add} disabled={busy || number.trim() === ''}>
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

      <section className="app-block" aria-label="项目簿">
        <div className="app-table-toolbar bleed">
          <span className="app-table-toolbar-title">{projects.length} 个项目</span>
          <div className="app-btn-row">
            <Button kind="ghost" size="sm" renderIcon={Renew} disabled={busy} onClick={() => void run((adapter) => adapter.recheckProjects())}>
              {PROJECT_BOOK_COPY.recheck}
            </Button>
            <Button kind="ghost" size="sm" renderIcon={TrashCan} disabled={busy} onClick={() => void run((adapter) => adapter.purgeInvalidProjects())}>
              {PROJECT_BOOK_COPY.purge}
            </Button>
          </div>
        </div>
        {loading ? (
          <p className="app-loading">正在读取个人项目簿…</p>
        ) : book.status === 'error' && book.data === null ? (
          <div className="app-empty">
            <p>{book.error}</p>
            <Button kind="secondary" onClick={() => void store.loadProjectBook()}>
              重试
            </Button>
          </div>
        ) : (
          <div className="bleed app-table">
            <Table aria-label="个人项目簿">
              <TableHead>
                <TableRow>
                  <TableHeader className="app-sticky-start">项目号</TableHeader>
                  <TableHeader>名称</TableHeader>
                  <TableHeader>过期时间</TableHeader>
                  <TableHeader>状态</TableHeader>
                  <TableHeader className="app-sticky-end" aria-label="操作" />
                </TableRow>
              </TableHead>
              <TableBody>
                {projects.length > 0 ? (
                  projects.map((project) => <BookRow key={project.number} project={project} busy={busy} onRemove={() => void run((adapter) => adapter.removeProject(project.number))} />)
                ) : (
                  <TableRow>
                    <TableCell colSpan={5} className="app-muted">
                      {PROJECT_BOOK_COPY.empty}
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

function BookRow({ project, busy, onRemove }: { project: ProjectBookEntry; busy: boolean; onRemove: () => void }) {
  return (
    <TableRow data-testid={`book-row-${project.number}`}>
      <TableCell className="app-sticky-start app-nowrap">
        <span className="app-code">{project.number}</span>
      </TableCell>
      <TableCell>{project.name ?? PROJECT_BOOK_COPY.noName}</TableCell>
      <TableCell className="app-nowrap">{project.expiresOn ?? PROJECT_BOOK_COPY.neverExpires}</TableCell>
      <TableCell>
        <Tag type={project.selectable ? 'green' : 'warm-gray'} renderIcon={project.selectable ? CheckmarkFilled : WarningAltFilled}>
          {project.statusLabel}
        </Tag>
        {project.statusNote ? <div className="app-caption">{project.statusNote}</div> : null}
      </TableCell>
      <TableCell className="app-num app-sticky-end">
        <Button kind="ghost" size="sm" aria-label={`${PROJECT_BOOK_COPY.remove} ${project.number}`} disabled={busy} onClick={onRemove}>
          {PROJECT_BOOK_COPY.remove}
        </Button>
      </TableCell>
    </TableRow>
  );
}
