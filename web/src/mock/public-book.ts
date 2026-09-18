import { ADMIN_ERRORS, AUTH_ERRORS, FORBIDDEN_CODE, PROJECT_BOOK_NOTES, UNAUTHENTICATED_CODE, type AppAdapter, type ProjectBook, type ProjectBookIntakeInput, type ProjectBookLifecycleInput, type ProjectBookOutcome, type ProjectBookResult } from '@baox/contract';
import type { MockAuth } from './auth';
import { MOCK_TODAY, annotateProject, isSafeProjectNumber } from './fixtures/projects';
import type { MockBookState } from './project-book';

// Public entries are visible to every signed-in account. A public number reserves that number globally, while a
// personal collision stays intentionally generic and identifies only the personal book, never its owner.

export type PublicBookService = Pick<AppAdapter, 'getPublicProjectBook' | 'intakePublicProject' | 'deactivatePublicProject' | 'restorePublicProject'>;

const EMPTY_BOOK: ProjectBook = { projects: [] };

export function createPublicBook(auth: MockAuth, state: MockBookState, refreshAllTasks: () => void): PublicBookService {
  const bookNow = (): ProjectBook => ({ projects: state.publicProjects.map((project) => annotateProject(project, MOCK_TODAY)) });
  const say = (note: string) => note.replaceAll('个人项目簿', '公共项目簿');
  const done = (status: ProjectBookResult['status'], note: string, verdict: ProjectBookResult['verdict'] = null): ProjectBookOutcome => ({ ok: true, result: { status, verdict, note: say(note), book: bookNow() } });
  const unauthenticated = (): ProjectBookOutcome => ({ ok: false, error: { code: UNAUTHENTICATED_CODE, message: AUTH_ERRORS.unauthenticated }, book: null });
  const forbidden = (): ProjectBookOutcome => ({ ok: false, error: { code: FORBIDDEN_CODE, message: ADMIN_ERRORS.forbidden }, book: bookNow() });

  return {
    getPublicProjectBook: async () => (auth.account() ? bookNow() : EMPTY_BOOK),
    async intakePublicProject(input: ProjectBookIntakeInput) {
      const account = auth.account();
      if (!account) return unauthenticated();
      if (account.role !== 'admin') return forbidden();
      const number = input.number.trim();
      const name = input.name.trim();
      if (number === '') return done('rejected', PROJECT_BOOK_NOTES.numberRequired);
      if (!isSafeProjectNumber(number)) return done('rejected', PROJECT_BOOK_NOTES.unsafe(number), 'unsafe');
      if (name === '') return done('rejected', PROJECT_BOOK_NOTES.nameRequired);
      if (state.publicProjects.some((project) => project.number === number)) return done('rejected', PROJECT_BOOK_NOTES.duplicate(number));
      if ([...state.personalByAccount.values()].some((projects) => projects.some((project) => project.number === number))) {
        return { ok: true, result: { status: 'rejected', verdict: null, note: PROJECT_BOOK_NOTES.publicPersonalCollision(number), book: bookNow() } };
      }

      state.publicProjects = [...state.publicProjects, { number, name, expiresOn: null, lastCheckedAt: null, lastVerdict: 'local', active: true }];
      refreshAllTasks();
      return done('admitted', PROJECT_BOOK_NOTES.admitted(number, name));
    },

    async deactivatePublicProject(input: ProjectBookLifecycleInput) {
      const account = auth.account();
      if (!account) return unauthenticated();
      if (account.role !== 'admin') return forbidden();
      const number = input.number.trim();
      const entry = state.publicProjects.find((project) => project.number === number);
      if (!entry) return done('rejected', PROJECT_BOOK_NOTES.notFound(number));
      if (entry.active === false) return done('rejected', PROJECT_BOOK_NOTES.alreadyInactive(number));
      state.publicProjects = state.publicProjects.map((project) => (project.number === number ? { ...project, active: false } : project));
      refreshAllTasks();
      return done('deactivated', PROJECT_BOOK_NOTES.deactivated(number));
    },

    async restorePublicProject(input: ProjectBookLifecycleInput) {
      const account = auth.account();
      if (!account) return unauthenticated();
      if (account.role !== 'admin') return forbidden();
      const number = input.number.trim();
      const entry = state.publicProjects.find((project) => project.number === number);
      if (!entry) return done('rejected', PROJECT_BOOK_NOTES.notFound(number));
      if (entry.active !== false) return done('rejected', PROJECT_BOOK_NOTES.alreadyActive(number));
      state.publicProjects = state.publicProjects.map((project) => (project.number === number ? { ...project, active: true } : project));
      refreshAllTasks();
      return done('restored', PROJECT_BOOK_NOTES.restored(number));
    },
  };
}
