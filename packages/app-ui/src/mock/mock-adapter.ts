import { ServiceUnavailableError, type ActionOutcome, type AppAdapter, type ProjectBookOutcome, type StartupOutcome } from '../contract/adapter';
import { CREATE_TASK_ERRORS, ConfirmIdentityInputSchema, CreateTaskInputSchema, STARTUP_ERRORS, type ActionError } from '../contract/actions';
import { TaskListSchema, type TaskList } from '../contract/task-list';
import { SERVICE_UNAVAILABLE_CODE, SERVICE_UNAVAILABLE_MESSAGE, createBus } from './bus';
import { buildPrintSheet } from './fixtures/print';
import { HOME_CITY } from './fixtures/projects';
import { T1_ID, emptySnapshot, t1Snapshot, t2Snapshot, t3Snapshot, toListItem } from './fixtures/tasks';
import { createProjectBook } from './project-book';
import { createStartup } from './startup';
import { createErpFlow } from './flows/erp';
import { createInventoryFlow } from './flows/inventory';
import { createPendingFlow } from './flows/pending';
import { createPrintFlow } from './flows/print';
import { createProjectFlow } from './flows/project';
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
const READ_METHODS: ReadonlySet<keyof AppAdapter> = new Set<keyof AppAdapter>(['listTasks', 'getSnapshot', 'subscribe', 'getProjectBook']);
// 启动动作的失败形状带 taskList 而不是 snapshot；项目簿维护动作带 book。
const STARTUP_METHODS: ReadonlySet<keyof AppAdapter> = new Set<keyof AppAdapter>(['recheckErpSession', 'confirmIdentity']);
const BOOK_METHODS: ReadonlySet<keyof AppAdapter> = new Set<keyof AppAdapter>(['intakeProject', 'removeProject', 'purgeInvalidProjects', 'recheckProjects']);

export function createMockAdapter(options: MockOptions): MockAdapter {
  const bus = createBus(options);
  let nextTaskNo = 4;

  const seeded = t1Snapshot(options.seed ?? 'upload', options.fault === 'unsupported-material');
  if (options.printSheet) seeded.printSheet = buildPrintSheet(seeded);
  bus.put(seeded);
  bus.put(t2Snapshot());
  bus.put(t3Snapshot());

  const startup = createStartup(options);
  // 个人项目簿：任务进入项目归属时的允许列表跟随它；夹具 T1 按当前项目簿整理（`?book=empty` 下先走维护门）。
  const book = createProjectBook(options, bus, startup);
  bus.useProjectAllowList(book.allowList);
  book.prepareSeed(T1_ID);

  const pending = createPendingFlow(bus);
  const project = createProjectFlow(bus);
  // `?seed=catalog` / `?seed=preparation`：自动步骤接着走完，进入整单确认。
  project.resumeAutoSteps(T1_ID);
  const listNow = (): TaskList => {
    const tasks = bus
      .all()
      .map(toListItem)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return TaskListSchema.parse({ erpSession: startup.erpSession(), employee: startup.employee(), homeCity: homeCityDefault(), tasks });
  };
  const startupResult = (error: ActionError | null): StartupOutcome => (error ? { ok: false, error, taskList: listNow() } : { ok: true, taskList: listNow() });

  // 常驻城市默认值：这个身份确认过就用记住的城市（持久存储，按 tenant + account 分键，刷新后仍在）；
  // 否则用 mock 位置 Adapter 的城市级网络位置（夹具员工在杭州）；`?location=unavailable` 下位置获取失败，又没有记忆，默认值为 null。
  const homeCityDefault = (): TaskList['homeCity'] => {
    const rememberedCity = startup.rememberedCity();
    if (rememberedCity) return { value: rememberedCity, source: 'remembered' };
    if (options.locationUnavailable) return null;
    return { value: HOME_CITY, source: 'network' };
  };

  const adapter: AppAdapter = {
    async listTasks() {
      if (!bus.listReachable()) throw new ServiceUnavailableError(SERVICE_UNAVAILABLE_MESSAGE);
      return listNow();
    },
    recheckErpSession: async () => startupResult(startup.recheckErpSession()),
    async confirmIdentity(input) {
      const parsed = ConfirmIdentityInputSchema.safeParse(input);
      if (!parsed.success) return startupResult({ code: 'identity_changed', message: STARTUP_ERRORS.identityChanged });
      return startupResult(startup.confirmIdentity(parsed.data));
    },
    getProjectBook: book.getProjectBook,
    intakeProject: book.intakeProject,
    removeProject: book.removeProject,
    purgeInvalidProjects: book.purgeInvalidProjects,
    recheckProjects: book.recheckProjects,
    getSnapshot: async (taskId) => bus.draft(taskId),
    subscribe: (taskId, onEvent) => bus.subscribe(taskId, onEvent),
    // 新建任务：服务端校验常驻城市，生成占位名称（`<创建日期> 新建报销`，费用期间为空），盘点结束后再按材料改名（见 flows/inventory.ts）。
    // 这次确认的常驻城市成为任务的城市快照，并按身份记为员工的常驻城市（之后的默认值 source = remembered，刷新后仍在）。
    // 启动没完成（未登录或身份未登记 / 不一致）时拒绝。
    async createTask(input) {
      if (!startup.complete()) return bus.fail('startup_incomplete', CREATE_TASK_ERRORS.startupIncomplete);
      const parsed = CreateTaskInputSchema.safeParse(input);
      if (!parsed.success) return bus.fail('invalid_home_city', CREATE_TASK_ERRORS.homeCityRequired);
      const homeCity = parsed.data.homeCity;
      const taskId = `T${nextTaskNo}`;
      nextTaskNo += 1;
      const at = bus.now();
      startup.rememberCity(homeCity);
      bus.autoNamed.add(taskId);
      return bus.commit(emptySnapshot({ taskId, name: `${at.slice(0, 10)} 新建报销`, period: null, homeCity, createdAt: at, updatedAt: at }, 'upload'));
    },
    ...createInventoryFlow(bus),
    answerPendingItem: pending.answerPendingItem,
    confirmReview: pending.confirmReview,
    submitProjectAssignment: project.submitProjectAssignment,
    excludeMaterial: project.excludeMaterial,
    ...createPrintFlow(bus),
    ...createErpFlow(bus),
  };

  // 断开期间动作不送达：统一包一层，失败原因由页面就地显示。
  const guarded: Record<string, unknown> = { ...adapter };
  for (const key of Object.keys(adapter) as (keyof AppAdapter)[]) {
    if (READ_METHODS.has(key)) continue;
    const original = adapter[key] as unknown as (...args: unknown[]) => Promise<ActionOutcome | StartupOutcome | ProjectBookOutcome>;
    const unavailable = { code: SERVICE_UNAVAILABLE_CODE, message: SERVICE_UNAVAILABLE_MESSAGE };
    const down = (): ActionOutcome | StartupOutcome | ProjectBookOutcome =>
      STARTUP_METHODS.has(key)
        ? { ok: false, error: unavailable, taskList: null }
        : BOOK_METHODS.has(key)
          ? { ok: false, error: unavailable, book: null }
          : bus.fail(SERVICE_UNAVAILABLE_CODE, SERVICE_UNAVAILABLE_MESSAGE);
    guarded[key] = async (...args: unknown[]) => (bus.isConnected() ? original(...args) : down());
  }
  return Object.assign(guarded as unknown as AppAdapter, { advanceElsewhere: pending.advanceElsewhere });
}

export const MOCK_MAIN_TASK_ID = T1_ID;
