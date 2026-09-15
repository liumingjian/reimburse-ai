import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TaskSnapshotSchema } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataDirLockedError } from './data-dir';
import { startServer } from './server';
import { createTestServer, tempDataDir, type TestServer } from './test/harness';

// Slice 01 (#179): the walking skeleton through the primary seam, `app.request()` on SQLite `:memory:`.

let server: TestServer;
beforeEach(async () => {
  server = await createTestServer();
});
afterEach(() => server.close());

const PDF_BYTES = Buffer.from('%PDF-1.4\n% baox walking skeleton\n%%EOF\n');

async function createTask(homeCity = '杭州') {
  const response = await server.app.request('/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ homeCity }),
  });
  expect(response.status).toBe(200);
  return TaskSnapshotSchema.parse(await response.json());
}

async function upload(taskId: string, fileName: string, bytes: Buffer) {
  const form = new FormData();
  form.append('files', new File([bytes], fileName, { type: 'application/pdf' }));
  const response = await server.app.request(`/api/tasks/${taskId}/batches`, { method: 'POST', body: form });
  expect(response.status).toBe(200);
  return TaskSnapshotSchema.parse(await response.json());
}

describe('create a task and upload one PDF', () => {
  it('lists the uploaded PDF as a material in a contract-valid snapshot', async () => {
    const created = await createTask();
    expect(created.stage).toBe('upload');
    expect(created.materials).toEqual([]);

    await upload(created.task.taskId, '全季酒店_发票.pdf', PDF_BYTES);

    const response = await server.app.request(`/api/tasks/${created.task.taskId}`);
    expect(response.status).toBe(200);
    const snapshot = TaskSnapshotSchema.parse(await response.json());
    expect(snapshot.task.homeCity).toBe('杭州');
    expect(snapshot.materials).toHaveLength(1);
    expect(snapshot.materials[0]).toMatchObject({
      fileName: '全季酒店_发票.pdf',
      size: PDF_BYTES.length,
      mediaType: 'pdf',
      role: 'uploaded',
    });
    expect(snapshot.batches).toHaveLength(1);
    expect(snapshot.batches[0]?.files[0]).toMatchObject({ status: 'accepted', materialId: snapshot.materials[0]?.materialId });
  });

  // Since #180 the same bytes again in the same task are rejected as duplicate_content; the blob is still stored once.
  it('stores the bytes once under files/sha256/<ab>/<hash>; the same bytes again in the task are rejected as duplicate_content', async () => {
    const { task } = await createTask();
    const hash = createHash('sha256').update(PDF_BYTES).digest('hex');

    await upload(task.taskId, '全季酒店_发票.pdf', PDF_BYTES);
    const second = await upload(task.taskId, '全季酒店_发票_副本.pdf', PDF_BYTES);

    expect(second.materials.map((m) => m.contentHash)).toEqual([hash]);
    expect(second.batches[1]?.files[0]).toMatchObject({ status: 'rejected', reasonCode: 'duplicate_content' });
    const stored = readdirSync(join(server.dataDir, 'files', 'sha256'), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    expect(stored.map((entry) => join(entry.parentPath, entry.name))).toEqual([join(server.dataDir, 'files', 'sha256', hash.slice(0, 2), hash)]);
    expect(readFileSync(stored.map((entry) => join(entry.parentPath, entry.name))[0] ?? '')).toEqual(PDF_BYTES);
  });
});

describe('the data directory', () => {
  it('refuses a second server on the same data directory', async () => {
    const dataDir = tempDataDir();
    try {
      const first = await startServer({ dataDir, port: 0 });
      await expect(startServer({ dataDir, port: 0 })).rejects.toBeInstanceOf(DataDirLockedError);
      await first.close();
      // Closing releases the directory.
      const again = await startServer({ dataDir, port: 0 });
      await again.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
