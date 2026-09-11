import type { ActionError, CreateTaskInput, PendingAnswer, PlacementSlot, ProjectAssignmentInput } from './actions';
import type { Corners, TaskSnapshot } from './snapshot';
import type { TaskList } from './task-list';

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

export interface AppAdapter {
  listTasks(): Promise<TaskList>;
  getSnapshot(taskId: string): Promise<TaskSnapshot>;
  subscribe(taskId: string, onEvent: (event: AdapterEvent) => void): Unsubscribe;

  createTask(input: CreateTaskInput): Promise<ActionOutcome>;
  uploadBatch(taskId: string, files: readonly File[]): Promise<ActionOutcome>;
  startInventory(taskId: string, stepToken: string): Promise<ActionOutcome>;
  answerPendingItem(taskId: string, itemId: string, answer: PendingAnswer, stepToken: string): Promise<ActionOutcome>;
  confirmReview(taskId: string, digest: string, stepToken: string): Promise<ActionOutcome>;
  addPaymentScreenshot(taskId: string, voucherMaterialId: string, file: File): Promise<ActionOutcome>;
  removePaymentScreenshot(taskId: string, screenshotId: string): Promise<ActionOutcome>;
  generatePrintSheet(taskId: string): Promise<ActionOutcome>;
  rotatePlacement(taskId: string, pageId: string, slot: PlacementSlot, rotate: boolean): Promise<ActionOutcome>;
  cropPlacement(taskId: string, pageId: string, slot: PlacementSlot, corners: Corners): Promise<ActionOutcome>;
  submitProjectAssignment(taskId: string, input: ProjectAssignmentInput, stepToken: string): Promise<ActionOutcome>;
  startErpWrite(taskId: string, stepToken: string): Promise<ActionOutcome>;
  // 「我已登录，继续」只是请服务端再探测一次，页面从不断言登录已发生。
  confirmLogin(taskId: string, stepToken: string): Promise<ActionOutcome>;
  reconcile(taskId: string): Promise<ActionOutcome>;
  handOff(taskId: string): Promise<ActionOutcome>;
}
