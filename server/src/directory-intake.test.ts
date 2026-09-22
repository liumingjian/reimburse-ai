import { TaskSnapshotSchema } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from './test/api';
import { createTestServer, type TestClient, type TestServer } from './test/harness';

describe('directory material intake', () => {
  let server: TestServer;
  let client: TestClient;

  beforeEach(async () => {
    server = await createTestServer();
    client = await server.signIn();
  });

  afterEach(() => server.close());

  it('keeps one nested directory as one task, preserves relative paths and originals, and reports every input', async () => {
    const created = TaskSnapshotSchema.parse(await (await client.post('/api/tasks', { homeCity: '杭州' })).json());
    const taskId = created.task.taskId;
    const invoice = Buffer.from('%PDF-1.4\ninvoice A\n%%EOF\n');
    const folio = Buffer.from('%PDF-1.4\nfolio B\n%%EOF\n');
    const form = new FormData();
    const inputs = [
      { name: 'same.pdf', path: 'trip/receipts/same.pdf', bytes: invoice, type: 'application/pdf' },
      { name: 'same.pdf', path: 'trip/notes/same.pdf', bytes: folio, type: 'application/pdf' },
      { name: 'copy.pdf', path: 'trip/receipts/copy.pdf', bytes: invoice, type: 'application/pdf' },
      { name: 'readme.txt', path: 'trip/notes/readme.txt', bytes: Buffer.from('unrecognised input'), type: 'text/plain' },
    ];
    for (const input of inputs) {
      form.append('files', new File([input.bytes], input.name, { type: input.type }), input.name);
      form.append('sourcePaths', input.path);
    }

    const uploadedResponse = await client.request(`/api/tasks/${taskId}/batches`, { method: 'POST', body: form });
    expect(uploadedResponse.status).toBe(200);
    const snapshot = TaskSnapshotSchema.parse(await uploadedResponse.json());

    expect(snapshot.batches).toHaveLength(1);
    expect(snapshot.batches[0]?.files.map((file) => [file.fileName, file.relativePath, file.status])).toEqual([
      ['same.pdf', 'trip/receipts/same.pdf', 'accepted'],
      ['same.pdf', 'trip/notes/same.pdf', 'accepted'],
      ['copy.pdf', 'trip/receipts/copy.pdf', 'rejected'],
      ['readme.txt', 'trip/notes/readme.txt', 'rejected'],
    ]);
    expect(snapshot.batches[0]?.files[2]).toMatchObject({ reasonCode: 'duplicate_content', reason: expect.stringContaining('trip/receipts/same.pdf') });
    expect(snapshot.batches[0]?.files[3]).toMatchObject({ reasonCode: 'unsupported_type' });

    expect(snapshot.materials.map((material) => ({ fileName: material.fileName, relativePath: material.relativePath }))).toEqual([
      { fileName: 'same.pdf', relativePath: 'trip/receipts/same.pdf' },
      { fileName: 'same.pdf', relativePath: 'trip/notes/same.pdf' },
    ]);
    expect(snapshot.task.taskId).toBe(taskId);
    expect(snapshot.events).toEqual([]);
    expect(snapshot.projectAssignment.status).toBe('not_started');

    for (const [index, material] of snapshot.materials.entries()) {
      const bytes = await (await client.request(`/api/tasks/${taskId}/files/${material.contentHash}`)).arrayBuffer();
      expect(Buffer.from(bytes)).toEqual(inputs[index]?.bytes);
    }

    // The outcome and provenance survive a fresh read, rather than living only in the upload response.
    const reread = TaskSnapshotSchema.parse(await (await client.request(`/api/tasks/${taskId}`)).json());
    expect(reread.batches[0]?.files.map((file) => file.relativePath)).toEqual(inputs.map((input) => input.path));
    expect(reread.materials.map((material) => material.relativePath)).toEqual(['trip/receipts/same.pdf', 'trip/notes/same.pdf']);
  });

  it('keeps legacy single-file submissions inspectable with the file name as provenance', async () => {
    const created = TaskSnapshotSchema.parse(await (await client.post('/api/tasks', { homeCity: '杭州' })).json());
    const body = await api(() => client).upload(created.task.taskId, [{ name: 'single.pdf', bytes: Buffer.from('%PDF-1.4 single') }]);
    expect(body.batches[0]?.files[0]).toMatchObject({ fileName: 'single.pdf', relativePath: 'single.pdf', status: 'accepted' });
    expect(body.materials[0]).toMatchObject({ fileName: 'single.pdf', relativePath: 'single.pdf' });
  });
});
