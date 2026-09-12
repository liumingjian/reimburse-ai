import { ActionFailureSchema, STALE_STEP_CODE, STALE_STEP_NOTICE } from '../contract/actions';
import { ServiceUnavailableError, type ActionOutcome, type AdapterEvent, type AppAdapter, type Unsubscribe } from '../contract/adapter';
import { HTTP_ENDPOINTS, SNAPSHOT_EVENT, STALE_STEP_HTTP_STATUS } from '../contract/http';
import { TaskSnapshotSchema, type TaskSnapshot } from '../contract/snapshot';
import { TaskListSchema, type TaskList } from '../contract/task-list';

// HTTP 适配器：按 contract/http.ts 的端点表调用本地应用服务。每个响应都过 zod schema；
// 409 一律映射为 stale_step（附带的最新快照交给仓库重渲染）；事件流断开后按退避自动重连。

export type HttpAdapterOptions = {
  baseUrl?: string;
};

export const INVALID_RESPONSE_CODE = 'invalid_response';
export const NETWORK_ERROR_CODE = 'network';
export const NETWORK_ERROR_MESSAGE = '本地服务没有响应，操作没有送达。请在终端重新执行 baox 后重试。';

// 事件流重连间隔：0.5 s 起翻倍，封顶 10 s。
export function reconnectDelay(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 10_000);
}

// ---- 解析边界：给定状态码与 JSON，决定接受还是拒绝（响应形状测试只测这一层）----

const isSuccess = (status: number) => status >= 200 && status < 300;

export function parseTaskListResponse(status: number, body: unknown): TaskList {
  if (!isSuccess(status)) throw new Error(`任务列表加载失败（HTTP ${status}）`);
  const parsed = TaskListSchema.safeParse(body);
  if (!parsed.success) throw new Error('任务列表的格式与契约不符');
  return parsed.data;
}

export function parseSnapshotResponse(status: number, body: unknown): TaskSnapshot {
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
  const action = (taskId: string, endpoint: { path: string }, payload: Record<string, unknown>) => json(url(endpoint.path, taskId), payload);

  return {
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
    uploadBatch(taskId, files) {
      const form = new FormData();
      for (const file of files) form.append('files', file, file.name);
      return post(url(E.uploadBatch.path, taskId), form);
    },
    addPaymentScreenshot(taskId, voucherMaterialId, file) {
      const form = new FormData();
      form.append('voucherMaterialId', voucherMaterialId);
      form.append('file', file, file.name);
      return post(url(E.addPaymentScreenshot.path, taskId), form);
    },
    startInventory: (taskId, stepToken) => action(taskId, E.startInventory, { stepToken }),
    answerPendingItem: (taskId, itemId, answer, stepToken) => action(taskId, E.answerPendingItem, { itemId, answer, stepToken }),
    confirmReview: (taskId, digest, stepToken) => action(taskId, E.confirmReview, { digest, stepToken }),
    reopenUpload: (taskId, stepToken) => action(taskId, E.reopenUpload, { stepToken }),
    removePaymentScreenshot: (taskId, screenshotId) => action(taskId, E.removePaymentScreenshot, { screenshotId }),
    generatePrintSheet: (taskId) => action(taskId, E.generatePrintSheet, {}),
    rotatePlacement: (taskId, pageId, slot, rotate) => action(taskId, E.rotatePlacement, { pageId, slot, rotate }),
    cropPlacement: (taskId, pageId, slot, corners) => action(taskId, E.cropPlacement, { pageId, slot, corners }),
    submitProjectAssignment: (taskId, input, stepToken) => action(taskId, E.submitProjectAssignment, { ...input, stepToken }),
    startErpWrite: (taskId, stepToken) => action(taskId, E.startErpWrite, { stepToken }),
    confirmLogin: (taskId, stepToken) => action(taskId, E.confirmLogin, { stepToken }),
    reconcile: (taskId, stepToken) => action(taskId, E.reconcile, { stepToken }),
    handOff: (taskId, stepToken) => action(taskId, E.handOff, { stepToken }),
  };
}
