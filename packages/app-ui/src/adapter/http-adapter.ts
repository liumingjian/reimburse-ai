import { ActionFailureSchema, type ActionName } from '../contract/actions';
import type { ActionOutcome, AdapterEvent, AppAdapter, Unsubscribe } from '../contract/adapter';
import { TaskSnapshotSchema, type TaskSnapshot } from '../contract/snapshot';
import { TaskListSchema, type TaskList } from '../contract/task-list';

// HTTP 适配器：按契约调用本地应用服务。路径约定（服务端 spec 以此为准）：
//   GET  /api/tasks                          任务列表
//   POST /api/tasks                          新建任务
//   GET  /api/tasks/:id                      任务快照
//   GET  /api/tasks/:id/events               SSE，event: snapshot，data: 快照 JSON
//   POST /api/tasks/:id/batches              上传批次（multipart，字段 files）
//   POST /api/tasks/:id/payment-screenshots  补充支付截图（multipart，字段 file + voucherMaterialId）
//   POST /api/tasks/:id/actions/<name>       其余动作（JSON），名字见 ACTION_NAMES
// 成功 200 返回快照；失败返回 { error }；stepToken 过期返回 409 { error, snapshot }。

export type HttpAdapterOptions = {
  baseUrl?: string;
  validate?: boolean;
};

export function createHttpAdapter(options: HttpAdapterOptions = {}): AppAdapter {
  const base = (options.baseUrl ?? '').replace(/\/$/, '');
  const validate = options.validate ?? false;
  const taskUrl = (taskId: string) => `${base}/api/tasks/${encodeURIComponent(taskId)}`;

  const parseSnapshot = (raw: unknown): TaskSnapshot => (validate ? TaskSnapshotSchema.parse(raw) : (raw as TaskSnapshot));

  async function outcomeOf(response: Response): Promise<ActionOutcome> {
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) return { ok: true, snapshot: parseSnapshot(body) };
    const failure = ActionFailureSchema.safeParse(body);
    if (failure.success) {
      return { ok: false, error: failure.data.error, snapshot: failure.data.snapshot ?? null };
    }
    return { ok: false, error: { code: `http_${response.status}`, message: `请求失败（HTTP ${response.status}）` }, snapshot: null };
  }

  async function post(url: string, body: BodyInit, contentType?: string): Promise<ActionOutcome> {
    try {
      const headers: Record<string, string> = contentType ? { 'content-type': contentType } : {};
      return await outcomeOf(await fetch(url, { method: 'POST', body, headers }));
    } catch (error) {
      return { ok: false, error: { code: 'network', message: error instanceof Error ? error.message : '网络错误' }, snapshot: null };
    }
  }

  const action = (taskId: string, name: ActionName, payload: Record<string, unknown>) =>
    post(`${taskUrl(taskId)}/actions/${name}`, JSON.stringify(payload), 'application/json');

  return {
    async listTasks(): Promise<TaskList> {
      const response = await fetch(`${base}/api/tasks`);
      if (!response.ok) throw new Error(`任务列表加载失败（HTTP ${response.status}）`);
      const raw: unknown = await response.json();
      return validate ? TaskListSchema.parse(raw) : (raw as TaskList);
    },
    async getSnapshot(taskId) {
      const response = await fetch(taskUrl(taskId));
      if (!response.ok) throw new Error(`任务快照加载失败（HTTP ${response.status}）`);
      return parseSnapshot(await response.json());
    },
    subscribe(taskId, onEvent): Unsubscribe {
      const source = new EventSource(`${taskUrl(taskId)}/events`);
      source.onopen = () => onEvent({ type: 'connection', state: 'connected' });
      source.onerror = () => onEvent({ type: 'connection', state: 'disconnected' });
      source.addEventListener('snapshot', (event: Event) => {
        const data = (event as MessageEvent<string>).data;
        const parsed: unknown = JSON.parse(data);
        const message: AdapterEvent = { type: 'snapshot', snapshot: parseSnapshot(parsed) };
        onEvent(message);
      });
      return () => source.close();
    },
    createTask: (input) => post(`${base}/api/tasks`, JSON.stringify(input), 'application/json'),
    uploadBatch(taskId, files) {
      const form = new FormData();
      for (const file of files) form.append('files', file, file.name);
      return post(`${taskUrl(taskId)}/batches`, form);
    },
    startInventory: (taskId, stepToken) => action(taskId, 'start-inventory', { stepToken }),
    answerPendingItem: (taskId, itemId, answer, stepToken) => action(taskId, 'answer-pending', { itemId, answer, stepToken }),
    confirmReview: (taskId, digest, stepToken) => action(taskId, 'confirm-review', { digest, stepToken }),
    reopenUpload: (taskId, stepToken) => action(taskId, 'reopen-upload', { stepToken }),
    addPaymentScreenshot(taskId, voucherMaterialId, file) {
      const form = new FormData();
      form.append('voucherMaterialId', voucherMaterialId);
      form.append('file', file, file.name);
      return post(`${taskUrl(taskId)}/payment-screenshots`, form);
    },
    removePaymentScreenshot: (taskId, screenshotId) => action(taskId, 'remove-payment-screenshot', { screenshotId }),
    generatePrintSheet: (taskId) => action(taskId, 'generate-print-sheet', {}),
    rotatePlacement: (taskId, pageId, slot, rotate) => action(taskId, 'rotate-placement', { pageId, slot, rotate }),
    cropPlacement: (taskId, pageId, slot, corners) => action(taskId, 'crop-placement', { pageId, slot, corners }),
    submitProjectAssignment: (taskId, input, stepToken) => action(taskId, 'submit-project-assignment', { ...input, stepToken }),
    startErpWrite: (taskId, stepToken) => action(taskId, 'start-erp-write', { stepToken }),
    confirmLogin: (taskId, stepToken) => action(taskId, 'confirm-login', { stepToken }),
    reconcile: (taskId, stepToken) => action(taskId, 'reconcile', { stepToken }),
    handOff: (taskId, stepToken) => action(taskId, 'hand-off', { stepToken }),
  };
}
