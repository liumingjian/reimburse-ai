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
  previewProjectImport: { method: 'POST', path: '/api/:book/import/preview', body: 'multipart', fields: ['file', 'sheet'] },
  commitProjectImport: { method: 'POST', path: '/api/:book/import/commit', body: 'json', fields: ['previewId', 'rows'] },
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
  // Personal project books (个人项目簿) do not belong to a task: GET returns ProjectBook, and an offline maintenance
  // request returns ProjectBookResult. A request-level failure returns { error, book? }.
  getProjectBook: { method: 'GET', path: '/api/project-book', body: 'none', fields: [] },
  intakeProject: { method: 'POST', path: '/api/project-book/intake', body: 'json', fields: ['number', 'name'] },
  editProject: { method: 'POST', path: '/api/project-book/edit', body: 'json', fields: ['originalNumber', 'number', 'name'] },
  deactivateProject: { method: 'POST', path: '/api/project-book/deactivate', body: 'json', fields: ['number'] },
  restoreProject: { method: 'POST', path: '/api/project-book/restore', body: 'json', fields: ['number'] },
  deleteProject: { method: 'POST', path: '/api/project-book/delete', body: 'json', fields: ['number'] },
  // 改密码需要会话；带临时密码的会话只能调用它（其余端点 403 password_change_required）。成功 200 返回 Session。
  changePassword: { method: 'POST', path: '/api/auth/change-password', body: 'json', fields: ['currentPassword', 'newPassword'] },
  // 账号管理（只对管理员，其他账号 403 forbidden）：GET 返回 AccountList；更新一次只带一项（role / active / temporaryPassword），
  // 成功 200 返回新的 AccountList，失败 { error, accounts? }。`:id` 是账号 id。
  listAccounts: { method: 'GET', path: '/api/admin/accounts', body: 'none', fields: [] },
  updateAccount: { method: 'POST', path: '/api/admin/accounts/:id', body: 'json', fields: ['role', 'active', 'approved', 'temporaryPassword'] },
  // The public project book (公共项目簿) is readable by every account; offline maintenance is administrator-only
  // (403 forbidden { error, book }) and has the same result shape as a personal project book.
  getPublicProjectBook: { method: 'GET', path: '/api/public-project-book', body: 'none', fields: [] },
  intakePublicProject: { method: 'POST', path: '/api/public-project-book/intake', body: 'json', fields: ['number', 'name'] },
  editPublicProject: { method: 'POST', path: '/api/public-project-book/edit', body: 'json', fields: ['originalNumber', 'number', 'name'] },
  confirmPublicProjectConversion: { method: 'POST', path: '/api/public-project-book/convert', body: 'json', fields: ['operation', 'originalNumber', 'originalName', 'originalActive', 'number', 'name'] },
  deactivatePublicProject: { method: 'POST', path: '/api/public-project-book/deactivate', body: 'json', fields: ['number'] },
  restorePublicProject: { method: 'POST', path: '/api/public-project-book/restore', body: 'json', fields: ['number'] },
  deletePublicProject: { method: 'POST', path: '/api/public-project-book/delete', body: 'json', fields: ['number'] },
  // 旧数据导入：GET 返回这个账号看到的导入结果；只有拥有失败那次导入的账号能重试或跳过（其余 400 import_not_pending）。
  getLegacyImport: { method: 'GET', path: '/api/legacy-import', body: 'none', fields: [] },
  retryLegacyImport: { method: 'POST', path: '/api/legacy-import/retry', body: 'json', fields: [] },
  skipLegacyImport: { method: 'POST', path: '/api/legacy-import/skip', body: 'json', fields: [] },
  // 配对 (pairing, ADR-0019): GET answers this account's pairing; issuing a 配对码 (pairing code)
  // answers the pairing with that code in it (this once only) and voids the old pairing at once; revoking answers
  // the unpaired pairing. Failures are { error }. The 本地执行器's own endpoints (PAIRING_PATH) are not in this
  // table: they carry no session and no page sends them.
  getPairing: { method: 'GET', path: '/api/pairing', body: 'none', fields: [] },
  createPairingCode: { method: 'POST', path: '/api/pairing/code', body: 'json', fields: ['system'] },
  revokePairing: { method: 'POST', path: '/api/pairing/revoke', body: 'json', fields: [] },
  // ERP 凭据 (ADR-0033): every answer is the ErpCredentialsView, never the password. Saving and 试登录 wait for the
  // 试登录 (up to about five minutes); one that ran and failed is in the view, not an { error }.
  getErpCredentials: { method: 'GET', path: '/api/erp-credentials', body: 'none', fields: [] },
  getErpBrowserSettings: { method: 'GET', path: '/api/erp-browser-settings', body: 'none', fields: [] },
  saveErpBrowserSettings: { method: 'POST', path: '/api/erp-browser-settings', body: 'json', fields: ['browserMode'] },
  saveErpCredentials: { method: 'POST', path: '/api/erp-credentials', body: 'json', fields: ['account', 'password'] },
  testErpCredentials: { method: 'POST', path: '/api/erp-credentials/test', body: 'json', fields: [] },
  clearErpCredentials: { method: 'POST', path: '/api/erp-credentials/clear', body: 'json', fields: [] },
  getSnapshot: { method: 'GET', path: '/api/tasks/:id', body: 'none', fields: [] },
  subscribe: { method: 'GET', path: '/api/tasks/:id/events', body: 'sse', fields: [] },
  createTask: { method: 'POST', path: '/api/tasks', body: 'json', fields: ['homeCity'] },
  uploadBatch: { method: 'POST', path: '/api/tasks/:id/batches', body: 'multipart', fields: ['files', 'sourcePaths'] },
  addPaymentScreenshots: { method: 'POST', path: '/api/tasks/:id/payment-screenshots', body: 'multipart', fields: ['voucherMaterialId', 'files', 'stepToken'] },
  supplementDiningEvidence: { method: 'POST', path: '/api/tasks/:id/dining-evidence', body: 'multipart', fields: ['pendingItemId', 'files', 'stepToken'] },
  startInventory: action('start-inventory', 'stepToken'),
  answerPendingItem: action('answer-pending', 'itemId', 'answer', 'stepToken'),
  confirmReview: action('confirm-review', 'digest', 'acceptDeadlineWarnings', 'stepToken'),
  reopenUpload: action('reopen-upload', 'stepToken'),
  removePaymentScreenshot: action('remove-payment-screenshot', 'screenshotId'),
  completePaymentScreenshots: action('complete-payment-screenshots', 'voucherMaterialId'),
  generateReimbursementSummary: action('generate-reimbursement-summary'),
  generatePrintSheet: action('generate-print-sheet'),
  rotatePlacement: action('rotate-placement', 'pageId', 'slot', 'rotate'),
  cropPlacement: action('crop-placement', 'pageId', 'slot', 'corners'),
  assignProjectLines: action('assign-project-lines', 'lineIds', 'projectNumber', 'onlyUnassigned', 'stepToken'),
  submitProjectAssignment: action('submit-project-assignment', 'purpose', 'projects', 'acceptDeadlineWarnings', 'stepToken'),
  excludeMaterial: action('exclude-material', 'materialId', 'stepToken'),
  setTaskHomeCity: action('set-home-city', 'homeCity', 'stepToken'),
  startErpWrite: action('start-erp-write', 'stepToken'),
  reconcile: action('reconcile', 'stepToken'),
  handOff: action('hand-off', 'stepToken'),
  refill: action('refill', 'stepToken'),
} as const satisfies Record<keyof AppAdapter, HttpEndpoint>;

// 端点表里出现的动作名（用于核对与 ACTION_NAMES 同步）。
export function endpointActionNames(): string[] {
  return Object.values(HTTP_ENDPOINTS)
    .map((endpoint) => endpoint.path)
    .filter((path) => path.startsWith(ACTION_PATH_PREFIX))
    .map((path) => path.slice(ACTION_PATH_PREFIX.length));
}
