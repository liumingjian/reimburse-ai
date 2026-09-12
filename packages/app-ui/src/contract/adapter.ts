import type { ActionError, ConfirmIdentityInput, CreateTaskInput, PendingAnswer, PlacementSlot, ProjectAssignmentInput } from './actions';
import type { Corners, TaskSnapshot } from './snapshot';
import type { TaskList } from './task-list';

// 启动动作的结果：成功返回新任务列表；失败时 taskList 是服务端附带的最新列表（可能为 null）。
export type StartupOutcome =
  | { ok: true; taskList: TaskList }
  | { ok: false; error: ActionError; taskList: TaskList | null };

// 适配器接口：前端与服务端交互的唯一缝。四类接口：任务列表、任务快照、动作端点、事件流。
// mock 适配器在浏览器内实现同一接口；HTTP 适配器按契约调用本地应用服务。

export type ActionOutcome =
  | { ok: true; snapshot: TaskSnapshot }
  | { ok: false; error: ActionError; snapshot: TaskSnapshot | null };

export type ConnectionState = 'connected' | 'disconnected';

// 接口四：SSE 事件流。服务端每次状态变化推送整份新快照；连接状态变化用于全页横幅与自动重连。
export type AdapterEvent =
  | { type: 'snapshot'; snapshot: TaskSnapshot }
  | { type: 'connection'; state: ConnectionState };

export type Unsubscribe = () => void;

// 连接类失败：本地服务没有响应（请求根本没送达）。适配器读任务列表遇到它时抛出这个错误，
// 仓库据此显示与事件流断开相同的全页横幅，并按退避自动重试；其余错误照常显示为加载失败。
export class ServiceUnavailableError extends Error {
  constructor(message = '本地服务没有响应') {
    super(message);
    this.name = 'ServiceUnavailableError';
  }
}

export function isServiceUnavailable(error: unknown): boolean {
  return error instanceof Error && error.name === 'ServiceUnavailableError';
}

export interface AppAdapter {
  listTasks(): Promise<TaskList>;
  // 启动：「我已登录」只是请服务端再探测一次报销系统登录，页面从不断言登录已发生。
  recheckErpSession(): Promise<StartupOutcome>;
  // 启动：登记当前登录身份（只能确认，不能改）。
  confirmIdentity(input: ConfirmIdentityInput): Promise<StartupOutcome>;
  getSnapshot(taskId: string): Promise<TaskSnapshot>;
  subscribe(taskId: string, onEvent: (event: AdapterEvent) => void): Unsubscribe;

  createTask(input: CreateTaskInput): Promise<ActionOutcome>;
  uploadBatch(taskId: string, files: readonly File[]): Promise<ActionOutcome>;
  startInventory(taskId: string, stepToken: string): Promise<ActionOutcome>;
  answerPendingItem(taskId: string, itemId: string, answer: PendingAnswer, stepToken: string): Promise<ActionOutcome>;
  confirmReview(taskId: string, digest: string, stepToken: string): Promise<ActionOutcome>;
  // 确认后追加材料：先经页面二次确认，再请服务端使整单明细确认失效并回到上传阶段。
  reopenUpload(taskId: string, stepToken: string): Promise<ActionOutcome>;
  // 支付截图只进打印稿，不带 stepToken、不改变确认状态。
  addPaymentScreenshot(taskId: string, voucherMaterialId: string, file: File): Promise<ActionOutcome>;
  removePaymentScreenshot(taskId: string, screenshotId: string): Promise<ActionOutcome>;
  generatePrintSheet(taskId: string): Promise<ActionOutcome>;
  rotatePlacement(taskId: string, pageId: string, slot: PlacementSlot, rotate: boolean): Promise<ActionOutcome>;
  cropPlacement(taskId: string, pageId: string, slot: PlacementSlot, corners: Corners): Promise<ActionOutcome>;
  submitProjectAssignment(taskId: string, input: ProjectAssignmentInput, stepToken: string): Promise<ActionOutcome>;
  startErpWrite(taskId: string, stepToken: string): Promise<ActionOutcome>;
  // 「我已登录，继续」只是请服务端再探测一次，页面从不断言登录已发生。
  confirmLogin(taskId: string, stepToken: string): Promise<ActionOutcome>;
  // 重新对账：只读 ERP 再判定一次，不发起任何写入。转人工：终止后续 ERP 写入，交给用户接管。两者都回传当前对账 step 的 stepToken。
  reconcile(taskId: string, stepToken: string): Promise<ActionOutcome>;
  handOff(taskId: string, stepToken: string): Promise<ActionOutcome>;
}
