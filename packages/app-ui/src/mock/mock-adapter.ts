import { ServiceUnavailableError, type ActionOutcome, type AppAdapter } from '../contract/adapter';
import { TaskListSchema } from '../contract/task-list';
import { SERVICE_UNAVAILABLE_CODE, SERVICE_UNAVAILABLE_MESSAGE, createBus } from './bus';
import { buildPrintSheet } from './fixtures/print';
import { EMPLOYEE, T1_ID, emptySnapshot, t1Snapshot, t2Snapshot, t3Snapshot, toListItem } from './fixtures/tasks';
import { createErpFlow } from './flows/erp';
import { createInventoryFlow } from './flows/inventory';
import { createPendingFlow } from './flows/pending';
import { createPrintFlow } from './flows/print';
import type { MockOptions } from './options';

export { SERVICE_UNAVAILABLE_CODE, SERVICE_UNAVAILABLE_MESSAGE } from './bus';
export { FAULTS, readMockOptions, type Fault, type MockOptions } from './options';

// 浏览器内 mock 适配器：实现与 HTTP 适配器相同的接口，用内存里的快照回答一切。只经 main.tsx 的动态 import 进入 mock 构建。
// 本文件只做组装：公共底座（快照仓库、事件总线、断连模拟）在 ./bus.ts，各业务流程在 ./flows/：
// inventory（上传批次、材料盘点、追加材料）、pending（待确认项、整单明细确认）、print（支付截图、打印稿）、erp（项目归属、ERP 填报、对账）。

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
const READ_METHODS: ReadonlySet<keyof AppAdapter> = new Set<keyof AppAdapter>(['listTasks', 'getSnapshot', 'subscribe']);

export function createMockAdapter(options: MockOptions): MockAdapter {
  const bus = createBus(options);
  let nextTaskNo = 4;

  const seeded = t1Snapshot(options.seed ?? 'upload', options.fault === 'unsupported-material');
  if (options.printSheet) seeded.printSheet = buildPrintSheet(seeded);
  bus.put(seeded);
  bus.put(t2Snapshot());
  bus.put(t3Snapshot());

  const pending = createPendingFlow(bus);

  const adapter: AppAdapter = {
    async listTasks() {
      if (!bus.listReachable()) throw new ServiceUnavailableError(SERVICE_UNAVAILABLE_MESSAGE);
      const tasks = bus
        .all()
        .map(toListItem)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      return TaskListSchema.parse({ employee: EMPLOYEE, tasks });
    },
    getSnapshot: async (taskId) => bus.draft(taskId),
    subscribe: (taskId, onEvent) => bus.subscribe(taskId, onEvent),
    async createTask(input) {
      const taskId = `T${nextTaskNo}`;
      nextTaskNo += 1;
      const period = input.periodStart && input.periodEnd ? { start: input.periodStart, end: input.periodEnd } : null;
      const at = bus.now();
      return bus.commit(emptySnapshot({ taskId, name: input.name.trim(), period, createdAt: at, updatedAt: at }, 'upload'));
    },
    ...createInventoryFlow(bus),
    answerPendingItem: pending.answerPendingItem,
    confirmReview: pending.confirmReview,
    ...createPrintFlow(bus),
    ...createErpFlow(bus),
  };

  // 断开期间动作不送达：统一包一层，失败原因由页面就地显示。
  const guarded: Record<string, unknown> = { ...adapter };
  for (const key of Object.keys(adapter) as (keyof AppAdapter)[]) {
    if (READ_METHODS.has(key)) continue;
    const original = adapter[key] as unknown as (...args: unknown[]) => Promise<ActionOutcome>;
    guarded[key] = async (...args: unknown[]): Promise<ActionOutcome> =>
      bus.isConnected() ? original(...args) : bus.fail(SERVICE_UNAVAILABLE_CODE, SERVICE_UNAVAILABLE_MESSAGE);
  }
  return Object.assign(guarded as unknown as AppAdapter, { advanceElsewhere: pending.advanceElsewhere });
}

export const MOCK_MAIN_TASK_ID = T1_ID;
