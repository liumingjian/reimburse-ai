import { ProjectBookResultSchema, ProjectBookSchema } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestClient, type TestServer } from './test/harness';

// Exercise the seam between independently implemented editing and lifecycle operations through authenticated HTTP.
let server: TestServer;
let admin: TestClient;
let member: TestClient;
beforeEach(async () => {
  server = await createTestServer();
  admin = await server.signIn('admin');
  member = await server.signIn('member');
});
afterEach(() => server.close());

async function change(client: TestClient, path: string, body: unknown) {
  const response = await client.post(path, body);
  expect(response.status).toBe(200);
  return ProjectBookResultSchema.parse(await response.json());
}

describe('combined project maintenance', () => {
  it.each(['personal', 'public'] as const)('editing an inactive %s entry preserves inactivity until explicit restoration', async (scope) => {
    const client = scope === 'public' ? admin : member;
    const path = scope === 'public' ? '/api/public-project-book' : '/api/project-book';
    await change(client, `${path}/intake`, { number: 'OLD-101', name: '原项目' });
    await change(client, `${path}/deactivate`, { number: 'OLD-101' });
    const edited = await change(client, `${path}/edit`, { originalNumber: 'OLD-101', number: 'NEW-101', name: '修正项目' });
    expect(edited.status).toBe('edited');
    expect(edited.book.projects).toEqual([
      expect.objectContaining({ number: 'NEW-101', name: '修正项目', active: false, selectable: false, lastCheckedAt: null }),
    ]);
    const duplicate = await change(client, `${path}/intake`, { number: 'NEW-101', name: '不应覆盖' });
    expect(duplicate.status).toBe('rejected');
    expect(duplicate.book).toEqual(edited.book);
    const restored = await change(client, `${path}/restore`, { number: 'NEW-101' });
    expect(restored.book.projects).toEqual([
      expect.objectContaining({ number: 'NEW-101', name: '修正项目', active: true, selectable: true, lastCheckedAt: null }),
    ]);
  });

  it('an inactive public renumber reserves its new number and a refused collision keeps the old entry intact', async () => {
    await change(admin, '/api/public-project-book/intake', { number: 'PUBLIC-OLD', name: '公共原名称' });
    await change(admin, '/api/public-project-book/deactivate', { number: 'PUBLIC-OLD' });
    await change(member, '/api/project-book/intake', { number: 'PERSONAL-TAKEN', name: '个人名称' });
    const refused = await change(admin, '/api/public-project-book/edit', { originalNumber: 'PUBLIC-OLD', number: 'PERSONAL-TAKEN', name: '公共新名称' });
    expect(refused.status).not.toBe('edited');
    expect(refused.book.projects).toEqual([
      expect.objectContaining({ number: 'PUBLIC-OLD', name: '公共原名称', active: false, selectable: false }),
    ]);
    const unchanged = ProjectBookSchema.parse(await (await member.request('/api/project-book')).json());
    expect(unchanged.projects).toEqual([expect.objectContaining({ number: 'PERSONAL-TAKEN', name: '个人名称', selectable: true })]);

    await change(admin, '/api/public-project-book/edit', { originalNumber: 'PUBLIC-OLD', number: 'PUBLIC-NEW', name: '公共新名称' });
    const reserved = await change(member, '/api/project-book/intake', { number: 'PUBLIC-NEW', name: '冲突名称' });
    expect(reserved.status).toBe('rejected');
    expect(reserved.book).toEqual(unchanged);
    const released = await change(member, '/api/project-book/intake', { number: 'PUBLIC-OLD', name: '释放的号码' });
    expect(released.status).toBe('admitted');
  });
});
