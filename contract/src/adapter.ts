import type { ActionError, AssignProjectLinesInput, CreateTaskInput, PlacementSlot, ProjectAssignmentInput } from './actions';
import type { AccountList, AccountListOutcome, AccountUpdateInput, AuthOutcome, ChangePasswordInput, CredentialsInput, Session } from './auth';
import type { ExtensionPairing, ExtensionPairingOutcome } from './extension';
import type { LegacyImport, LegacyImportOutcome } from './legacy-import';
import type { ProjectBook, ProjectBookEditInput, ProjectBookIntakeInput, ProjectBookLifecycleInput, ProjectBookResult, PublicProjectConversionInput } from './project-book';
import type { Corners, PendingAnswer, TaskSnapshot } from './snapshot';
import type { TaskList } from './task-list';

// 任务之外、返回整份任务列表的动作（作废任务、完全重置）的结果：成功返回新任务列表；失败时 taskList 是服务端附带的最新列表（可能为 null）。
export type TaskListOutcome =
  | { ok: true; taskList: TaskList }
  | { ok: false; error: ActionError; taskList: TaskList | null };

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

// 登录失效：除账号接口外的请求没带有效会话（HTTP 401）。适配器读数据遇到它时抛出这个错误，仓库据此重读会话，页面回到登录。
export class UnauthenticatedError extends Error {
  constructor(message = '请先登录。') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

export function isUnauthenticated(error: unknown): boolean {
  return error instanceof Error && error.name === 'UnauthenticatedError';
}

export interface AppAdapter {
  // App accounts (应用账号, ADR-0018): the first account is an authorized administrator. Later registration
  // submits a pending application and returns a signed-out session; administrator approval is required for login.
  getSession(): Promise<Session>;
  setupAdmin(input: CredentialsInput): Promise<AuthOutcome>;
  register(input: CredentialsInput): Promise<AuthOutcome>;
  login(input: CredentialsInput): Promise<AuthOutcome>;
  logout(): Promise<AuthOutcome>;
  listTasks(): Promise<TaskList>;
  // 作废任务：服务端判定能否作废（已开始写入报销系统的不能），成功返回不再含这个任务的任务列表。
  abandonTask(taskId: string): Promise<TaskListOutcome>;
  // 完全重置：清空当前账号自己的数据（任务、项目簿、常驻城市），返回重置后的任务列表；别的账号与登录状态不变。
  resetAll(): Promise<TaskListOutcome>;
  // Personal project books (个人项目簿) are outside tasks and scoped to an app account. Members enter a number and
  // name explicitly; affected task options update through the event stream.
  getProjectBook(): Promise<ProjectBook>;
  intakeProject(input: ProjectBookIntakeInput): Promise<ProjectBookOutcome>;
  editProject(input: ProjectBookEditInput): Promise<ProjectBookOutcome>;
  deactivateProject(input: ProjectBookLifecycleInput): Promise<ProjectBookOutcome>;
  restoreProject(input: ProjectBookLifecycleInput): Promise<ProjectBookOutcome>;
  deleteProject(input: ProjectBookLifecycleInput): Promise<ProjectBookOutcome>;
  // 改密码（#194）：用临时密码登录后必须先改；成功返回新会话（signed_in）。
  changePassword(input: ChangePasswordInput): Promise<AuthOutcome>;
  // 管理员的账号管理：列出账号；设为管理员 / 取消管理员、停用 / 启用、设置临时密码，一次一项，成功返回新的账号列表。
  // 取消或停用最后一位在用的管理员会被拒绝（last_admin）。非管理员一律 403 forbidden。
  listAccounts(): Promise<AccountList>;
  updateAccount(accountId: string, change: AccountUpdateInput): Promise<AccountListOutcome>;
  // The public project book (公共项目簿) is readable by every account; only administrators may maintain it. Its
  // result shape matches a personal project book.
  getPublicProjectBook(): Promise<ProjectBook>;
  intakePublicProject(input: ProjectBookIntakeInput): Promise<ProjectBookOutcome>;
  editPublicProject(input: ProjectBookEditInput): Promise<ProjectBookOutcome>;
  confirmPublicProjectConversion(input: PublicProjectConversionInput): Promise<ProjectBookOutcome>;
  deactivatePublicProject(input: ProjectBookLifecycleInput): Promise<ProjectBookOutcome>;
  restorePublicProject(input: ProjectBookLifecycleInput): Promise<ProjectBookOutcome>;
  deletePublicProject(input: ProjectBookLifecycleInput): Promise<ProjectBookOutcome>;
  // 旧数据导入（ADR-0018，只在创建第一个管理员时跑一次）：读这个账号看到的导入结果；旧数据损坏时报告里有逐个文件的原因，
  // 由这个账号修好后重试，或明确跳过。跳过之后导入就此结束。
  getLegacyImport(): Promise<LegacyImport>;
  retryLegacyImport(): Promise<LegacyImportOutcome>;
  skipLegacyImport(): Promise<LegacyImportOutcome>;
  // 扩展配对（ADR-0019）：读这个账号的配对情况；生成配对码（同时让原来的配对失效）；撤销配对。
  // 配对与登录互不影响：撤销配对不会退出登录，退出登录也不会解除配对。
  getExtensionPairing(): Promise<ExtensionPairing>;
  createExtensionPairingCode(): Promise<ExtensionPairingOutcome>;
  revokeExtensionPairing(): Promise<ExtensionPairingOutcome>;
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
  // 修改当前任务的常驻城市：第一次写入报销系统之前可改；服务端重新推导费用类别，并记为这个账号的常驻城市。
  setTaskHomeCity(taskId: string, homeCity: string, stepToken: string): Promise<ActionOutcome>;
  startErpWrite(taskId: string, stepToken: string): Promise<ActionOutcome>;
  // 「我已登录，继续」只是请服务端再探测一次，页面从不断言登录已发生。
  confirmLogin(taskId: string, stepToken: string): Promise<ActionOutcome>;
  // 登录等待时放弃这次去报销：什么都没有写入，任务回到「去打印 / 去报销」，之后可以再去报销。
  cancelErpWrite(taskId: string, stepToken: string): Promise<ActionOutcome>;
  // 重新对账：只读 ERP 再判定一次，不发起任何写入。转人工：终止后续 ERP 写入，交给用户接管。两者都回传当前对账 step 的 stepToken。
  reconcile(taskId: string, stepToken: string): Promise<ActionOutcome>;
  handOff(taskId: string, stepToken: string): Promise<ActionOutcome>;
  // 重新去报销：发票已导入、明细还没写、报销系统里还没有单据编号时的那条出路。重开一张单据，从头走一遍去报销。
  refill(taskId: string, stepToken: string): Promise<ActionOutcome>;
}
