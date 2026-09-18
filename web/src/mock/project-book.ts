import { AUTH_ERRORS, UNAUTHENTICATED_CODE, PROJECT_BOOK_NOTES, PROJECT_CHANGED_NOTICE, type AppAdapter, type ProjectBook, type ProjectBookEditInput, type ProjectBookIntakeInput, type ProjectBookLifecycleInput, type ProjectBookOutcome, type ProjectBookResult, type ProjectOption, type TaskSnapshot, stageReached } from '@baox/contract';
import type { MockAuth } from './auth';
import type { MockBus } from './bus';
import { INITIAL_BOOK, MOCK_TODAY, annotateProject, isSafeProjectNumber, projectEntryStep, withProjectUsage, type StoredProject } from './fixtures/projects';
import type { MockOptions } from './options';

// The mock mirrors the local application's two project books. Manual admissions intentionally never consult the
// fixture ERP directory: they only validate the project number and retain the name entered by the member.

export type MockBookState = {
  readonly personalByAccount: Map<string, StoredProject[]>;
  publicProjects: StoredProject[];
};

export function createMockBookState(options: MockOptions, fixtureAccountId: string): MockBookState {
  return {
    personalByAccount: new Map(
      options.bookEmpty ? [] : [[fixtureAccountId, INITIAL_BOOK.map((project) => ({ ...project }))]],
    ),
    publicProjects: [],
  };
}

export type ProjectBookService = Pick<AppAdapter, 'getProjectBook' | 'intakeProject' | 'editProject' | 'deactivateProject' | 'restoreProject' | 'deleteProject'> & {
  allowList(taskId?: string): ProjectOption[];
  prepareSeed(taskId: string): void;
  refreshTasks(): void;
  refreshAllTasks(): void;
  reset(): void;
};

const EMPTY_BOOK: ProjectBook = { projects: [] };

export function createProjectBook(
  _options: MockOptions,
  bus: MockBus,
  auth: MockAuth,
  state: MockBookState,
  ownerOfTask: (taskId: string) => string | null,
): ProjectBookService {
  const personalFor = (accountId: string): StoredProject[] => {
    const existing = state.personalByAccount.get(accountId);
    if (existing) return existing;
    const empty: StoredProject[] = [];
    state.personalByAccount.set(accountId, empty);
    return empty;
  };
  const annotated = (accountId: string) => {
    const publicNumbers = new Set(state.publicProjects.map((project) => project.number));
    return personalFor(accountId).map((project) => {
      const entry = annotateProject(project, MOCK_TODAY);
      if (!publicNumbers.has(entry.number)) return entry;
      const notes = [entry.statusNote, PROJECT_BOOK_NOTES.publicReserved(entry.number)].filter((note): note is string => note !== null);
      return {
        ...entry,
        selectable: false,
        statusLabel: entry.statusLabel === '可选' ? '公共项目已保留' : `${entry.statusLabel}・公共项目已保留`,
        statusNote: [...new Set(notes)].join('；'),
      };
    });
  };
  const publicAnnotated = () => state.publicProjects.map((project) => annotateProject(project, MOCK_TODAY));
  const bookNow = (accountId: string): ProjectBook => ({ projects: annotated(accountId) });
  const visibleBook = (): ProjectBook => {
    const account = auth.account();
    return account ? bookNow(account.accountId) : EMPTY_BOOK;
  };
  const allowListFor = (accountId: string): ProjectOption[] => {
    const personal = annotated(accountId)
      .filter((project) => project.selectable)
      .map((project): ProjectOption => ({ number: project.number, name: project.name ?? project.number, source: 'personal' }));
    const shared = publicAnnotated()
      .filter((project) => project.selectable)
      .map((project): ProjectOption => ({ number: project.number, name: project.name ?? project.number, source: 'public' }));
    return [...personal, ...shared];
  };
  const allowList = (taskId?: string): ProjectOption[] => {
    if (taskId) {
      const owner = ownerOfTask(taskId);
      return owner ? allowListFor(owner) : [];
    }
    const account = auth.account();
    return account ? allowListFor(account.accountId) : [];
  };
  const done = (status: ProjectBookResult['status'], note: string, accountId: string, verdict: ProjectBookResult['verdict'] = null): ProjectBookOutcome => ({
    ok: true,
    result: { status, verdict, note, book: bookNow(accountId) },
  });
  const unauthenticated = (): ProjectBookOutcome => ({ ok: false, error: { code: UNAUTHENTICATED_CODE, message: AUTH_ERRORS.unauthenticated }, book: null });
  const availabilityConfirmations = new Map<string, { confirmation: TaskSnapshot['confirmation']; selection: string }>();

  const refreshFingerprint = (snapshot: TaskSnapshot) =>
    JSON.stringify([snapshot.projectAssignment.projects, snapshot.projectAssignment.working, snapshot.projectAssignment.reselect, snapshot.projectAssignment.usage, snapshot.confirmation, snapshot.stage, snapshot.step]);

  const applyBook = (taskId: string, list: readonly ProjectOption[]) => {
    const snapshot = bus.draft(taskId);
    if (!stageReached(snapshot.stage, 'project') || snapshot.erp.status !== 'idle' || snapshot.stage === 'done' || snapshot.stage === 'reconcile') return null;
    const before = refreshFingerprint(snapshot);
    snapshot.projectAssignment.projects = list.map((project) => ({ ...project }));
    const selectable = new Set(list.map((project) => `${project.source}:${project.number}`));
    if (snapshot.projectAssignment.status !== 'submitted') {
      const candidates = new Map(snapshot.projectAssignment.reselect.map((entry) => [entry.lineId, entry]));
      for (const entry of snapshot.projectAssignment.working) candidates.set(entry.lineId, entry);
      snapshot.projectAssignment.working = [];
      snapshot.projectAssignment.reselect = [];
      for (const entry of candidates.values()) {
        if (selectable.has(`${entry.projectSource}:${entry.projectNumber}`)) snapshot.projectAssignment.working.push(entry);
        else snapshot.projectAssignment.reselect.push(entry);
      }
    }
    withProjectUsage(snapshot);

    const selection = JSON.stringify(snapshot.projectAssignment.assignments.map((entry) => [entry.lineId, entry.projectSource, entry.projectNumber]));
    const submittedAvailable = snapshot.projectAssignment.status === 'submitted' && snapshot.projectAssignment.assignments.every((entry) => selectable.has(`${entry.projectSource}:${entry.projectNumber}`));
    if (!submittedAvailable && snapshot.confirmation.status === 'confirmed') {
      availabilityConfirmations.set(taskId, { confirmation: { ...snapshot.confirmation }, selection });
      snapshot.confirmation = { ...snapshot.confirmation, status: 'invalidated', confirmedAt: null, notice: PROJECT_CHANGED_NOTICE };
      snapshot.stage = 'review';
      snapshot.step = { kind: 'confirm_review', stepToken: snapshot.step.stepToken };
    } else if (submittedAvailable && snapshot.confirmation.status === 'invalidated') {
      const prior = availabilityConfirmations.get(taskId);
      if (prior?.selection === selection) {
        snapshot.confirmation = prior.confirmation;
        snapshot.stage = 'actions';
        snapshot.step = { kind: 'choose_action', stepToken: snapshot.step.stepToken };
        availabilityConfirmations.delete(taskId);
      }
    }
    if (snapshot.stage === 'project' && (snapshot.step.kind === 'assign_projects' || snapshot.step.kind === 'maintain_project_book')) {
      snapshot.step = { ...projectEntryStep(snapshot), stepToken: snapshot.step.stepToken };
    }
    if (refreshFingerprint(snapshot) === before) return null;
    snapshot.step = { ...snapshot.step, stepToken: bus.rotateToken(snapshot.step.stepToken) };
    return snapshot;
  };

  const refreshAccountTasks = (accountId: string) => {
    const list = allowListFor(accountId);
    for (const current of bus.all()) {
      if (ownerOfTask(current.task.taskId) !== accountId) continue;
      const next = applyBook(current.task.taskId, list);
      if (next) bus.push(next);
    }
  };

  return {
    allowList,
    reset() {
      const account = auth.account();
      if (!account) return;
      state.personalByAccount.set(account.accountId, []);
      refreshAccountTasks(account.accountId);
    },
    prepareSeed(taskId) {
      const owner = ownerOfTask(taskId);
      if (!owner) return;
      const next = applyBook(taskId, allowListFor(owner));
      if (next) bus.put(next);
    },
    refreshTasks() {
      const account = auth.account();
      if (account) refreshAccountTasks(account.accountId);
    },
    refreshAllTasks() {
      const owners = new Set(bus.all().map((snapshot) => ownerOfTask(snapshot.task.taskId)).filter((owner): owner is string => owner !== null));
      for (const owner of owners) refreshAccountTasks(owner);
    },
    getProjectBook: async () => visibleBook(),

    async intakeProject(input: ProjectBookIntakeInput) {
      const account = auth.account();
      if (!account) return unauthenticated();
      const number = input.number.trim();
      const name = input.name.trim();
      if (number === '') return done('rejected', PROJECT_BOOK_NOTES.numberRequired, account.accountId);
      if (!isSafeProjectNumber(number)) return done('rejected', PROJECT_BOOK_NOTES.unsafe(number), account.accountId, 'unsafe');
      if (name === '') return done('rejected', PROJECT_BOOK_NOTES.nameRequired, account.accountId);
      const personal = personalFor(account.accountId);
      if (personal.some((project) => project.number === number)) return done('rejected', PROJECT_BOOK_NOTES.duplicate(number), account.accountId);
      if (state.publicProjects.some((project) => project.number === number)) return done('rejected', PROJECT_BOOK_NOTES.publicReserved(number), account.accountId);

      state.personalByAccount.set(account.accountId, [
        ...personal,
        { number, name, expiresOn: null, lastCheckedAt: null, lastVerdict: 'local', active: true },
      ]);
      refreshAccountTasks(account.accountId);
      return done('admitted', PROJECT_BOOK_NOTES.admitted(number, name), account.accountId);
    },

    async editProject(input: ProjectBookEditInput) {
      const account = auth.account();
      if (!account) return unauthenticated();
      const originalNumber = input.originalNumber.trim();
      const number = input.number.trim();
      const name = input.name.trim();
      if (number === '') return done('rejected', PROJECT_BOOK_NOTES.numberRequired, account.accountId);
      if (!isSafeProjectNumber(number)) return done('rejected', PROJECT_BOOK_NOTES.editUnsafe(number), account.accountId, 'unsafe');
      if (name === '') return done('rejected', PROJECT_BOOK_NOTES.nameRequired, account.accountId);
      const personal = personalFor(account.accountId);
      const index = personal.findIndex((project) => project.number === originalNumber);
      if (index < 0) return done('rejected', PROJECT_BOOK_NOTES.editMissing(originalNumber), account.accountId);
      if (number !== originalNumber && personal.some((project) => project.number === number)) return done('rejected', PROJECT_BOOK_NOTES.editDuplicate(number), account.accountId);
      if (number !== originalNumber && state.publicProjects.some((project) => project.number === number)) return done('rejected', PROJECT_BOOK_NOTES.editPublicReserved(number), account.accountId);

      const existing = personal[index]!;
      state.personalByAccount.set(account.accountId, personal.map((project, projectIndex) => (projectIndex === index ? { ...existing, number, name } : project)));
      refreshAccountTasks(account.accountId);
      return done('edited', PROJECT_BOOK_NOTES.edited(originalNumber, number, name), account.accountId);
    },

    async deactivateProject(input: ProjectBookLifecycleInput) {
      const account = auth.account();
      if (!account) return unauthenticated();
      const number = input.number.trim();
      const personal = personalFor(account.accountId);
      const entry = personal.find((project) => project.number === number);
      if (!entry) return done('rejected', PROJECT_BOOK_NOTES.notFound(number), account.accountId);
      if (entry.active === false) return done('rejected', PROJECT_BOOK_NOTES.alreadyInactive(number), account.accountId);
      state.personalByAccount.set(account.accountId, personal.map((project) => (project.number === number ? { ...project, active: false } : project)));
      refreshAccountTasks(account.accountId);
      return done('deactivated', PROJECT_BOOK_NOTES.deactivated(number), account.accountId);
    },

    async restoreProject(input: ProjectBookLifecycleInput) {
      const account = auth.account();
      if (!account) return unauthenticated();
      const number = input.number.trim();
      const personal = personalFor(account.accountId);
      const entry = personal.find((project) => project.number === number);
      if (!entry) return done('rejected', PROJECT_BOOK_NOTES.notFound(number), account.accountId);
      if (entry.active !== false) return done('rejected', PROJECT_BOOK_NOTES.alreadyActive(number), account.accountId);
      if (state.publicProjects.some((project) => project.number === number)) return done('rejected', PROJECT_BOOK_NOTES.publicReserved(number), account.accountId);
      state.personalByAccount.set(account.accountId, personal.map((project) => (project.number === number ? { ...project, active: true } : project)));
      refreshAccountTasks(account.accountId);
      return done('restored', PROJECT_BOOK_NOTES.restored(number), account.accountId);
    },

    async deleteProject(input: ProjectBookLifecycleInput) {
      const account = auth.account();
      if (!account) return unauthenticated();
      const number = input.number.trim();
      const personal = personalFor(account.accountId);
      if (!personal.some((project) => project.number === number)) return done('rejected', PROJECT_BOOK_NOTES.notFound(number), account.accountId);
      state.personalByAccount.set(account.accountId, personal.filter((project) => project.number !== number));
      refreshAccountTasks(account.accountId);
      return done('deleted', PROJECT_BOOK_NOTES.deleted(number), account.accountId);
    },
  };
}
