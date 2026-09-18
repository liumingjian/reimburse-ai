// @vitest-environment node
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createHttpAdapter } from './http-adapter';

const converted = {
  status: 'converted',
  verdict: null,
  note: '已转为公共项目',
  book: {
    projects: [
      {
        number: 'CONVERT-1',
        name: '公共项目',
        expiresOn: null,
        lastCheckedAt: null,
        active: true,
        selectable: true,
        statusLabel: '可选',
        statusNote: null,
      },
    ],
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('public project conversion HTTP adapter', () => {
  test('posts the explicit intake and edit confirmation payloads', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(converted), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(converted), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createHttpAdapter({ baseUrl: 'http://127.0.0.1:3199/' });

    expect(await adapter.confirmPublicProjectConversion({ operation: 'intake', number: 'CONVERT-1', name: '公共项目' })).toMatchObject({ ok: true, result: { status: 'converted' } });
    expect(
      await adapter.confirmPublicProjectConversion({
        operation: 'edit',
        originalNumber: 'PUBLIC-OLD',
        originalName: '公共原项目',
        originalActive: false,
        number: 'CONVERT-1',
        name: '公共项目',
      }),
    ).toMatchObject({ ok: true, result: { status: 'converted' } });

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init && (init as RequestInit).method, init && (init as RequestInit).body])).toEqual([
      ['http://127.0.0.1:3199/api/public-project-book/convert', 'POST', JSON.stringify({ operation: 'intake', number: 'CONVERT-1', name: '公共项目' })],
      [
        'http://127.0.0.1:3199/api/public-project-book/convert',
        'POST',
        JSON.stringify({ operation: 'edit', originalNumber: 'PUBLIC-OLD', originalName: '公共原项目', originalActive: false, number: 'CONVERT-1', name: '公共项目' }),
      ],
    ]);
  });
});
