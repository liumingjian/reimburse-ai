import { ADMIN_ERRORS, FORBIDDEN_CODE, PROJECT_BOOK_NOTES, PUBLIC_PROJECT_BOOK_NOTES, type AppAdapter, type ProjectBook, type ProjectBookEntry, type ProjectBookOutcome, type ProjectBookResult } from '@baox/contract';
import type { MockAuth } from './auth';
import { MOCK_TODAY, annotateProject, isSafeProjectNumber, verifyProjectNumber, type StoredProject } from './fixtures/projects';

// mock 服务端的公共项目簿（#194）：所有账号可读，只有管理员能录入、停用、复检。删除即停用：条目留在簿里，状态「已停用」。
// 简化：mock 里公共项目不进入任务的项目允许列表（真实服务端会并排给出）；公共项目簿从空开始，只存在内存里。

export type PublicBookService = Pick<AppAdapter, 'getPublicProjectBook' | 'intakePublicProject' | 'removePublicProject' | 'recheckPublicProjects'>;

type Stored = StoredProject & { deactivated: boolean };

const say = (note: string) => note.replaceAll('个人项目簿', '公共项目簿');

function annotate(project: Stored): ProjectBookEntry {
  if (!project.deactivated) return annotateProject(project, MOCK_TODAY);
  return { ...annotateProject(project, MOCK_TODAY), selectable: false, statusLabel: '已停用', statusNote: '管理员已在公共项目簿停用这个项目，不能再选' };
}

export function createPublicBook(auth: MockAuth, now: () => string): PublicBookService {
  let projects: Stored[] = [];
  const bookNow = (): ProjectBook => ({ projects: projects.map(annotate) });
  const done = (status: ProjectBookResult['status'], note: string, verdict: ProjectBookResult['verdict'] = null): ProjectBookOutcome => ({ ok: true, result: { status, verdict, note: say(note), book: bookNow() } });
  const gate = (): ProjectBookOutcome | null => {
    const account = auth.account();
    if (!account) return done('not_logged_in', PROJECT_BOOK_NOTES.maintainNotLoggedIn);
    return account.role === 'admin' ? null : { ok: false, error: { code: FORBIDDEN_CODE, message: ADMIN_ERRORS.forbidden }, book: bookNow() };
  };

  return {
    getPublicProjectBook: async () => (auth.account() ? bookNow() : { projects: [] }),
    async intakePublicProject(number) {
      const blocked = gate();
      if (blocked) return blocked;
      const trimmed = number.trim();
      if (!trimmed || !isSafeProjectNumber(trimmed)) return done('rejected', PROJECT_BOOK_NOTES.unsafe(trimmed), 'unsafe');
      const verdict = verifyProjectNumber(trimmed);
      switch (verdict.verdict) {
        case 'failed':
          return done('query_failed', PROJECT_BOOK_NOTES.intakeQueryFailed(verdict.reason));
        case 'missing':
          return done('rejected', PROJECT_BOOK_NOTES.missing(trimmed), 'missing');
        case 'ambiguous':
          return done('rejected', PROJECT_BOOK_NOTES.ambiguous(trimmed, verdict.count), 'ambiguous');
        case 'unusable':
          return done('rejected', PROJECT_BOOK_NOTES.unusable(trimmed, verdict.name), 'unusable');
        case 'confirmed': {
          const entry: Stored = { number: trimmed, name: verdict.name, expiresOn: null, lastCheckedAt: now(), lastVerdict: 'confirmed', deactivated: false };
          projects = projects.some((project) => project.number === trimmed) ? projects.map((project) => (project.number === trimmed ? entry : project)) : [...projects, entry];
          return done('admitted', PROJECT_BOOK_NOTES.admitted(trimmed, entry.name));
        }
      }
    },
    async removePublicProject(number) {
      const blocked = gate();
      if (blocked) return blocked;
      const trimmed = number.trim();
      const found = projects.find((project) => project.number === trimmed && !project.deactivated);
      if (!found) return done('not_found', PROJECT_BOOK_NOTES.notFound(trimmed));
      projects = projects.map((project) => (project === found ? { ...project, deactivated: true } : project));
      return done('removed', PUBLIC_PROJECT_BOOK_NOTES.deactivated(found.number, found.name));
    },
    async recheckPublicProjects() {
      const blocked = gate();
      if (blocked) return blocked;
      const live = projects.filter((project) => !project.deactivated);
      if (live.length === 0) return done('empty', PROJECT_BOOK_NOTES.recheckEmpty);
      for (const project of live) {
        const verdict = verifyProjectNumber(project.number);
        if (verdict.verdict === 'failed') return done('query_failed', PROJECT_BOOK_NOTES.recheckQueryFailed(verdict.reason));
      }
      const at = now();
      projects = projects.map((project) => {
        if (project.deactivated) return project;
        const verdict = verifyProjectNumber(project.number);
        return { ...project, ...(verdict.verdict === 'confirmed' ? { name: verdict.name } : {}), lastVerdict: verdict.verdict, lastCheckedAt: at };
      });
      return done('done', PROJECT_BOOK_NOTES.recheckDone(live.length, projects.map(annotate).filter((project) => !project.selectable).length));
    },
  };
}
