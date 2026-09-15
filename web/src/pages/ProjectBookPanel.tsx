import { useState } from 'react';
import { Button, InlineNotification, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TextInput } from '@carbon/react';
import { Add, Renew, TrashCan } from '@carbon/icons-react';
import { StatusTag } from '../shell/StatusTag';
import { useAppStore, useBook } from '../adapter/context';
import type { BookScope } from '../adapter/store';
import { type AppAdapter, type ProjectBookOutcome, PROJECT_BOOK_ACCEPTED_STATUSES, PROJECT_BOOK_COPY, PUBLIC_PROJECT_BOOK_COPY, type ProjectBookEntry } from '@baox/contract';

// 个人项目簿的维护面板（内核 project-book-page.mjs）：录入框、项目表、复检全部与清理全部失效。
// 全局页面 `#/projects`、项目归属页的维护门与就地新增弹层共用；scope="public" 时是管理页里的公共项目簿（#194）：
// 删除换成「停用」，没有「清理全部失效」（公共项目簿只停用，不删除）。页面只提交项目号、只显示服务端给的状态与结果说明，不做任何判定。
// 版式：录入是表格上方的一行；复检与清理是表级动作，放在工具栏右侧；表格通栏、窄时横向滚动，项目号固定在左、操作列固定在右。

type Message = { ok: boolean; text: string };

type BookOps = {
  title: string;
  empty: string;
  remove: string;
  intake: (adapter: AppAdapter, number: string) => Promise<ProjectBookOutcome>;
  removeOne: (adapter: AppAdapter, number: string) => Promise<ProjectBookOutcome>;
  recheck: (adapter: AppAdapter) => Promise<ProjectBookOutcome>;
  purge: ((adapter: AppAdapter) => Promise<ProjectBookOutcome>) | null;
};

const OPS: Readonly<Record<BookScope, BookOps>> = {
  personal: {
    title: PROJECT_BOOK_COPY.title,
    empty: PROJECT_BOOK_COPY.empty,
    remove: PROJECT_BOOK_COPY.remove,
    intake: (adapter, number) => adapter.intakeProject(number),
    removeOne: (adapter, number) => adapter.removeProject(number),
    recheck: (adapter) => adapter.recheckProjects(),
    purge: (adapter) => adapter.purgeInvalidProjects(),
  },
  public: {
    title: PUBLIC_PROJECT_BOOK_COPY.title,
    empty: PUBLIC_PROJECT_BOOK_COPY.empty,
    remove: PUBLIC_PROJECT_BOOK_COPY.remove,
    intake: (adapter, number) => adapter.intakePublicProject(number),
    removeOne: (adapter, number) => adapter.removePublicProject(number),
    recheck: (adapter) => adapter.recheckPublicProjects(),
    purge: null,
  },
};

const NUMBER_PLACEHOLDER = '如：P-2307';

// primaryIntake：「核验并加入」是否用主按钮样式（每屏一个主按钮；项目簿门可以继续时由「开始归属」当主按钮）。
// autoFocus：放在弹层里时打开即聚焦项目号输入框。
export function ProjectBookPanel({ primaryIntake = true, autoFocus = false, scope = 'personal' }: { primaryIntake?: boolean; autoFocus?: boolean; scope?: BookScope }) {
  const store = useAppStore();
  const book = useBook(scope);
  const ops = OPS[scope];
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  const run = async (action: (adapter: AppAdapter) => Promise<ProjectBookOutcome>) => {
    setBusy(true);
    setMessage(null);
    const outcome = await store.projectBookAction(action, scope);
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
            void run((adapter) => ops.intake(adapter, number));
          }}
        >
          <TextInput
            id="project-number"
            className="app-code"
            labelText={PROJECT_BOOK_COPY.numberLabel}
            placeholder={NUMBER_PLACEHOLDER}
            autoComplete="off"
            autoFocus={autoFocus}
            {...(autoFocus ? { 'data-modal-primary-focus': true } : {})}
            value={number}
            onChange={(event) => setNumber(event.target.value)}
          />
          {/* md 与输入框同高（40px），两者在一行里底边对齐。 */}
          <Button type="submit" size="md" kind={primaryIntake ? 'primary' : 'secondary'} renderIcon={Add} disabled={busy || number.trim() === ''}>
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
            <Button kind="ghost" size="sm" renderIcon={Renew} disabled={busy} onClick={() => void run(ops.recheck)}>
              {PROJECT_BOOK_COPY.recheck}
            </Button>
            {ops.purge ? (
              <Button kind="ghost" size="sm" renderIcon={TrashCan} disabled={busy} onClick={() => void run(ops.purge ?? ops.recheck)}>
                {PROJECT_BOOK_COPY.purge}
              </Button>
            ) : null}
          </div>
        </div>
        {loading ? (
          <p className="app-loading">正在读取{ops.title}…</p>
        ) : book.status === 'error' && book.data === null ? (
          <div className="app-empty">
            <p>{book.error}</p>
            <Button kind="secondary" onClick={() => void store.loadProjectBook()}>
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
                  <TableHeader>过期时间</TableHeader>
                  <TableHeader>状态</TableHeader>
                  <TableHeader className="app-sticky-end" aria-label="操作" />
                </TableRow>
              </TableHead>
              <TableBody>
                {projects.length > 0 ? (
                  projects.map((project) => <BookRow key={project.number} project={project} busy={busy} removeLabel={ops.remove} onRemove={() => void run((adapter) => ops.removeOne(adapter, project.number))} />)
                ) : (
                  <TableRow>
                    <TableCell colSpan={5} className="app-muted">
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

function BookRow({ project, busy, removeLabel, onRemove }: { project: ProjectBookEntry; busy: boolean; removeLabel: string; onRemove: () => void }) {
  return (
    <TableRow data-testid={`book-row-${project.number}`}>
      <TableCell className="app-sticky-start app-nowrap">
        <span className="app-code">{project.number}</span>
      </TableCell>
      <TableCell>{project.name ?? PROJECT_BOOK_COPY.noName}</TableCell>
      <TableCell className="app-nowrap">{project.expiresOn ?? PROJECT_BOOK_COPY.neverExpires}</TableCell>
      <TableCell>
        <StatusTag tone={project.selectable ? 'success' : 'warning'}>{project.statusLabel}</StatusTag>
        {project.statusNote ? <div className="app-caption">{project.statusNote}</div> : null}
      </TableCell>
      <TableCell className="app-num app-sticky-end">
        <Button kind="ghost" size="sm" aria-label={`${removeLabel} ${project.number}`} disabled={busy} onClick={onRemove}>
          {removeLabel}
        </Button>
      </TableCell>
    </TableRow>
  );
}
