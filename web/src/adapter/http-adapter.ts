import {
  AccountListFailureSchema,
  AccountListSchema,
  type AccountList,
  type AccountListOutcome,
  ActionFailureSchema,
  AuthFailureSchema,
  ERP_IN_USE_CODE,
  STALE_STEP_CODE,
  STALE_STEP_NOTICE,
  SessionSchema,
  TaskListFailureSchema,
  ServiceUnavailableError,
  UNAUTHENTICATED_HTTP_STATUS,
  UnauthenticatedError,
  type ActionOutcome,
  type AdapterEvent,
  type AppAdapter,
  type AuthOutcome,
  type ProjectBookOutcome,
  type Session,
  type TaskListOutcome,
  type Unsubscribe,
  type UploadTransferProgress,
  HTTP_ENDPOINTS,
  SNAPSHOT_EVENT,
  STALE_STEP_HTTP_STATUS,
  PairingFailureSchema,
  PairingViewSchema,
  ErpCredentialsViewSchema,
  type ErpCredentialsOutcome,
  type ErpCredentialsView,
  type PairingView,
  type PairingChangeOutcome,
  LegacyImportFailureSchema,
  LegacyImportSchema,
  type LegacyImport,
  type LegacyImportOutcome,
  ProjectBookFailureSchema,
  ProjectBookResultSchema,
  ProjectBookSchema,
  type ProjectBook,
  TaskSnapshotSchema,
  type TaskSnapshot,
  TaskListSchema,
  type TaskList,
} from '@baox/contract';

// HTTP adapter: calls the local app server per the endpoint table in @baox/contract (http.ts). Every response goes through a zod schema;
// a 409 always maps to stale_step (the fresh snapshot it carries goes to the store to re-render); the event stream reconnects with backoff after a drop.

export type HttpAdapterOptions = {
  baseUrl?: string;
};

function relativePathOf(file: File): string {
  const selected = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return selected || file.name;
}

export const INVALID_RESPONSE_CODE = 'invalid_response';
export const NETWORK_ERROR_CODE = 'network';
export const NETWORK_ERROR_MESSAGE = '连不上报销服务，操作没有送达。请检查网络后重试；如果一直这样，请联系维护者。';

// 事件流重连间隔：0.5 s 起翻倍，封顶 10 s。
export function reconnectDelay(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 10_000);
}

// ---- 解析边界：给定状态码与 JSON，决定接受还是拒绝（响应形状测试只测这一层）----

const isSuccess = (status: number) => status >= 200 && status < 300;

// 读接口遇到 401：会话失效，抛出 UnauthenticatedError，仓库据此重读会话、页面回到登录。
function refuseUnauthenticated(status: number): void {
  if (status === UNAUTHENTICATED_HTTP_STATUS) throw new UnauthenticatedError();
}

export function parseSessionResponse(status: number, body: unknown): Session {
  if (!isSuccess(status)) throw new Error(`登录状态读取失败（HTTP ${status}）`);
  const parsed = SessionSchema.safeParse(body);
  if (!parsed.success) throw new Error('登录状态的格式与契约不符');
  return parsed.data;
}

// 账号动作（创建管理员、注册、登录、退出）：成功是新会话；失败是 { error }。
export function parseAuthResponse(status: number, body: unknown): AuthOutcome {
  if (isSuccess(status)) {
    const session = SessionSchema.safeParse(body);
    if (session.success) return { ok: true, session: session.data };
    return { ok: false, error: { code: INVALID_RESPONSE_CODE, message: '服务端返回的登录状态格式与契约不符。' } };
  }
  const failure = AuthFailureSchema.safeParse(body);
  if (failure.success) return { ok: false, error: failure.data.error };
  return { ok: false, error: { code: `http_${status}`, message: `请求失败（HTTP ${status}）` } };
}

export function parseTaskListResponse(status: number, body: unknown): TaskList {
  refuseUnauthenticated(status);
  if (!isSuccess(status)) throw new Error(`任务列表加载失败（HTTP ${status}）`);
  const parsed = TaskListSchema.safeParse(body);
  if (!parsed.success) throw new Error('任务列表的格式与契约不符');
  return parsed.data;
}

// 返回整份任务列表的动作（作废任务、完全重置）：成功是整份任务列表；失败是 { error, taskList? }。
export function parseTaskListActionResponse(status: number, body: unknown): TaskListOutcome {
  if (isSuccess(status)) {
    const list = TaskListSchema.safeParse(body);
    if (list.success) return { ok: true, taskList: list.data };
    return { ok: false, error: { code: INVALID_RESPONSE_CODE, message: '服务端返回的任务列表格式与契约不符。' }, taskList: null };
  }
  const failure = TaskListFailureSchema.safeParse(body);
  if (failure.success) return { ok: false, error: failure.data.error, taskList: failure.data.taskList ?? null };
  return { ok: false, error: { code: `http_${status}`, message: `请求失败（HTTP ${status}）` }, taskList: null };
}

export function parseProjectBookResponse(status: number, body: unknown): ProjectBook {
  refuseUnauthenticated(status);
  if (!isSuccess(status)) throw new Error(`个人项目簿加载失败（HTTP ${status}）`);
  const parsed = ProjectBookSchema.safeParse(body);
  if (!parsed.success) throw new Error('个人项目簿的格式与契约不符');
  return parsed.data;
}

// 项目簿维护动作：处理了就是 200 + 结果（结果状态可能是 rejected 等）；请求本身失败是 { error, book? }。
export function parseProjectBookActionResponse(status: number, body: unknown): ProjectBookOutcome {
  if (isSuccess(status)) {
    const result = ProjectBookResultSchema.safeParse(body);
    if (result.success) return { ok: true, result: result.data };
    return { ok: false, error: { code: INVALID_RESPONSE_CODE, message: '服务端返回的项目簿结果格式与契约不符。' }, book: null };
  }
  const failure = ProjectBookFailureSchema.safeParse(body);
  if (failure.success) return { ok: false, error: failure.data.error, book: failure.data.book ?? null };
  return { ok: false, error: { code: `http_${status}`, message: `请求失败（HTTP ${status}）` }, book: null };
}

// 账号管理（管理员）：GET 返回账号列表；不是管理员时服务端说明原因（403），原样作为加载失败的原因。
export function parseAccountListResponse(status: number, body: unknown): AccountList {
  refuseUnauthenticated(status);
  if (!isSuccess(status)) {
    const failure = AuthFailureSchema.safeParse(body);
    throw new Error(failure.success ? failure.data.error.message : `账号列表加载失败（HTTP ${status}）`);
  }
  const parsed = AccountListSchema.safeParse(body);
  if (!parsed.success) throw new Error('账号列表的格式与契约不符');
  return parsed.data;
}

// 账号更新：成功是新的账号列表；失败是 { error, accounts? }。
export function parseAccountActionResponse(status: number, body: unknown): AccountListOutcome {
  if (isSuccess(status)) {
    const list = AccountListSchema.safeParse(body);
    if (list.success) return { ok: true, accountList: list.data };
    return { ok: false, error: { code: INVALID_RESPONSE_CODE, message: '服务端返回的账号列表格式与契约不符。' }, accountList: null };
  }
  const failure = AccountListFailureSchema.safeParse(body);
  if (failure.success) return { ok: false, error: failure.data.error, accountList: failure.data.accounts ? { accounts: failure.data.accounts } : null };
  return { ok: false, error: { code: `http_${status}`, message: `请求失败（HTTP ${status}）` }, accountList: null };
}

// 旧数据导入：GET 是读接口（401 抛 UnauthenticatedError）。
export function parseLegacyImportResponse(status: number, body: unknown): LegacyImport {
  refuseUnauthenticated(status);
  if (!isSuccess(status)) throw new Error(`旧数据导入结果加载失败（HTTP ${status}）`);
  const parsed = LegacyImportSchema.safeParse(body);
  if (!parsed.success) throw new Error('旧数据导入结果的格式与契约不符');
  return parsed.data;
}

// 重试 / 跳过：成功是新的导入结果；失败只有 { error }（如导入已经结束）。
export function parseLegacyImportActionResponse(status: number, body: unknown): LegacyImportOutcome {
  if (isSuccess(status)) {
    const view = LegacyImportSchema.safeParse(body);
    if (view.success) return { ok: true, legacyImport: view.data };
    return { ok: false, error: { code: INVALID_RESPONSE_CODE, message: '服务端返回的旧数据导入结果格式与契约不符。' }, legacyImport: null };
  }
  const failure = LegacyImportFailureSchema.safeParse(body);
  if (failure.success) return { ok: false, error: failure.data.error, legacyImport: null };
  return { ok: false, error: { code: `http_${status}`, message: `请求失败（HTTP ${status}）` }, legacyImport: null };
}

// 扩展配对 (extension pairing): the GET is a read (401 throws UnauthenticatedError).
export function parseExtensionPairingResponse(status: number, body: unknown): PairingView {
  refuseUnauthenticated(status);
  if (!isSuccess(status)) throw new Error(`配对情况加载失败（HTTP ${status}）`);
  const parsed = PairingViewSchema.safeParse(body);
  if (!parsed.success) throw new Error('配对情况的格式与契约不符');
  return parsed.data;
}

// 生成配对码 / 撤销配对 (issue a pairing code / revoke the pairing): success is the new pairing (a freshly issued code
// appears in this answer only); failure is { error } alone.
export function parseExtensionPairingActionResponse(status: number, body: unknown): PairingChangeOutcome {
  if (isSuccess(status)) {
    const view = PairingViewSchema.safeParse(body);
    if (view.success) return { ok: true, pairing: view.data };
    return { ok: false, error: { code: INVALID_RESPONSE_CODE, message: '服务端返回的配对情况格式与契约不符。' }, pairing: null };
  }
  const failure = PairingFailureSchema.safeParse(body);
  if (failure.success) return { ok: false, error: failure.data.error, pairing: null };
  return { ok: false, error: { code: `http_${status}`, message: `请求失败（HTTP ${status}）` }, pairing: null };
}

export function parseErpCredentialsResponse(status: number, body: unknown): ErpCredentialsView {
  refuseUnauthenticated(status);
  if (!isSuccess(status)) throw new Error(`报销系统账号密码情况加载失败（HTTP ${status}）`);
  const parsed = ErpCredentialsViewSchema.safeParse(body);
  if (!parsed.success) throw new Error('报销系统账号密码情况的格式与契约不符');
  return parsed.data;
}

// 保存 / 试登录 / 清除 ERP 凭据: success is the new view (a 试登录 that ran and failed included); failure is { error }.
export function parseErpCredentialsActionResponse(status: number, body: unknown): ErpCredentialsOutcome {
  if (isSuccess(status)) {
    const view = ErpCredentialsViewSchema.safeParse(body);
    if (view.success) return { ok: true, credentials: view.data };
    return { ok: false, error: { code: INVALID_RESPONSE_CODE, message: '服务端返回的报销系统账号密码情况格式与契约不符。' }, credentials: null };
  }
  const failure = PairingFailureSchema.safeParse(body);
  if (failure.success) return { ok: false, error: failure.data.error, credentials: null };
  return { ok: false, error: { code: `http_${status}`, message: `请求失败（HTTP ${status}）` }, credentials: null };
}

export function parseSnapshotResponse(status: number, body: unknown): TaskSnapshot {
  refuseUnauthenticated(status);
  if (!isSuccess(status)) throw new Error(`任务快照加载失败（HTTP ${status}）`);
  const parsed = TaskSnapshotSchema.safeParse(body);
  if (!parsed.success) throw new Error('任务快照的格式与契约不符');
  return parsed.data;
}

export function parseActionResponse(status: number, body: unknown): ActionOutcome {
  if (isSuccess(status)) {
    const snapshot = TaskSnapshotSchema.safeParse(body);
    if (snapshot.success) return { ok: true, snapshot: snapshot.data };
    return { ok: false, error: { code: INVALID_RESPONSE_CODE, message: '服务端返回的快照格式与契约不符。' }, snapshot: null };
  }
  const failure = ActionFailureSchema.safeParse(body);
  if (status === STALE_STEP_HTTP_STATUS) {
    // `erp_in_use` (this account's ERP lease is held by another of its tasks) is the one 409 that keeps its own code:
    // it is not a stale step token, so the page shows the reason where it is.
    if (failure.success && failure.data.error.code === ERP_IN_USE_CODE) return { ok: false, error: failure.data.error, snapshot: failure.data.snapshot ?? null };
    // 过期凭据：不论服务端写的错误码是什么，都按 stale_step 处理；没带快照时由仓库重新拉取。
    const snapshot = failure.success ? (failure.data.snapshot ?? null) : null;
    return { ok: false, error: { code: STALE_STEP_CODE, message: STALE_STEP_NOTICE }, snapshot };
  }
  if (failure.success) return { ok: false, error: failure.data.error, snapshot: failure.data.snapshot ?? null };
  return { ok: false, error: { code: `http_${status}`, message: `请求失败（HTTP ${status}）` }, snapshot: null };
}

// SSE 的一条 snapshot 事件：JSON 不合法或形状不符时返回 null（丢弃该条，等下一条或重连后的重新拉取）。
export function parseSnapshotEvent(data: string): TaskSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = TaskSnapshotSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export async function outcomeFromResponse(response: Response): Promise<ActionOutcome> {
  return parseActionResponse(response.status, await readJson(response));
}

// ---- 适配器 ----

export function createHttpAdapter(options: HttpAdapterOptions = {}): AppAdapter {
  const base = (options.baseUrl ?? '').replace(/\/$/, '');
  const url = (path: string, taskId?: string) => base + (taskId === undefined ? path : path.replace(':id', encodeURIComponent(taskId)));
  const E = HTTP_ENDPOINTS;

  async function post(target: string, body: BodyInit, contentType?: string): Promise<ActionOutcome> {
    let response: Response;
    try {
      const headers: Record<string, string> = contentType ? { 'content-type': contentType } : {};
      response = await fetch(target, { method: 'POST', body, headers });
    } catch {
      return { ok: false, error: { code: NETWORK_ERROR_CODE, message: NETWORK_ERROR_MESSAGE }, snapshot: null };
    }
    return outcomeFromResponse(response);
  }

  const json = (target: string, payload: unknown) => post(target, JSON.stringify(payload), 'application/json');

  async function taskListAction(target: string, payload: unknown): Promise<TaskListOutcome> {
    let response: Response;
    try {
      response = await fetch(target, { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
    } catch {
      return { ok: false, error: { code: NETWORK_ERROR_CODE, message: NETWORK_ERROR_MESSAGE }, taskList: null };
    }
    return parseTaskListActionResponse(response.status, await readJson(response));
  }
  async function authAction(target: string, payload: unknown): Promise<AuthOutcome> {
    let response: Response;
    try {
      response = await fetch(target, { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
    } catch {
      return { ok: false, error: { code: NETWORK_ERROR_CODE, message: NETWORK_ERROR_MESSAGE } };
    }
    return parseAuthResponse(response.status, await readJson(response));
  }
  async function bookAction(target: string, payload: unknown): Promise<ProjectBookOutcome> {
    let response: Response;
    try {
      response = await fetch(target, { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
    } catch {
      return { ok: false, error: { code: NETWORK_ERROR_CODE, message: NETWORK_ERROR_MESSAGE }, book: null };
    }
    return parseProjectBookActionResponse(response.status, await readJson(response));
  }
  async function legacyImportAction(target: string): Promise<LegacyImportOutcome> {
    let response: Response;
    try {
      response = await fetch(target, { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' } });
    } catch {
      return { ok: false, error: { code: NETWORK_ERROR_CODE, message: NETWORK_ERROR_MESSAGE }, legacyImport: null };
    }
    return parseLegacyImportActionResponse(response.status, await readJson(response));
  }
  async function pairingAction(target: string, payload: Record<string, unknown> = {}): Promise<PairingChangeOutcome> {
    let response: Response;
    try {
      response = await fetch(target, { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
    } catch {
      return { ok: false, error: { code: NETWORK_ERROR_CODE, message: NETWORK_ERROR_MESSAGE }, pairing: null };
    }
    return parseExtensionPairingActionResponse(response.status, await readJson(response));
  }
  async function credentialsAction(target: string, payload: Record<string, unknown> = {}): Promise<ErpCredentialsOutcome> {
    let response: Response;
    try {
      response = await fetch(target, { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
    } catch {
      return { ok: false, error: { code: NETWORK_ERROR_CODE, message: NETWORK_ERROR_MESSAGE }, credentials: null };
    }
    return parseErpCredentialsActionResponse(response.status, await readJson(response));
  }
  const action = (taskId: string, endpoint: { path: string }, payload: Record<string, unknown>) => json(url(endpoint.path, taskId), payload);

  return {
    async getSession() {
      let response: Response;
      try {
        response = await fetch(url(E.getSession.path));
      } catch {
        throw new ServiceUnavailableError(NETWORK_ERROR_MESSAGE);
      }
      return parseSessionResponse(response.status, await readJson(response));
    },
    setupAdmin: (input) => authAction(url(E.setupAdmin.path), input),
    register: (input) => authAction(url(E.register.path), input),
    login: (input) => authAction(url(E.login.path), input),
    logout: () => authAction(url(E.logout.path), {}),
    async listTasks() {
      let response: Response;
      try {
        response = await fetch(url(E.listTasks.path));
      } catch {
        // 请求没送达：连接类失败，仓库据此显示全页横幅并自动重试。
        throw new ServiceUnavailableError(NETWORK_ERROR_MESSAGE);
      }
      return parseTaskListResponse(response.status, await readJson(response));
    },
    abandonTask: (taskId) => taskListAction(url(E.abandonTask.path, taskId), {}),
    resetAll: () => taskListAction(url(E.resetAll.path), {}),
    async getProjectBook() {
      let response: Response;
      try {
        response = await fetch(url(E.getProjectBook.path));
      } catch {
        throw new ServiceUnavailableError(NETWORK_ERROR_MESSAGE);
      }
      return parseProjectBookResponse(response.status, await readJson(response));
    },
    intakeProject: (input) => bookAction(url(E.intakeProject.path), input),
    editProject: (input) => bookAction(url(E.editProject.path), input),
    deactivateProject: (input) => bookAction(url(E.deactivateProject.path), input),
    restoreProject: (input) => bookAction(url(E.restoreProject.path), input),
    deleteProject: (input) => bookAction(url(E.deleteProject.path), input),
    changePassword: (input) => authAction(url(E.changePassword.path), input),
    async listAccounts() {
      let response: Response;
      try {
        response = await fetch(url(E.listAccounts.path));
      } catch {
        throw new ServiceUnavailableError(NETWORK_ERROR_MESSAGE);
      }
      return parseAccountListResponse(response.status, await readJson(response));
    },
    async updateAccount(accountId, change) {
      let response: Response;
      try {
        response = await fetch(url(E.updateAccount.path, accountId), { method: 'POST', body: JSON.stringify(change), headers: { 'content-type': 'application/json' } });
      } catch {
        return { ok: false, error: { code: NETWORK_ERROR_CODE, message: NETWORK_ERROR_MESSAGE }, accountList: null };
      }
      return parseAccountActionResponse(response.status, await readJson(response));
    },
    async getPublicProjectBook() {
      let response: Response;
      try {
        response = await fetch(url(E.getPublicProjectBook.path));
      } catch {
        throw new ServiceUnavailableError(NETWORK_ERROR_MESSAGE);
      }
      return parseProjectBookResponse(response.status, await readJson(response));
    },
    intakePublicProject: (input) => bookAction(url(E.intakePublicProject.path), input),
    editPublicProject: (input) => bookAction(url(E.editPublicProject.path), input),
    confirmPublicProjectConversion: (input) => bookAction(url(E.confirmPublicProjectConversion.path), input),
    deactivatePublicProject: (input) => bookAction(url(E.deactivatePublicProject.path), input),
    restorePublicProject: (input) => bookAction(url(E.restorePublicProject.path), input),
    deletePublicProject: (input) => bookAction(url(E.deletePublicProject.path), input),
    async getLegacyImport() {
      let response: Response;
      try {
        response = await fetch(url(E.getLegacyImport.path));
      } catch {
        throw new ServiceUnavailableError(NETWORK_ERROR_MESSAGE);
      }
      return parseLegacyImportResponse(response.status, await readJson(response));
    },
    retryLegacyImport: () => legacyImportAction(url(E.retryLegacyImport.path)),
    skipLegacyImport: () => legacyImportAction(url(E.skipLegacyImport.path)),
    async getExtensionPairing() {
      let response: Response;
      try {
        response = await fetch(url(E.getExtensionPairing.path));
      } catch {
        throw new ServiceUnavailableError(NETWORK_ERROR_MESSAGE);
      }
      return parseExtensionPairingResponse(response.status, await readJson(response));
    },
    createExtensionPairingCode: (input) => pairingAction(url(E.createExtensionPairingCode.path), input?.system ? { system: input.system } : {}),
    revokeExtensionPairing: () => pairingAction(url(E.revokeExtensionPairing.path)),
    async getErpCredentials() {
      let response: Response;
      try {
        response = await fetch(url(E.getErpCredentials.path));
      } catch {
        throw new ServiceUnavailableError(NETWORK_ERROR_MESSAGE);
      }
      return parseErpCredentialsResponse(response.status, await readJson(response));
    },
    saveErpCredentials: (input) => credentialsAction(url(E.saveErpCredentials.path), { account: input.account, password: input.password }),
    testErpCredentials: () => credentialsAction(url(E.testErpCredentials.path)),
    clearErpCredentials: () => credentialsAction(url(E.clearErpCredentials.path)),
    async getSnapshot(taskId) {
      const response = await fetch(url(E.getSnapshot.path, taskId));
      return parseSnapshotResponse(response.status, await readJson(response));
    },
    subscribe(taskId, onEvent): Unsubscribe {
      let source: EventSource | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let attempt = 0;
      let closed = false;
      let down = false;
      const connect = () => {
        const current = new EventSource(url(E.subscribe.path, taskId));
        source = current;
        current.onopen = () => {
          attempt = 0;
          if (down) {
            down = false;
            onEvent({ type: 'connection', state: 'connected' });
          }
        };
        current.onerror = () => {
          // 浏览器自带的重连间隔不可控：关掉连接，按退避自己重连；横幅只在第一次断开时出现。
          current.close();
          if (closed) return;
          if (!down) {
            down = true;
            onEvent({ type: 'connection', state: 'disconnected' });
          }
          timer = setTimeout(connect, reconnectDelay(attempt));
          attempt += 1;
        };
        current.addEventListener(SNAPSHOT_EVENT, (event: Event) => {
          const snapshot = parseSnapshotEvent((event as MessageEvent<string>).data);
          if (!snapshot) return;
          const message: AdapterEvent = { type: 'snapshot', snapshot };
          onEvent(message);
        });
      };
      connect();
      return () => {
        closed = true;
        if (timer) clearTimeout(timer);
        source?.close();
      };
    },
    createTask: (input) => json(url(E.createTask.path), input),
    uploadBatch(taskId, files, onProgress) {
      const form = new FormData();
      for (const file of files) {
        form.append('files', file, file.name);
        form.append('sourcePaths', relativePathOf(file));
      }
      if (!onProgress || typeof XMLHttpRequest === 'undefined') return post(url(E.uploadBatch.path, taskId), form);
      return new Promise<ActionOutcome>((resolve) => {
        const request = new XMLHttpRequest();
        let finished = false;
        const finish = (outcome: ActionOutcome) => {
          if (finished) return;
          finished = true;
          resolve(outcome);
        };
        const interrupted = () => finish({ ok: false, error: { code: 'upload_interrupted', message: '上传连接中断，接收结果尚未确认。请先查看任务中已记录的材料，再重新选择未接收的文件。' }, snapshot: null });
        const report = (progress: UploadTransferProgress) => {
          if (!finished) onProgress(progress);
        };
        request.upload.onprogress = (event) => report({ phase: 'transferring', loadedBytes: event.loaded, totalBytes: event.lengthComputable && event.total > 0 ? event.total : null });
        request.upload.onload = () => report({ phase: 'awaiting_acceptance' });
        request.upload.onerror = interrupted;
        request.upload.onabort = interrupted;
        request.upload.ontimeout = interrupted;
        request.onload = () => {
          if (request.status === 0) interrupted();
          else finish(parseActionResponse(request.status, request.response));
        };
        request.onerror = interrupted;
        request.onabort = interrupted;
        request.ontimeout = interrupted;
        try {
          request.open('POST', url(E.uploadBatch.path, taskId));
          request.responseType = 'json';
          // Before the browser measures a chunk, the only fact is that a transfer was requested.
          report({ phase: 'transferring', loadedBytes: 0, totalBytes: null });
          request.send(form);
        } catch {
          // `open` and `send` can fail before an XHR error event is dispatched. The server may still have received
          // some bytes in the latter case, so use the same uncertain-receipt result as an asynchronous interruption.
          interrupted();
        }
      });
    },
    addPaymentScreenshots(taskId, voucherMaterialId, files, stepToken) {
      const form = new FormData();
      form.append('voucherMaterialId', voucherMaterialId);
      form.append('stepToken', stepToken);
      for (const file of files) form.append('files', file, file.name);
      return post(url(E.addPaymentScreenshots.path, taskId), form);
    },
    supplementDiningEvidence(taskId, { pendingItemId, files }, stepToken) {
      const form = new FormData();
      form.append('pendingItemId', pendingItemId);
      form.append('stepToken', stepToken);
      for (const file of files) form.append('files', file, file.name);
      return post(url(E.supplementDiningEvidence.path, taskId), form);
    },
    startInventory: (taskId, stepToken) => action(taskId, E.startInventory, { stepToken }),
    answerPendingItem: (taskId, itemId, answer, stepToken) => action(taskId, E.answerPendingItem, { itemId, answer, stepToken }),
    confirmReview: (taskId, digest, stepToken, acceptDeadlineWarnings = false) => action(taskId, E.confirmReview, { digest, acceptDeadlineWarnings, stepToken }),
    reopenUpload: (taskId, stepToken) => action(taskId, E.reopenUpload, { stepToken }),
    removePaymentScreenshot: (taskId, screenshotId) => action(taskId, E.removePaymentScreenshot, { screenshotId }),
    completePaymentScreenshots: (taskId, voucherMaterialId) => action(taskId, E.completePaymentScreenshots, { voucherMaterialId }),
    generatePrintSheet: (taskId) => action(taskId, E.generatePrintSheet, {}),
    rotatePlacement: (taskId, pageId, slot, rotate) => action(taskId, E.rotatePlacement, { pageId, slot, rotate }),
    cropPlacement: (taskId, pageId, slot, corners) => action(taskId, E.cropPlacement, { pageId, slot, corners }),
    assignProjectLines: (taskId, input, stepToken) => action(taskId, E.assignProjectLines, { ...input, stepToken }),
    submitProjectAssignment: (taskId, input, stepToken) => action(taskId, E.submitProjectAssignment, { ...input, stepToken }),
    excludeMaterial: (taskId, materialId, stepToken) => action(taskId, E.excludeMaterial, { materialId, stepToken }),
    setTaskHomeCity: (taskId, homeCity, stepToken) => action(taskId, E.setTaskHomeCity, { homeCity, stepToken }),
    startErpWrite: (taskId, stepToken) => action(taskId, E.startErpWrite, { stepToken }),
    confirmLogin: (taskId, stepToken) => action(taskId, E.confirmLogin, { stepToken }),
    cancelErpWrite: (taskId, stepToken) => action(taskId, E.cancelErpWrite, { stepToken }),
    reconcile: (taskId, stepToken) => action(taskId, E.reconcile, { stepToken }),
    handOff: (taskId, stepToken) => action(taskId, E.handOff, { stepToken }),
    refill: (taskId, stepToken) => action(taskId, E.refill, { stepToken }),
  };
}
