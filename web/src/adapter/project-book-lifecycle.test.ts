// @vitest-environment node
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createHttpAdapter } from './http-adapter';

const outcome = (status: 'deactivated' | 'restored' | 'deleted') => ({
  status,
  verdict: null,
  note: status === 'deactivated' ? '项目号 LIFE-1 已停用，不能用于新的项目归属。' : status === 'restored' ? '项目号 LIFE-1 已恢复，可用于新的项目归属。' : '项目号 LIFE-1 已从个人项目簿删除。',
  book: status === 'deleted'
    ? { projects: [] }
    : {
        projects: [
          {
            number: 'LIFE-1',
            name: '生命周期项目',
            expiresOn: null,
            lastCheckedAt: null,
            active: status === 'restored',
            selectable: status === 'restored',
            statusLabel: status === 'restored' ? '可选' : '已停用',
            statusNote: status === 'restored' ? null : '这个项目已停用，不能再选',
          },
        ],
      },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('project lifecycle HTTP adapter', () => {
  test('posts each personal and public lifecycle action with only its project number', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(outcome('deactivated')), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(outcome('restored')), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(outcome('deleted')), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(outcome('deactivated')), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(outcome('restored')), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createHttpAdapter({ baseUrl: 'http://127.0.0.1:3199/' });

    expect(await adapter.deactivateProject({ number: 'LIFE-1' })).toMatchObject({ ok: true, result: { status: 'deactivated' } });
    expect(await adapter.restoreProject({ number: 'LIFE-1' })).toMatchObject({ ok: true, result: { status: 'restored' } });
    expect(await adapter.deleteProject({ number: 'LIFE-1' })).toMatchObject({ ok: true, result: { status: 'deleted' } });
    expect(await adapter.deactivatePublicProject({ number: 'LIFE-1' })).toMatchObject({ ok: true, result: { status: 'deactivated' } });
    expect(await adapter.restorePublicProject({ number: 'LIFE-1' })).toMatchObject({ ok: true, result: { status: 'restored' } });

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init && (init as RequestInit).method, init && (init as RequestInit).body])).toEqual([
      ['http://127.0.0.1:3199/api/project-book/deactivate', 'POST', JSON.stringify({ number: 'LIFE-1' })],
      ['http://127.0.0.1:3199/api/project-book/restore', 'POST', JSON.stringify({ number: 'LIFE-1' })],
      ['http://127.0.0.1:3199/api/project-book/delete', 'POST', JSON.stringify({ number: 'LIFE-1' })],
      ['http://127.0.0.1:3199/api/public-project-book/deactivate', 'POST', JSON.stringify({ number: 'LIFE-1' })],
      ['http://127.0.0.1:3199/api/public-project-book/restore', 'POST', JSON.stringify({ number: 'LIFE-1' })],
    ]);
  });
});
