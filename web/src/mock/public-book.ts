import { ADMIN_ERRORS, AUTH_ERRORS, FORBIDDEN_CODE, PROJECT_BOOK_NOTES, UNAUTHENTICATED_CODE, type AppAdapter, type ProjectBook, type ProjectBookEditInput, type ProjectBookIntakeInput, type ProjectBookLifecycleInput, type ProjectBookOutcome, type ProjectBookResult, type PublicProjectConversionInput } from '@baox/contract';
import type { MockAuth } from './auth';
import { MOCK_TODAY, annotateProject, isSafeProjectNumber } from './fixtures/projects';
import type { MockBookState } from './project-book';

// Public entries are visible to every signed-in account. A public number reserves that number globally, while a
// personal collision stays intentionally generic and identifies only the personal book, never its owner.

export type PublicBookService = Pick<AppAdapter, 'getPublicProjectBook' | 'intakePublicProject' | 'editPublicProject' | 'confirmPublicProjectConversion' | 'deactivatePublicProject' | 'restorePublicProject'>;

const EMPTY_BOOK: ProjectBook = { projects: [] };

export function createPublicBook(auth: MockAuth, state: MockBookState, refreshAllTasks: () => void): PublicBookService {
  const bookNow = (): ProjectBook => ({ projects: state.publicProjects.map((project) => annotateProject(project, MOCK_TODAY)) });
  const say = (note: string) => note.replaceAll('个人项目簿', '公共项目簿');
  const done = (status: ProjectBookResult['status'], note: string, verdict: ProjectBookResult['verdict'] = null, localizeBookName = true): ProjectBookOutcome => ({ ok: true, result: { status, verdict, note: localizeBookName ? say(note) : note, book: bookNow() } });
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
        return done('conversion_required', PROJECT_BOOK_NOTES.conversionRequired(number), null, false);
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

    async editPublicProject(input: ProjectBookEditInput) {
      const account = auth.account();
      if (!account) return unauthenticated();
      if (account.role !== 'admin') return forbidden();
      const originalNumber = input.originalNumber.trim();
      const number = input.number.trim();
      const name = input.name.trim();
      if (number === '') return done('rejected', PROJECT_BOOK_NOTES.numberRequired);
      if (!isSafeProjectNumber(number)) return done('rejected', PROJECT_BOOK_NOTES.editUnsafe(number).replace('个人项目簿', '公共项目簿'), 'unsafe');
      if (name === '') return done('rejected', PROJECT_BOOK_NOTES.nameRequired);
      const index = state.publicProjects.findIndex((project) => project.number === originalNumber);
      if (index < 0) return done('rejected', PROJECT_BOOK_NOTES.editMissing(originalNumber).replace('个人项目簿', '公共项目簿'));
      if (number !== originalNumber && state.publicProjects.some((project) => project.number === number)) return done('rejected', PROJECT_BOOK_NOTES.editDuplicate(number).replace('个人项目簿', '公共项目簿'));
      if (number !== originalNumber && [...state.personalByAccount.values()].some((projects) => projects.some((project) => project.number === number))) {
        return done('conversion_required', PROJECT_BOOK_NOTES.conversionRequired(number), null, false);
      }

      const existing = state.publicProjects[index]!;
      state.publicProjects = state.publicProjects.map((project, projectIndex) => (projectIndex === index ? { ...existing, number, name } : project));
      refreshAllTasks();
      return done('edited', PROJECT_BOOK_NOTES.edited(originalNumber, number, name).replace('个人项目簿', '公共项目簿'));
    },

    async confirmPublicProjectConversion(input: PublicProjectConversionInput) {
      const account = auth.account();
      if (!account) return unauthenticated();
      if (account.role !== 'admin') return forbidden();
      const number = input.number.trim();
      const name = input.name.trim();
      if (number === '') return done('rejected', PROJECT_BOOK_NOTES.numberRequired);
      if (!isSafeProjectNumber(number)) return done('rejected', PROJECT_BOOK_NOTES.unsafe(number), 'unsafe');
      if (name === '') return done('rejected', PROJECT_BOOK_NOTES.nameRequired);

      if (input.operation === 'intake') {
        if (state.publicProjects.some((project) => project.number === number)) return done('rejected', PROJECT_BOOK_NOTES.duplicate(number));
      } else {
        const originalNumber = input.originalNumber.trim();
        const existing = state.publicProjects.find((project) => project.number === originalNumber);
        if (!existing) return done('rejected', PROJECT_BOOK_NOTES.editMissing(originalNumber));
        if (number === originalNumber || existing.name !== input.originalName || existing.active !== input.originalActive) return done('rejected', PROJECT_BOOK_NOTES.conversionStale, null, false);
        if (state.publicProjects.some((project) => project.number === number)) return done('rejected', PROJECT_BOOK_NOTES.editDuplicate(number));
      }

      const personalMatches = [...state.personalByAccount.entries()].filter(([, projects]) => projects.some((project) => project.number === number));
      if (personalMatches.length === 0) return done('rejected', PROJECT_BOOK_NOTES.conversionStale, null, false);
      if (input.operation === 'intake') {
        state.publicProjects = [...state.publicProjects, { number, name, expiresOn: null, lastCheckedAt: null, lastVerdict: 'local', active: true }];
      } else {
        const originalNumber = input.originalNumber.trim();
        state.publicProjects = state.publicProjects.map((project) => (project.number === originalNumber ? { ...project, number, name } : project));
      }
      for (const [accountId, projects] of personalMatches) state.personalByAccount.set(accountId, projects.filter((project) => project.number !== number));
      refreshAllTasks();
      return done('converted', PROJECT_BOOK_NOTES.converted(number, name), null, false);
    },
  };
}
