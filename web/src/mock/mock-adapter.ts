import {
  ADMIN_ERRORS,
  AUTH_ERRORS,
  ServiceUnavailableError,
  UNAUTHENTICATED_CODE,
  UnauthenticatedError,
  type AccountListOutcome,
  type ActionOutcome,
  type AppAdapter,
  type AuthOutcome,
  type LegacyImportOutcome,
  type ProjectBookOutcome,
  type TaskListOutcome,
  ABANDON_TASK_COPY,
  CREATE_TASK_ERRORS,
  CreateTaskInputSchema,
  HOME_CITY_ERRORS,
  type ActionError,
  TaskListSchema,
  type TaskList,
} from '@baox/contract';
import { SERVICE_UNAVAILABLE_CODE, SERVICE_UNAVAILABLE_MESSAGE, createBus } from './bus';
import { buildPrintSheet } from './fixtures/print';
import { HOME_CITY } from './fixtures/projects';
import { T1_ID, emptySnapshot, t1Snapshot, t2Snapshot, t3Snapshot, toListItem } from './fixtures/tasks';
import { createMockBookState, createProjectBook } from './project-book';
import { createPublicBook } from './public-book';
import { MOCK_ACCOUNT, createAuth } from './auth';
import { createErpFlow } from './flows/erp';
import { createInventoryFlow } from './flows/inventory';
import { createPendingFlow } from './flows/pending';
import { createPrintFlow } from './flows/print';
import { createProjectFlow } from './flows/project';
import { createLegacyImportFlow } from './legacy-import';
import type { MockOptions } from './options';

export { SERVICE_UNAVAILABLE_CODE, SERVICE_UNAVAILABLE_MESSAGE } from './bus';
export { FAULTS, readMockOptions, type Fault, type MockOptions, type MockStorage } from './options';

// 浏览器内 mock 适配器：实现与 HTTP 适配器相同的接口，用内存里的快照回答一切。只经 main.tsx 的动态 import 进入 mock 构建。
// 本文件只做组装：公共底座（快照仓库、事件总线、断连模拟）在 ./bus.ts，各业务流程在 ./flows/：
// inventory（上传批次、材料盘点、追加材料）、pending（待确认项、整单明细确认）、project（项目归属，其后的报销信息核对与材料准备）、
// print（打印稿、支付截图）、erp（去报销后的 ERP 填报、对账）。

// 只在 mock 构建里挂到 window 上的测试钩子（e2e 用）：模拟「另一个窗口推进了任务」，而这边的事件流还没送到。
export type MockHooks = {
  advanceElsewhere(taskId: string): void;
};

declare global {
  interface Window {
    __baoxMock?: MockHooks;
  }
}

export type MockAdapter = AppAdapter & MockHooks;

export function installMockHooks(target: Window, adapter: MockAdapter): void {
  target.__baoxMock = { advanceElsewhere: (taskId) => adapter.advanceElsewhere(taskId) };
}

// 读快照与订阅不受断连影响（快照读的是内存）；任务列表断开期间读不到；其余都是动作，断开期间一律失败，原因就地显示在按钮旁。
const READ_METHODS: ReadonlySet<keyof AppAdapter> = new Set<keyof AppAdapter>(['getSession', 'listTasks', 'getSnapshot', 'subscribe', 'getProjectBook', 'getPublicProjectBook', 'listAccounts', 'getLegacyImport']);
// 旧数据导入的重试 / 跳过带回新的导入结果。
const LEGACY_METHODS: ReadonlySet<keyof AppAdapter> = new Set<keyof AppAdapter>(['retryLegacyImport', 'skipLegacyImport']);
// 作废与重置的失败形状带 taskList 而不是 snapshot；账号动作只有 error；项目簿维护动作带 book。
const LIST_METHODS: ReadonlySet<keyof AppAdapter> = new Set<keyof AppAdapter>(['abandonTask', 'resetAll']);
const AUTH_METHODS: ReadonlySet<keyof AppAdapter> = new Set<keyof AppAdapter>(['setupAdmin', 'register', 'login', 'logout', 'changePassword']);
const BOOK_METHODS: ReadonlySet<keyof AppAdapter> = new Set<keyof AppAdapter>(['intakeProject', 'deactivateProject', 'restoreProject', 'intakePublicProject', 'deactivatePublicProject', 'restorePublicProject']);
const ACCOUNT_METHODS: ReadonlySet<keyof AppAdapter> = new Set<keyof AppAdapter>(['updateAccount']);

export function createMockAdapter(options: MockOptions): MockAdapter {
  const bus = createBus(options);
  let nextTaskNo = 4;

  const seeded = t1Snapshot(options.seed ?? 'upload', options.fault === 'unsupported-material', options.allocationRequired === true);
  if (options.printSheet) seeded.printSheet = buildPrintSheet(seeded);
  bus.put(seeded);
  bus.put(t2Snapshot());
  bus.put(t3Snapshot());

  const auth = createAuth(options);
  // 夹具任务 T1-T3 属于夹具账号；新建的任务属于创建它的账号。别的账号看不到，也打不开（ADR-0018）。
  const owners = new Map<string, string>();
  const ownedByCurrent = (taskId: string) => (owners.get(taskId) ?? MOCK_ACCOUNT.accountId) === auth.account()?.accountId;
  // 个人项目簿：任务进入项目归属时的允许列表跟随它；夹具 T1 按当前项目簿整理（`?book=empty` 下先走维护门）。
  const bookState = createMockBookState(options, MOCK_ACCOUNT.accountId);
  const ownerOfTask = (taskId: string) => owners.get(taskId) ?? MOCK_ACCOUNT.accountId;
  const book = createProjectBook(options, bus, auth, bookState, ownerOfTask);
  const publicBook = createPublicBook(auth, bookState, book.refreshAllTasks);
  bus.useProjectAllowList(book.allowList);
  book.prepareSeed(T1_ID);

  const inventory = createInventoryFlow(bus);
  const pending = createPendingFlow(bus);
  const project = createProjectFlow(bus);
  // `?seed=catalog` / `?seed=preparation`：自动步骤接着走完，进入整单确认。
  project.resumeAutoSteps(T1_ID);
  // 作废的任务与完全重置前的任务不再出现在列表里（内核作废是状态变更，工作区保留；快照留在内存里，免得定时器扑空）。
  const hidden = new Set<string>();
  const listNow = (): TaskList => {
    const tasks = bus
      .all()
      .filter((snapshot) => !hidden.has(snapshot.task.taskId) && ownedByCurrent(snapshot.task.taskId))
      .map(toListItem)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return TaskListSchema.parse({ homeCity: homeCityDefault(), tasks });
  };
  const listResult = (error: ActionError | null): TaskListOutcome => (error ? { ok: false, error, taskList: listNow() } : { ok: true, taskList: listNow() });
  const signedOut = (): TaskListOutcome => ({ ok: false, error: { code: UNAUTHENTICATED_CODE, message: AUTH_ERRORS.unauthenticated }, taskList: null });

  // 常驻城市默认值：这个账号确认过就用记住的城市（持久存储，按账号分键，刷新后仍在）；
  // 否则用 mock 位置 Adapter 的城市级网络位置（夹具员工在杭州）；`?location=unavailable` 下位置获取失败，又没有记忆，默认值为 null。
  const homeCityDefault = (): TaskList['homeCity'] => {
    const rememberedCity = auth.rememberedCity();
    if (rememberedCity) return { value: rememberedCity, source: 'remembered' };
    if (options.locationUnavailable) return null;
    return { value: HOME_CITY, source: 'network' };
  };

  const adapter: AppAdapter = {
    // The session reads memory, like snapshots: a disconnect shows up on the task list (banner), not at the gate.
    getSession: async () => auth.session(),
    setupAdmin: async (input): Promise<AuthOutcome> => auth.setupAdmin(input),
    register: async (input): Promise<AuthOutcome> => auth.register(input),
    login: async (input): Promise<AuthOutcome> => auth.login(input),
    logout: async (): Promise<AuthOutcome> => auth.logout(),
    changePassword: async (input): Promise<AuthOutcome> => auth.changePassword(input),
    async listAccounts() {
      const account = auth.account();
      if (!account) throw new UnauthenticatedError();
      if (account.role !== 'admin') throw new Error(ADMIN_ERRORS.forbidden);
      return auth.listAccounts();
    },
    updateAccount: async (accountId, change): Promise<AccountListOutcome> => auth.updateAccount(accountId, change),
    ...publicBook,
    async listTasks() {
      if (!bus.listReachable()) throw new ServiceUnavailableError(SERVICE_UNAVAILABLE_MESSAGE);
      if (!auth.account()) throw new UnauthenticatedError();
      return listNow();
    },
    // 作废：服务端按任务列表同一个判定（已开始写入报销系统的不能作废）再核一次。
    async abandonTask(taskId) {
      if (!auth.account()) return signedOut();
      const snapshot = bus.all().find((candidate) => candidate.task.taskId === taskId && !hidden.has(taskId) && ownedByCurrent(taskId));
      if (!snapshot) return listResult({ code: 'task_not_found', message: ABANDON_TASK_COPY.notFound });
      const item = toListItem(snapshot);
      if (!item.abandonable) return listResult({ code: 'not_abandonable', message: item.abandonBlockedReason ?? ABANDON_TASK_COPY.blockedReason });
      hidden.add(taskId);
      return listResult(null);
    },
    // 完全重置：只清空当前账号的任务、项目簿与常驻城市；账号与登录状态保留。
    async resetAll() {
      if (!auth.account()) return signedOut();
      for (const snapshot of bus.all()) if (ownedByCurrent(snapshot.task.taskId)) hidden.add(snapshot.task.taskId);
      book.reset();
      auth.forgetCity();
      return listResult(null);
    },
    getProjectBook: book.getProjectBook,
    intakeProject: book.intakeProject,
    deactivateProject: book.deactivateProject,
    restoreProject: book.restoreProject,
    // 作废或重置掉的任务不再能打开（深链接也一样）：和不存在的任务同样报错。
    async getSnapshot(taskId) {
      if (hidden.has(taskId) || !ownedByCurrent(taskId)) throw new Error(`任务 ${taskId} 不存在`);
      return bus.draft(taskId);
    },
    subscribe: (taskId, onEvent) => bus.subscribe(taskId, onEvent),
    // 新建任务：服务端校验常驻城市，生成占位名称（`<创建日期> 新建报销`，费用期间为空），盘点结束后再按材料改名（见 flows/inventory.ts）。
    // 这次确认的常驻城市成为任务的城市快照，并记为这个账号的常驻城市（之后的默认值 source = remembered，刷新后仍在）。
    // 没登录时拒绝。
    async createTask(input) {
      const account = auth.account();
      if (!account) return bus.fail(UNAUTHENTICATED_CODE, AUTH_ERRORS.unauthenticated);
      const parsed = CreateTaskInputSchema.safeParse(input);
      if (!parsed.success) return bus.fail('invalid_home_city', CREATE_TASK_ERRORS.homeCityRequired);
      const homeCity = parsed.data.homeCity;
      const taskId = `T${nextTaskNo}`;
      nextTaskNo += 1;
      const at = bus.now();
      owners.set(taskId, account.accountId);
      auth.rememberCity(homeCity);
      bus.autoNamed.add(taskId);
      return bus.commit(emptySnapshot({ taskId, name: `${at.slice(0, 10)} 新建报销`, period: null, homeCity, createdAt: at, updatedAt: at }, 'upload'));
    },
    uploadBatch: inventory.uploadBatch,
    startInventory: inventory.startInventory,
    reopenUpload: inventory.reopenUpload,
    answerPendingItem: pending.answerPendingItem,
    confirmReview: pending.confirmReview,
    assignProjectLines: project.assignProjectLines,
    submitProjectAssignment: project.submitProjectAssignment,
    // 排除材料按当前处境分派（见 EXCLUDE_MATERIAL_ERRORS 的三种情形）：重复发票、认不出的合并发票、材料包缺项。
    async excludeMaterial(taskId, materialId, stepToken) {
      const current = bus.draft(taskId);
      if (current.blockers.some((blocker) => blocker.materialId === materialId)) return inventory.excludeDuplicate(taskId, materialId, stepToken);
      if (current.pendingItems.some((item) => item.kind === 'given_up' && item.status === 'open' && item.materialId === materialId)) {
        return pending.excludeGivenUp(taskId, materialId, stepToken);
      }
      return project.excludeMaterial(taskId, materialId, stepToken);
    },
    // 修改当前任务的常驻城市：ERP 写入开始前可改，并记为这个账号的常驻城市（mock 不重新推导类别）。
    async setTaskHomeCity(taskId, homeCity, stepToken) {
      const value = homeCity.trim();
      return bus.withStep(taskId, stepToken, (snapshot) => {
        if (value.length === 0 || value.length > 20) return { error: { code: 'invalid_home_city', message: HOME_CITY_ERRORS.invalid } };
        if (snapshot.erp.status !== 'idle') return { error: { code: 'home_city_locked', message: HOME_CITY_ERRORS.locked } };
        auth.rememberCity(value);
        return {
          ...snapshot,
          task: { ...snapshot.task, homeCity: value },
          projectAssignment: { ...snapshot.projectAssignment, homeCity: value },
          step: { ...snapshot.step, stepToken: bus.rotateToken(snapshot.step.stepToken) },
        };
      });
    },
    ...createLegacyImportFlow(options),
    ...createPrintFlow(bus),
    ...createErpFlow(bus),
  };

  // 断开期间动作不送达：统一包一层，失败原因由页面就地显示。
  const guarded: Record<string, unknown> = { ...adapter };
  for (const key of Object.keys(adapter) as (keyof AppAdapter)[]) {
    if (READ_METHODS.has(key)) continue;
    const original = adapter[key] as unknown as (...args: unknown[]) => Promise<ActionOutcome | TaskListOutcome | ProjectBookOutcome | AuthOutcome | AccountListOutcome | LegacyImportOutcome>;
    const unavailable = { code: SERVICE_UNAVAILABLE_CODE, message: SERVICE_UNAVAILABLE_MESSAGE };
    const down = (): ActionOutcome | TaskListOutcome | ProjectBookOutcome | AuthOutcome | AccountListOutcome | LegacyImportOutcome =>
      ACCOUNT_METHODS.has(key)
        ? { ok: false, error: unavailable, accountList: null }
        : LEGACY_METHODS.has(key)
        ? { ok: false, error: unavailable, legacyImport: null }
        : LIST_METHODS.has(key)
        ? { ok: false, error: unavailable, taskList: null }
        : AUTH_METHODS.has(key)
          ? { ok: false, error: unavailable }
          : BOOK_METHODS.has(key)
          ? { ok: false, error: unavailable, book: null }
          : bus.fail(SERVICE_UNAVAILABLE_CODE, SERVICE_UNAVAILABLE_MESSAGE);
    guarded[key] = async (...args: unknown[]) => (bus.isConnected() ? original(...args) : down());
  }
  return Object.assign(guarded as unknown as AppAdapter, { advanceElsewhere: pending.advanceElsewhere });
}

export const MOCK_MAIN_TASK_ID = T1_ID;
