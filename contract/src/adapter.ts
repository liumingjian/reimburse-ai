import type { ActionError, AssignProjectLinesInput, ConfirmIdentityInput, CreateTaskInput, PlacementSlot, ProjectAssignmentInput } from './actions';
import type { ProjectBook, ProjectBookResult } from './project-book';
import type { Corners, PendingAnswer, TaskSnapshot } from './snapshot';
import type { TaskList } from './task-list';

// 启动动作的结果：成功返回新任务列表；失败时 taskList 是服务端附带的最新列表（可能为 null）。
export type StartupOutcome =
  | { ok: true; taskList: TaskList }
  | { ok: false; error: ActionError; taskList: TaskList | null };

// 任务之外、返回整份任务列表的动作（启动、作废任务、完全重置）共用这个结果形状。
export type TaskListOutcome = StartupOutcome;

// 个人项目簿维护动作的结果：服务端处理了请求就是 ok（结果状态可能是 rejected 等没做成的，原因在 result.note）；
// 请求本身失败（服务没响应、格式不符）才是 !ok，book 是服务端附带的最新项目簿（可能为 null）。
export type ProjectBookOutcome =
  | { ok: true; result: ProjectBookResult }
  | { ok: false; error: ActionError; book: ProjectBook | null };

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
  // 作废任务：服务端判定能否作废（已开始写入报销系统的不能），成功返回不再含这个任务的任务列表。
  abandonTask(taskId: string): Promise<TaskListOutcome>;
  // 完全重置：清空本机数据（任务、项目簿、身份登记、常驻城市），返回重置后的任务列表（未登录，页面回到启动页）。
  resetAll(): Promise<TaskListOutcome>;
  // 个人项目簿（任务之外，按当前登录身份分簿）：读取、录入（只给项目号，服务端核验后带回名称）、删除、清理全部失效、复检全部。
  // 每个动作服务端都重新核对当前登录身份；动作后受影响任务的项目允许列表随事件流更新。
  getProjectBook(): Promise<ProjectBook>;
  intakeProject(number: string): Promise<ProjectBookOutcome>;
  removeProject(number: string): Promise<ProjectBookOutcome>;
  purgeInvalidProjects(): Promise<ProjectBookOutcome>;
  recheckProjects(): Promise<ProjectBookOutcome>;
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
  // 「归入」：只改本次正在编辑的归属（projectAssignment.working），服务端随之给出「本次已归入」的条数与金额；不是提交。
  assignProjectLines(taskId: string, input: AssignProjectLinesInput, stepToken: string): Promise<ActionOutcome>;
  submitProjectAssignment(taskId: string, input: ProjectAssignmentInput, stepToken: string): Promise<ActionOutcome>;
  // 材料包有缺项（step resolve_preparation）时排除相关材料；服务端随后重新准备材料包。
  excludeMaterial(taskId: string, materialId: string, stepToken: string): Promise<ActionOutcome>;
  startErpWrite(taskId: string, stepToken: string): Promise<ActionOutcome>;
  // 「我已登录，继续」只是请服务端再探测一次，页面从不断言登录已发生。
  confirmLogin(taskId: string, stepToken: string): Promise<ActionOutcome>;
  // 重新对账：只读 ERP 再判定一次，不发起任何写入。转人工：终止后续 ERP 写入，交给用户接管。两者都回传当前对账 step 的 stepToken。
  reconcile(taskId: string, stepToken: string): Promise<ActionOutcome>;
  handOff(taskId: string, stepToken: string): Promise<ActionOutcome>;
}
