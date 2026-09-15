import type { ActionName } from './actions';
import type { AppAdapter } from './adapter';

// 接口的 HTTP 形态：给服务端实现者的端点表，HTTP 适配器按同一张表发请求。
// 成功 200 返回整份新快照；失败返回 { error: { code, message } }；stepToken 过期返回 409 与 { error, snapshot }（最新快照）。
// 事件流是 SSE：`event: snapshot`，`data:` 为整份快照 JSON；断开后客户端按退避自动重连，重连成功后重新拉取快照。

export const STALE_STEP_HTTP_STATUS = 409;
export const SNAPSHOT_EVENT = 'snapshot';
export const ACTION_PATH_PREFIX = '/api/tasks/:id/actions/';

export type HttpEndpoint = {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  // 请求体：none / json（字段列在 fields）/ multipart（表单字段列在 fields）/ sse（事件流，GET）
  readonly body: 'none' | 'json' | 'multipart' | 'sse';
  readonly fields: readonly string[];
};

export function actionPath(name: ActionName): string {
  return `${ACTION_PATH_PREFIX}${name}`;
}

const action = (name: ActionName, ...fields: string[]): HttpEndpoint => ({ method: 'POST', path: actionPath(name), body: 'json', fields });

// 每个适配器方法对应的端点；`satisfies` 保证适配器接口加了方法这里必须跟着加。
export const HTTP_ENDPOINTS = {
  // 应用账号：不需要会话；成功 200 返回 Session，失败 { error }。会话是 HttpOnly Cookie，页面读不到也不用管。
  // 其余端点没有有效会话一律 401 { error: { code: 'unauthenticated' } }。
  getSession: { method: 'GET', path: '/api/session', body: 'none', fields: [] },
  setupAdmin: { method: 'POST', path: '/api/auth/setup', body: 'json', fields: ['username', 'password'] },
  register: { method: 'POST', path: '/api/auth/register', body: 'json', fields: ['username', 'password'] },
  login: { method: 'POST', path: '/api/auth/login', body: 'json', fields: ['username', 'password'] },
  logout: { method: 'POST', path: '/api/auth/logout', body: 'json', fields: [] },
  listTasks: { method: 'GET', path: '/api/tasks', body: 'none', fields: [] },
  // 作废任务与完全重置也返回整份任务列表（失败 { error, taskList? }），不是任务动作，不带 stepToken。
  abandonTask: { method: 'POST', path: '/api/tasks/:id/abandon', body: 'json', fields: [] },
  resetAll: { method: 'POST', path: '/api/reset', body: 'json', fields: [] },
  // 个人项目簿不属于任何任务：GET 返回 ProjectBook；维护动作处理了就 200 返回 ProjectBookResult（含没做成的状态与原因），
  // 请求本身失败 { error, book? }。
  getProjectBook: { method: 'GET', path: '/api/project-book', body: 'none', fields: [] },
  intakeProject: { method: 'POST', path: '/api/project-book/intake', body: 'json', fields: ['number'] },
  removeProject: { method: 'POST', path: '/api/project-book/remove', body: 'json', fields: ['number'] },
  purgeInvalidProjects: { method: 'POST', path: '/api/project-book/purge', body: 'json', fields: [] },
  recheckProjects: { method: 'POST', path: '/api/project-book/recheck', body: 'json', fields: [] },
  // 改密码需要会话；带临时密码的会话只能调用它（其余端点 403 password_change_required）。成功 200 返回 Session。
  changePassword: { method: 'POST', path: '/api/auth/change-password', body: 'json', fields: ['currentPassword', 'newPassword'] },
  // 账号管理（只对管理员，其他账号 403 forbidden）：GET 返回 AccountList；更新一次只带一项（role / active / temporaryPassword），
  // 成功 200 返回新的 AccountList，失败 { error, accounts? }。`:id` 是账号 id。
  listAccounts: { method: 'GET', path: '/api/admin/accounts', body: 'none', fields: [] },
  updateAccount: { method: 'POST', path: '/api/admin/accounts/:id', body: 'json', fields: ['role', 'active', 'temporaryPassword'] },
  // 公共项目簿：GET 所有账号可读；维护动作只对管理员（403 forbidden { error, book }），结果形状同个人项目簿。删除即停用。
  getPublicProjectBook: { method: 'GET', path: '/api/public-project-book', body: 'none', fields: [] },
  intakePublicProject: { method: 'POST', path: '/api/public-project-book/intake', body: 'json', fields: ['number'] },
  removePublicProject: { method: 'POST', path: '/api/public-project-book/remove', body: 'json', fields: ['number'] },
  recheckPublicProjects: { method: 'POST', path: '/api/public-project-book/recheck', body: 'json', fields: [] },
  getSnapshot: { method: 'GET', path: '/api/tasks/:id', body: 'none', fields: [] },
  subscribe: { method: 'GET', path: '/api/tasks/:id/events', body: 'sse', fields: [] },
  createTask: { method: 'POST', path: '/api/tasks', body: 'json', fields: ['homeCity'] },
  uploadBatch: { method: 'POST', path: '/api/tasks/:id/batches', body: 'multipart', fields: ['files'] },
  addPaymentScreenshot: { method: 'POST', path: '/api/tasks/:id/payment-screenshots', body: 'multipart', fields: ['voucherMaterialId', 'file'] },
  startInventory: action('start-inventory', 'stepToken'),
  answerPendingItem: action('answer-pending', 'itemId', 'answer', 'stepToken'),
  confirmReview: action('confirm-review', 'digest', 'stepToken'),
  reopenUpload: action('reopen-upload', 'stepToken'),
  removePaymentScreenshot: action('remove-payment-screenshot', 'screenshotId'),
  generatePrintSheet: action('generate-print-sheet'),
  rotatePlacement: action('rotate-placement', 'pageId', 'slot', 'rotate'),
  cropPlacement: action('crop-placement', 'pageId', 'slot', 'corners'),
  assignProjectLines: action('assign-project-lines', 'lineIds', 'projectNumber', 'onlyUnassigned', 'stepToken'),
  submitProjectAssignment: action('submit-project-assignment', 'purpose', 'projects', 'stepToken'),
  excludeMaterial: action('exclude-material', 'materialId', 'stepToken'),
  setTaskHomeCity: action('set-home-city', 'homeCity', 'stepToken'),
  startErpWrite: action('start-erp-write', 'stepToken'),
  confirmLogin: action('confirm-login', 'stepToken'),
  reconcile: action('reconcile', 'stepToken'),
  handOff: action('hand-off', 'stepToken'),
} as const satisfies Record<keyof AppAdapter, HttpEndpoint>;

// 端点表里出现的动作名（用于核对与 ACTION_NAMES 同步）。
export function endpointActionNames(): string[] {
  return Object.values(HTTP_ENDPOINTS)
    .map((endpoint) => endpoint.path)
    .filter((path) => path.startsWith(ACTION_PATH_PREFIX))
    .map((path) => path.slice(ACTION_PATH_PREFIX.length));
}
