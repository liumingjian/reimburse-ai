import { ActionFailureSchema, TaskListSchema, TaskSnapshotSchema, type TaskSnapshot } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestClient, type TestServer } from './test/harness';

// Slice 02 (#180): upload batches, 材料盘点 (material inventory) and the task lifecycle, through `app.request()`.

let server: TestServer;
let client: TestClient;
beforeEach(async () => {
  server = await createTestServer();
  client = await server.signIn();
});
afterEach(() => server.close());

const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`);

async function createTask(homeCity = '杭州', as = client) {
  const response = await as.post('/api/tasks', { homeCity });
  expect(response.status).toBe(200);
  return TaskSnapshotSchema.parse(await response.json());
}

type Upload = { name: string; bytes: Buffer | Uint8Array; type?: string };

async function upload(taskId: string, files: readonly Upload[]) {
  const form = new FormData();
  for (const file of files) form.append('files', new File([file.bytes], file.name, { type: file.type ?? 'application/pdf' }));
  const response = await client.request(`/api/tasks/${taskId}/batches`, { method: 'POST', body: form });
  expect(response.status).toBe(200);
  return TaskSnapshotSchema.parse(await response.json());
}

function act(snapshot: TaskSnapshot, name: string, body: Record<string, unknown> = {}, stepToken = snapshot.step.stepToken) {
  return client.post(`/api/tasks/${snapshot.task.taskId}/actions/${name}`, { ...body, stepToken });
}

async function accepted(response: Response) {
  expect(response.status).toBe(200);
  return TaskSnapshotSchema.parse(await response.json());
}

describe('stepToken', () => {
  it('a stale stepToken on exclude-material gets 409 whose body carries the fresh snapshot, and nothing changes', async () => {
    const { task } = await createTask();
    const first = await upload(task.taskId, [{ name: 'a.pdf', bytes: pdf('a') }]);
    const second = await upload(task.taskId, [{ name: 'b.pdf', bytes: pdf('b') }]);

    const response = await act(second, 'exclude-material', { materialId: second.materials[0]?.materialId }, first.step.stepToken);

    expect(response.status).toBe(409);
    const failure = ActionFailureSchema.parse(await response.json());
    expect(failure.error.code).toBe('stale_step');
    expect(failure.snapshot).toEqual(second);
  });
});

async function stale(response: Response, fresh: TaskSnapshot) {
  expect(response.status).toBe(409);
  const failure = ActionFailureSchema.parse(await response.json());
  expect(failure.error.code).toBe('stale_step');
  expect(failure.snapshot).toEqual(fresh);
}

async function current(taskId: string) {
  return TaskSnapshotSchema.parse(await (await client.request(`/api/tasks/${taskId}`)).json());
}

async function taskList(as = client) {
  const response = await as.request('/api/tasks');
  expect(response.status).toBe(200);
  return TaskListSchema.parse(await response.json());
}

async function voidTask(taskId: string) {
  return client.post(`/api/tasks/${taskId}/abandon`, {});
}

describe('upload batches', () => {
  it('judges each file of a batch: unsupported_type, too_large, heic and duplicate_content, in upload order', async () => {
    const { task } = await createTask();
    await upload(task.taskId, [{ name: '全季酒店_发票.pdf', bytes: pdf('hotel') }]);
    const snapshot = await upload(task.taskId, [
      { name: '高德打车_发票.pdf', bytes: pdf('amap') },
      { name: '备注.txt', bytes: Buffer.from('note'), type: 'text/plain' },
      { name: '扫描件.pdf', bytes: new Uint8Array(20 * 1024 * 1024 + 1) },
      { name: 'IMG_4871.HEIC', bytes: Buffer.from('heic'), type: 'image/heic' },
      { name: '全季酒店_发票（副本）.pdf', bytes: pdf('hotel') },
      { name: 'IMG_4906.png', bytes: Buffer.from('png bytes'), type: 'image/png' },
    ]);

    expect(snapshot.batches.map((batch) => batch.no)).toEqual([1, 2]);
    expect(snapshot.batches[1]?.files.map((file) => [file.fileName, file.status, file.reasonCode])).toEqual([
      ['高德打车_发票.pdf', 'accepted', null],
      ['备注.txt', 'rejected', 'unsupported_type'],
      ['扫描件.pdf', 'rejected', 'too_large'],
      ['IMG_4871.HEIC', 'rejected', 'heic'],
      ['全季酒店_发票（副本）.pdf', 'rejected', 'duplicate_content'],
      ['IMG_4906.png', 'accepted', null],
    ]);
    expect(snapshot.batches[1]?.files[4]?.reason).toBe('内容重复，与已接收的「全季酒店_发票.pdf」内容相同');
    expect(snapshot.materials.map((m) => [m.fileName, m.mediaType])).toEqual([
      ['全季酒店_发票.pdf', 'pdf'],
      ['高德打车_发票.pdf', 'pdf'],
      ['IMG_4906.png', 'image'],
    ]);
    expect(snapshot.step.kind).toBe('start_inventory');
  });

  it('a batch whose files are all rejected forms no inventory version and leaves the step at upload_materials', async () => {
    const { task } = await createTask();
    const snapshot = await upload(task.taskId, [{ name: 'IMG.heic', bytes: Buffer.from('x'), type: 'image/heic' }]);
    expect(snapshot.batches[0]?.versionId).toBeNull();
    expect(snapshot.materials).toEqual([]);
    expect(snapshot.step.kind).toBe('upload_materials');
  });
});

describe('actions', () => {
  it('exclude-material marks the material excluded without forming a new version; start-inventory then counts only included materials', async () => {
    const { task } = await createTask();
    await upload(task.taskId, [{ name: 'a.pdf', bytes: pdf('a') }]);
    const uploaded = await upload(task.taskId, [{ name: 'b.pdf', bytes: pdf('b') }]);
    const target = uploaded.materials[1]?.materialId;

    const excluded = await accepted(await act(uploaded, 'exclude-material', { materialId: target }));
    expect(excluded.materials.find((m) => m.materialId === target)).toMatchObject({ role: 'excluded', status: 'excluded' });
    expect(excluded.inventory.versionId).toBe(uploaded.inventory.versionId);
    expect(excluded.step).toMatchObject({ kind: 'start_inventory' });
    expect(excluded.step.stepToken).not.toBe(uploaded.step.stepToken);

    const started = await accepted(await act(excluded, 'start-inventory'));
    expect(started.stage).toBe('inventory');
    expect(started.step.kind).toBe('none');
    expect(started.inventory).toMatchObject({ status: 'done', versionId: 'v2', summary: { materialCount: 1 }, ungroupedMaterialIds: [target] });
  });

  it('refuses excluding an unknown material with 400 and the unchanged snapshot', async () => {
    const { task } = await createTask();
    const uploaded = await upload(task.taskId, [{ name: 'a.pdf', bytes: pdf('a') }]);
    const unknown = await act(uploaded, 'exclude-material', { materialId: 'nope' });
    expect(unknown.status).toBe(400);
    expect(ActionFailureSchema.parse(await unknown.json())).toMatchObject({ error: { code: 'material_not_found' }, snapshot: uploaded });
  });

  it('start-inventory is refused while there is nothing to inventory', async () => {
    const created = await createTask();
    const response = await act(created, 'start-inventory');
    expect(response.status).toBe(400);
    expect(ActionFailureSchema.parse(await response.json()).error.code).toBe('not_ready');
  });

  it('reopen-upload returns an inventoried task to upload; a new batch forms the next version to inventory', async () => {
    const { task } = await createTask();
    const uploaded = await upload(task.taskId, [{ name: 'a.pdf', bytes: pdf('a') }]);
    const started = await accepted(await act(uploaded, 'start-inventory'));

    const reopened = await accepted(await act(started, 'reopen-upload'));
    expect(reopened.stage).toBe('upload');
    expect(reopened.step.kind).toBe('start_inventory');

    const more = await upload(task.taskId, [{ name: 'b.pdf', bytes: pdf('b') }]);
    expect(more.inventory.versionId).toBe('v2');
    const restarted = await accepted(await act(more, 'start-inventory'));
    expect(restarted.inventory).toMatchObject({ versionId: 'v2', summary: { materialCount: 2 } });
  });

  it('reopen-upload is refused before inventory started', async () => {
    const { task } = await createTask();
    const uploaded = await upload(task.taskId, [{ name: 'a.pdf', bytes: pdf('a') }]);
    expect((await act(uploaded, 'reopen-upload')).status).toBe(400);
  });

  it('a stale stepToken gets 409 with the fresh snapshot on start-inventory and reopen-upload too', async () => {
    const { task } = await createTask();
    const first = await upload(task.taskId, [{ name: 'a.pdf', bytes: pdf('a') }]);
    const second = await upload(task.taskId, [{ name: 'b.pdf', bytes: pdf('b') }]);
    await stale(await act(second, 'start-inventory', {}, first.step.stepToken), second);

    const started = await accepted(await act(second, 'start-inventory'));
    await stale(await act(started, 'reopen-upload', {}, second.step.stepToken), started);
    expect((await current(task.taskId)).stage).toBe('inventory');
  });
});

describe('the task list and 任务作废 (void task)', () => {
  it('refuses a second task while the account has a non-terminal one', async () => {
    await createTask();
    const response = await client.post('/api/tasks', { homeCity: '上海' });
    expect(response.status).toBe(400);
    expect(ActionFailureSchema.parse(await response.json()).error.code).toBe('active_task_exists');
    expect((await taskList()).tasks).toHaveLength(1);
  });

  it('the one-non-terminal-task rule is per account: another account can still create its own', async () => {
    await createTask();
    const bob = await server.signIn('bob');
    await createTask('上海', bob);
    expect((await taskList(bob)).tasks).toHaveLength(1);
    expect((await taskList()).tasks).toHaveLength(1);
  });

  it('voiding releases the active slot: the task leaves the list, projects as voided, refuses changes, and a new task can be created', async () => {
    const { task } = await createTask();
    const uploaded = await upload(task.taskId, [{ name: 'a.pdf', bytes: pdf('a') }]);
    expect((await taskList()).tasks.map((item) => [item.taskId, item.stage, item.abandonable])).toEqual([[task.taskId, 'upload', true]]);

    const response = await voidTask(task.taskId);
    expect(response.status).toBe(200);
    expect(TaskListSchema.parse(await response.json()).tasks).toEqual([]);

    const voided = await current(task.taskId);
    expect(voided.stage).toBe('voided');
    expect(voided.step.kind).toBe('none');
    expect(voided.materials).toHaveLength(1);
    // A voided task is read-only, even with the current token.
    const refused = await act(uploaded, 'exclude-material', { materialId: uploaded.materials[0]?.materialId }, voided.step.stepToken);
    expect(refused.status).toBe(400);
    expect(ActionFailureSchema.parse(await refused.json()).error.code).toBe('task_closed');

    expect((await voidTask(task.taskId)).status).toBe(404);
    await createTask('上海');
    expect((await taskList()).tasks).toHaveLength(1);
  });
});

describe('SSE', () => {
  it('a subscriber receives a snapshot event after an upload', async () => {
    const { task } = await createTask();
    const controller = new AbortController();
    const response = await client.request(`/api/tasks/${task.taskId}/events`, { signal: controller.signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    const next = async (): Promise<TaskSnapshot> => {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          expect(block).toContain('event: snapshot');
          const data = block.split('\n').find((line) => line.startsWith('data:')) ?? '';
          return TaskSnapshotSchema.parse(JSON.parse(data.slice(5)));
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += value;
      }
    };
    expect((await next()).materials).toEqual([]);

    const uploaded = await upload(task.taskId, [{ name: 'a.pdf', bytes: pdf('a') }]);
    expect(await next()).toEqual(uploaded);
    controller.abort();
    await reader.cancel().catch(() => {});
  });
});
