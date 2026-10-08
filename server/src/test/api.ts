import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, REGRESSION_MATERIALS, SAMPLE_MATERIALS } from '@baox/fixtures';
import { STAY_TRIO_CONFIRM_NONE, stayTrioElementOf, TaskSnapshotSchema, type Material, type TaskSnapshot } from '@baox/contract';
import { expect } from 'vitest';
import { BACKSTOP_MS } from './deadlines';
import type { TestClient } from './harness';

// Contract-level helpers over a signed-in client's `request()`: an action goes in, a contract-parsed snapshot comes out.

export type Upload = { name: string; bytes: Buffer | Uint8Array; type?: string };

// A generated original from @baox/fixtures by its id prefix — a sample material (`m01`) or a regression fixture
// (`r01`) — under its business file name.
export function sample(prefix: string): Upload {
  const found = [...SAMPLE_MATERIALS, ...REGRESSION_MATERIALS].find((candidate) => candidate.file.startsWith(prefix));
  if (!found) throw new Error(`fixture ${prefix} is missing from @baox/fixtures`);
  return { name: found.fileName, bytes: readFileSync(join(GENERATED_DIR, found.file)), type: found.file.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg' };
}

export function api(client: () => TestClient) {
  const request = (path: string, init?: RequestInit): Promise<Response> => client().request(path, init);

  async function accepted(response: Response): Promise<TaskSnapshot> {
    expect(response.status).toBe(200);
    return TaskSnapshotSchema.parse(await response.json());
  }

  async function current(taskId: string): Promise<TaskSnapshot> {
    return accepted(await request(`/api/tasks/${taskId}`));
  }

  return {
    accepted,
    current,

    async createTask(homeCity = '杭州'): Promise<TaskSnapshot> {
      return accepted(await request('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ homeCity }) }));
    },

    uploadRaw(taskId: string, files: readonly Upload[]): Promise<Response> {
      const form = new FormData();
      for (const file of files) form.append('files', new File([file.bytes], file.name, { type: file.type ?? 'application/pdf' }));
      return request(`/api/tasks/${taskId}/batches`, { method: 'POST', body: form });
    },

    async upload(taskId: string, files: readonly Upload[]): Promise<TaskSnapshot> {
      return accepted(await this.uploadRaw(taskId, files));
    },

    act(snapshot: TaskSnapshot, name: string, body: Record<string, unknown> = {}, stepToken = snapshot.step.stepToken): Promise<Response> {
      return request(`/api/tasks/${snapshot.task.taskId}/actions/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, stepToken }),
      });
    },

    // The 住宿 trio check (#213) asks a hotel invoice for its 结账单 and 支付截图. A test about something else answers
    // every open trio item it can with 确认没有 and goes on from the resulting snapshot. A missing 结账单 cannot be confirmed
    // away: a test with a hotel invoice uploads its folio (m02).
    async withoutStayGaps(snapshot: TaskSnapshot): Promise<TaskSnapshot> {
      let latest = snapshot;
      for (const item of snapshot.pendingItems) {
        if (item.status !== 'open' || [null, 'folio'].includes(stayTrioElementOf(item.itemId))) continue;
        latest = await accepted(await this.act(latest, 'answer-pending', { itemId: item.itemId, answer: { choice: STAY_TRIO_CONFIRM_NONE } }));
      }
      return latest;
    },

    // Waits until the background parser job has finished the current inventory run.
    async settled(taskId: string, timeoutMs = BACKSTOP_MS): Promise<TaskSnapshot> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const snapshot = await current(taskId);
        if (snapshot.inventory.status === 'done') return snapshot;
        if (Date.now() > deadline) throw new Error(`inventory still ${snapshot.inventory.status} after ${timeoutMs} ms`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
}

export function byFileName(snapshot: TaskSnapshot, fileName: string): Material {
  const material = snapshot.materials.find((candidate) => candidate.fileName === fileName);
  if (!material) throw new Error(`no material ${fileName} in the snapshot`);
  return material;
}

// key → value of the candidates from one source.
export function fieldValues(material: Material, source: string): Record<string, string> {
  return Object.fromEntries(material.fields.filter((field) => field.source === source).map((field) => [field.key, field.value]));
}
