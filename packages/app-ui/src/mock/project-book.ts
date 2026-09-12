import type { AppAdapter, ProjectBookOutcome } from '../contract/adapter';
import { PROJECT_BOOK_NOTES, type ProjectBook, type ProjectBookResult } from '../contract/project-book';
import type { ProjectOption } from '../contract/snapshot';
import { stageReached } from '../contract/stage';
import type { MockBus } from './bus';
import { INITIAL_BOOK, MOCK_TODAY, allowListOf, annotateProject, isSafeProjectNumber, projectEntryStep, verifyProjectNumber, type StoredProject } from './fixtures/projects';
import type { MockOptions } from './options';
import type { MockStartup } from './startup';

// mock 服务端的个人项目簿（内核 projectintake.mjs / projectmaintain.mjs 的行为）：
// 录入先做安全字符校验，再核对当前登录身份，再到 mock 报销系统项目目录核验，只有 confirmed 才写入（同号覆盖）；
// 删除、清理全部失效、复检全部同样先核对身份；复检不自动删除。项目簿只存在内存里，刷新后回到夹具（`?book=empty` 时为空）。
// 项目簿一变，还没开始写入报销系统的任务随之拿到新的允许列表；停在「先维护项目簿」的任务有了可选项目就回到项目归属。

export type ProjectBookService = Pick<AppAdapter, 'getProjectBook' | 'intakeProject' | 'removeProject' | 'purgeInvalidProjects' | 'recheckProjects'> & {
  allowList(): ProjectOption[];
  // 打开时按当前项目簿整理夹具任务（允许列表、`?book=empty` 下项目归属的维护门）。
  prepareSeed(taskId: string): void;
};

const EMPTY_BOOK: ProjectBook = { projects: [] };

export function createProjectBook(options: MockOptions, bus: MockBus, startup: MockStartup): ProjectBookService {
  let projects: StoredProject[] = options.bookEmpty ? [] : INITIAL_BOOK.map((project) => ({ ...project }));
  const today = MOCK_TODAY;

  const annotated = () => projects.map((project) => annotateProject(project, today));
  const bookNow = (): ProjectBook => ({ projects: annotated() });
  // 身份没核对通过时不读项目簿。
  const visibleBook = (): ProjectBook => (startup.complete() ? bookNow() : EMPTY_BOOK);
  const allowList = () => allowListOf(annotated());

  const done = (status: ProjectBookResult['status'], note: string, book: ProjectBook = bookNow(), verdict: ProjectBookResult['verdict'] = null): ProjectBookOutcome => ({
    ok: true,
    result: { status, verdict, note, book },
  });

  // 每个维护动作都先核对当前登录身份：没登录或身份没登记 → not_logged_in；与已登记的人不一致 → identity_mismatch。
  const gate = (notLoggedInNote: string): ProjectBookOutcome | null => {
    const employee = startup.employee();
    if (startup.erpSession() !== 'logged_in' || !employee) return done('not_logged_in', notLoggedInNote, EMPTY_BOOK);
    if (employee.binding === 'mismatched') return done('identity_mismatch', PROJECT_BOOK_NOTES.identityMismatch, EMPTY_BOOK);
    if (employee.binding !== 'bound') return done('not_logged_in', notLoggedInNote, EMPTY_BOOK);
    return null;
  };

  // 允许列表跟随项目簿；项目归属阶段的 step 按「有没有可选项目、有没有归属」重新判定（维护门的进出）。
  const applyBook = (taskId: string, list: readonly ProjectOption[]) => {
    const snapshot = bus.draft(taskId);
    if (!stageReached(snapshot.stage, 'project') || snapshot.erp.status !== 'idle' || snapshot.stage === 'done' || snapshot.stage === 'reconcile') return null;
    const before = JSON.stringify([snapshot.projectAssignment.projects, snapshot.step]);
    snapshot.projectAssignment.projects = list.map((project) => ({ ...project }));
    if (snapshot.stage === 'project' && (snapshot.step.kind === 'assign_projects' || snapshot.step.kind === 'maintain_project_book')) {
      snapshot.step = projectEntryStep(snapshot);
    }
    return JSON.stringify([snapshot.projectAssignment.projects, snapshot.step]) === before ? null : snapshot;
  };

  const syncTasks = () => {
    const list = allowList();
    for (const current of bus.all()) {
      const next = applyBook(current.task.taskId, list);
      if (next) bus.push(next);
    }
  };

  return {
    allowList,
    prepareSeed(taskId) {
      const snapshot = bus.draft(taskId);
      // `?book=empty`：预置归属引用的项目不在项目簿里，去掉，让项目归属先走维护门。
      if (options.bookEmpty && snapshot.stage === 'project' && snapshot.projectAssignment.status !== 'submitted') {
        snapshot.projectAssignment = { ...snapshot.projectAssignment, status: 'not_started', assignments: [], working: [], usage: [] };
        bus.put(snapshot);
      }
      const next = applyBook(taskId, allowList());
      if (next) bus.put(next);
    },
    getProjectBook: async () => visibleBook(),

    async intakeProject(number) {
      const trimmed = number.trim();
      if (!trimmed || !isSafeProjectNumber(trimmed)) return done('rejected', PROJECT_BOOK_NOTES.unsafe(trimmed), visibleBook(), 'unsafe');
      const blocked = gate(PROJECT_BOOK_NOTES.intakeNotLoggedIn);
      if (blocked) return blocked;
      const verdict = verifyProjectNumber(trimmed);
      switch (verdict.verdict) {
        case 'failed':
          return done('query_failed', PROJECT_BOOK_NOTES.intakeQueryFailed(verdict.reason));
        case 'missing':
          return done('rejected', PROJECT_BOOK_NOTES.missing(trimmed), bookNow(), 'missing');
        case 'ambiguous':
          return done('rejected', PROJECT_BOOK_NOTES.ambiguous(trimmed, verdict.count), bookNow(), 'ambiguous');
        case 'unusable':
          return done('rejected', PROJECT_BOOK_NOTES.unusable(trimmed, verdict.name), bookNow(), 'unusable');
        case 'confirmed': {
          // 名称只取核验回读值；过期日不开放（永不过期）；同号再次录入覆盖原记录。
          const entry: StoredProject = { number: trimmed, name: verdict.name, expiresOn: null, lastCheckedAt: bus.now(), lastVerdict: 'confirmed' };
          const index = projects.findIndex((project) => project.number === trimmed);
          projects = index >= 0 ? projects.map((project, i) => (i === index ? entry : project)) : [...projects, entry];
          syncTasks();
          return done('admitted', PROJECT_BOOK_NOTES.admitted(trimmed, entry.name));
        }
      }
    },

    async removeProject(number) {
      const blocked = gate(PROJECT_BOOK_NOTES.maintainNotLoggedIn);
      if (blocked) return blocked;
      const trimmed = number.trim();
      const removed = projects.find((project) => project.number === trimmed);
      if (!removed) return done('not_found', PROJECT_BOOK_NOTES.notFound(trimmed));
      projects = projects.filter((project) => project !== removed);
      syncTasks();
      return done('removed', PROJECT_BOOK_NOTES.removed(removed.number, removed.name));
    },

    async purgeInvalidProjects() {
      const blocked = gate(PROJECT_BOOK_NOTES.maintainNotLoggedIn);
      if (blocked) return blocked;
      const kept = projects.filter((project) => annotateProject(project, today).selectable);
      const removedCount = projects.length - kept.length;
      if (removedCount === 0) return done('none', PROJECT_BOOK_NOTES.purgeNone);
      projects = kept;
      syncTasks();
      return done('purged', PROJECT_BOOK_NOTES.purged(removedCount));
    },

    async recheckProjects() {
      const blocked = gate(PROJECT_BOOK_NOTES.recheckNotLoggedIn);
      if (blocked) return blocked;
      if (projects.length === 0) return done('empty', PROJECT_BOOK_NOTES.recheckEmpty);
      const askable = projects.filter((project) => isSafeProjectNumber(project.number));
      const verdicts = new Map<string, ReturnType<typeof verifyProjectNumber>>();
      for (const project of askable) {
        const verdict = verifyProjectNumber(project.number);
        // 任何一条查询没完成：整次复检作废，项目簿不动。
        if (verdict.verdict === 'failed') return done('query_failed', PROJECT_BOOK_NOTES.recheckQueryFailed(verdict.reason));
        verdicts.set(project.number, verdict);
      }
      const at = bus.now();
      projects = projects.map((project) => {
        if (!isSafeProjectNumber(project.number)) return { ...project, lastVerdict: 'unsafe' };
        const verdict = verdicts.get(project.number);
        if (!verdict) return project;
        return { ...project, ...(verdict.verdict === 'confirmed' ? { name: verdict.name } : {}), lastVerdict: verdict.verdict, lastCheckedAt: at };
      });
      syncTasks();
      const invalid = annotated().filter((project) => !project.selectable).length;
      return done('done', PROJECT_BOOK_NOTES.recheckDone(askable.length, invalid));
    },
  };
}
