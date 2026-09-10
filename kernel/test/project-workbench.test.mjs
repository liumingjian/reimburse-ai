import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { formatDateRange, renderSelectionPage } from '../src/project-workbench.mjs';
import { serveTaskSelection } from '../src/serve.mjs';

const lines = [
  { lineId: 'line-1', categoryLabel: '市内交通', date: '2026-09-01', city: '广州',
    route: '广州南 -> 客户现场', fileName: 'ride.pdf', maskedNumber: '****1234', totalAmount: '18.80' },
  { lineId: 'line-2', categoryLabel: '住宿', date: '2026-09-02', checkOut: '2026-09-05', city: '深圳',
    route: '酒店', fileName: 'hotel.pdf', maskedNumber: '****5678', totalAmount: '3640.00', project: 'P-OLD' },
];

const projects = [
  { number: 'P-1', name: '本人项目一' },
  { number: 'P-2', name: '本人项目二' },
];

test('Variant B 页面按类别展示明细，并保持 homeCity 只读', () => {
  const html = renderSelectionPage({ homeCity: '广州市', purpose: '客户支持', lines, projects,
    previousSelectionWarning: '旧选择不会自动沿用' }, 'workbench-nonce');
  assert.match(html, /<span id="city" aria-label="常驻城市"><\/span>/);
  assert.doesNotMatch(html, /<input id="city"/);
  assert.match(html, /市内交通/);
  assert.match(html, /住宿/);
  assert.match(html, /个人项目簿中的可选项目/);
  assert.match(html, /查找项目号或名称/);
  assert.match(html, /确认覆盖/);
  assert.match(html, /只处理未归属/);
  assert.match(html, /grid-template-columns:minmax\(0,1fr\) minmax\(260px,340px\)/);
  assert.match(html, /@media\(max-width:800px\)/);
  assert.match(html, /let inFlight=false;/);
  assert.match(html, /if\(inFlight\)return;/);
  assert.match(html, /displayedProjects=returned\.map\(p=>allowedProjects\.get/);
  const script = html.match(/<script>\n([\s\S]*?)\n<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(html, /lineDate\(l\.date,l\.checkOut\)/);
});

test('酒店使用事件提供的入住和离店日期展示完整范围，不从文件名推算', () => {
  assert.equal(formatDateRange('2026-08-09', '2026-08-22'), '2026-08-09 至 2026-08-22');
  assert.equal(formatDateRange('2026-08-09', '2026-08-09'), '2026-08-09');
  assert.equal(formatDateRange('2026-08-09', null), '2026-08-09');
  assert.equal(formatDateRange(null, '2026-08-22'), '2026-08-22');
});

test('项目搜索接口只返回页面启动时本人允许集中的项目', async () => {
  const before = process.env.BAOX_NO_AUTO_OPEN;
  process.env.BAOX_NO_AUTO_OPEN = '1';
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  let seenQuery;
  try {
    const pending = serveTaskSelection({ lines: [], projects: [projects[0]] }, {
      timeoutMs: 1000,
      onReady: (url) => readyResolve(url),
      searchProjects: async (query) => {
        seenQuery = query;
        return { projects: [projects[0], { number: 'ERP-GLOBAL', name: '不在本人项目簿' }], more: true };
      },
    });
    const pageUrl = await ready;
    const searchUrl = new URL(pageUrl);
    searchUrl.pathname = '/projects';
    searchUrl.searchParams.set('q', '本人');
    const response = await fetch(searchUrl);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { projects: [projects[0]], more: true });
    assert.equal(seenQuery, '本人');

    const submitUrl = new URL(pageUrl);
    submitUrl.pathname = '/submit';
    const submitted = await fetch(submitUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(submitted.status, 200);
    assert.equal((await pending).status, 'submitted');
  } finally {
    if (before === undefined) delete process.env.BAOX_NO_AUTO_OPEN;
    else process.env.BAOX_NO_AUTO_OPEN = before;
  }
});
