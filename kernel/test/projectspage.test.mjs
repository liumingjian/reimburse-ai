import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { renderProjectBookPage, serveProjectBookPage } from '../src/serve.mjs';

const KERNEL = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

/** 本地页面的测试一律不许真去弹浏览器。 */
const noAutoOpen = (fn) => async (t) => {
  const before = process.env.BAOX_NO_AUTO_OPEN;
  process.env.BAOX_NO_AUTO_OPEN = '1';
  try { await fn(t); }
  finally {
    if (before === undefined) delete process.env.BAOX_NO_AUTO_OPEN;
    else process.env.BAOX_NO_AUTO_OPEN = before;
  }
};

const post = (base, path, body) => fetch(new URL(path + base.search, base), {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

const entry = (number, name) => ({
  number, name, confirmedAt: '2026-09-07T03:00:00.000Z',
  expiresOn: null, lastCheckedAt: '2026-09-07T03:00:00.000Z', lastVerdict: 'confirmed',
});

// ---- 页面本身 --------------------------------------------------------------
// AC 第一条要的是"页面上有录入条和当前项目列表"，那就得真去看渲染出来的那段 HTML。

test('维护页上有录入条：一个填项目号的框和一个「核对并加入」的按钮', () => {
  const html = renderProjectBookPage({ projects: [] }, 'n0');
  assert.match(html, /<input[^>]+id="number"/, '要有填项目号的输入框');
  assert.match(html, /核对并加入/);
  assert.match(html, /\/submit\?nonce=n0/, '提交要带上这次打开的 nonce');
});

test('维护页上有当前项目列表，项目号和 ERP 名称都看得见', () => {
  const html = renderProjectBookPage({ projects: [entry('111454', '某某研发项目'), entry('111455', '另一个项目')] }, 'n0');
  for (const s of ['111454', '某某研发项目', '111455', '另一个项目']) {
    assert.ok(html.includes(s), `列表里该看得见 ${s}`);
  }
});

test('用户只填项目号：页面上没有让他填名称的地方', () => {
  // 名称永远是 ERP 回读值。页面上多一个名称框，就等于邀请用户去写一个没有权威性的名字。
  const html = renderProjectBookPage({ projects: [] }, 'n0');
  const inputs = html.match(/<input[^>]*>/g) ?? [];
  assert.equal(inputs.length, 1, `录入条只该有项目号一个输入框，实际有 ${inputs.length} 个`);
});

test('空簿有一句指引，不是一张空表了事', () => {
  const html = renderProjectBookPage({ projects: [] }, 'n0');
  assert.match(html, /还没有|空/);
});

test('列表里的内容经过转义，ERP 名称里的尖括号不会变成标签', () => {
  const html = renderProjectBookPage({ projects: [entry('111454', '<script>alert(1)</script>')] }, 'n0');
  assert.ok(!html.includes('<script>alert(1)</script>'), 'ERP 回读的名称必须转义后再进页面');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('页面上有「完成」，用户点它才收工', () => {
  const html = renderProjectBookPage({ projects: [] }, 'n0');
  assert.match(html, /完成/);
  assert.match(html, /\/done\?nonce=n0/);
});

// ---- 页面与内核之间那条缝 ---------------------------------------------------
// 录入闸门整个注入进来，所以这一段全程不联网、不碰真实 ERP。

/** 起一个维护页，把地址和最终结果一并交回来。 */
function startPage(opts = {}) {
  let ready;
  const url = new Promise((r) => { ready = r; });
  const done = serveProjectBookPage({ onReady: ready, ...opts });
  return { url, done };
}

test('提交一个项目号就把它交给录入闸门，判定原样回给页面', noAutoOpen(async () => {
  const seen = [];
  const s = startPage({
    intake: async (number) => {
      seen.push(number);
      return { status: 'admitted', number, entry: entry(number, 'ERP 回读的名字'),
        book: { projects: [entry(number, 'ERP 回读的名字')] }, note: '已加入' };
    },
    book: () => ({ projects: [] }),
  });
  const base = new URL(await s.url);

  const res = await post(base, '/submit', { number: '111454' });
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.result.status, 'admitted');
  assert.equal(payload.result.entry.name, 'ERP 回读的名字');
  assert.deepEqual(payload.result.book.projects.map((p) => p.number), ['111454']);
  assert.deepEqual(seen, ['111454'], '页面上填的那个号原样交给闸门');

  await post(base, '/done');
  await s.done;
}));

test('一次被拒不终结这次打开：判定回给页面，列表还在，服务照旧', noAutoOpen(async () => {
  const s = startPage({
    intake: async (number) => (number === '999999'
      ? { status: 'rejected', verdict: 'missing', number, note: '查不到', book: { projects: [entry('111454', '老项目')] } }
      : { status: 'admitted', number, entry: entry(number, '新项目'),
        book: { projects: [entry('111454', '老项目'), entry(number, '新项目')] } }),
    book: () => ({ projects: [entry('111454', '老项目')] }),
  });
  const base = new URL(await s.url);

  const bad = await (await post(base, '/submit', { number: '999999' })).json();
  assert.equal(bad.ok, true, '业务上的拒绝要带着判定回来，不是一个错误字符串');
  assert.equal(bad.result.status, 'rejected');
  assert.equal(bad.result.verdict, 'missing');
  assert.deepEqual(bad.result.book.projects.map((p) => p.number), ['111454'],
    '被拒之后列表还得在，用户还要接着干活');

  // 被拒之后同一次打开里还能接着录。
  const good = await (await post(base, '/submit', { number: '111455' })).json();
  assert.equal(good.result.status, 'admitted');

  await post(base, '/done');
  await s.done;
}));

test('点「完成」收工，最终结果是收工那一刻簿子的样子', noAutoOpen(async () => {
  let book = { projects: [] };
  const s = startPage({
    intake: async (number) => {
      book = { projects: [...book.projects, entry(number, '某某项目')] };
      return { status: 'admitted', number, entry: entry(number, '某某项目'), book };
    },
    book: () => book,
  });
  const base = new URL(await s.url);

  await post(base, '/submit', { number: '111454' });
  await post(base, '/done');

  const final = await s.done;
  assert.equal(final.status, 'done');
  assert.equal(final.projectCount, 1);
  assert.deepEqual(final.projects.map((p) => p.number), ['111454']);
}));

test('页面一开就照着当前簿子渲染，不用先提交一次才看得见既有项目', noAutoOpen(async () => {
  const s = startPage({
    intake: async () => ({ status: 'admitted' }),
    book: () => ({ projects: [entry('111454', '开页就该看见的项目')] }),
  });
  const base = new URL(await s.url);

  const html = await (await fetch(base)).text();
  assert.ok(html.includes('111454'));
  assert.ok(html.includes('开页就该看见的项目'));

  await post(base, '/done');
  await s.done;
}));

test('提交里除了项目号什么都不作数：名称由 ERP 回读，页面递什么都不进簿', noAutoOpen(async () => {
  let got;
  const s = startPage({
    intake: async (number, extra) => { got = { number, extra }; return { status: 'admitted', number, book: { projects: [] } }; },
    book: () => ({ projects: [] }),
  });
  const base = new URL(await s.url);

  await post(base, '/submit', { number: '111454', name: '页面上伪造的名字', lastVerdict: 'confirmed' });
  assert.equal(got.number, '111454');
  assert.equal(got.extra, undefined, '闸门只收项目号，页面递来的别的字段一律不传下去');

  await post(base, '/done');
  await s.done;
}));

// ---- 命令面 ---------------------------------------------------------------
// AC 说"增删只发生在页面提交上，不提供 CLI 增删入口"。这条只有在进程边界上证得了：
// 有后果的动作要一次可追溯的页面提交，一个能在对话里顺手跑的 `add-project`
// 会把这条规矩整个绕开（ADR-0009）。

const runBaox = (args, home) => {
  const r = spawnSync(process.execPath, [path.join(KERNEL, 'bin', 'baox.mjs'), ...args],
    { env: { ...process.env, BAOX_HOME: home, BAOX_NO_AUTO_OPEN: '1' }, encoding: 'utf8' });
  return { code: r.status, json: JSON.parse(r.stdout) };
};
const freshHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'baox-projects-page-'));

test('弹页命令在命令面上，是维护项目簿的入口', () => {
  const { json } = runBaox(['no-such-command'], freshHome());
  assert.ok(json.commands.includes('projects-page'), '维护页要有一条弹页命令');
});

test('没有任何 CLI 增删入口：增删只发生在页面提交上', () => {
  const home = freshHome();
  const { json } = runBaox(['no-such-command'], home);
  const suspicious = json.commands.filter((c) =>
    /^(add|remove|delete|rm|edit|set)-/.test(c) || /-project$/.test(c));
  assert.deepEqual(suspicious, [], `命令面上不该有增删项目的命令，发现：${suspicious.join('、')}`);

  // 就算有人照着习惯去猜一个，也必须是未知命令，而不是一条能写簿子的暗门。
  for (const guess of ['add-project', 'remove-project', 'delete-project']) {
    const r = runBaox([guess, '--number', '111454'], home);
    assert.equal(r.code, 1, `${guess} 应当是未知命令`);
    assert.match(r.json.error, /未知命令/);
  }
  assert.equal(fs.existsSync(path.join(home, 'projects.json')), false, '没有一条命令写出过簿子');
});

test('弹页命令真的把维护页架起来并阻塞，点「完成」才返回', noAutoOpen(async () => {
  // AC 第一条要的是"打开维护页并阻塞"。这条只有真跑一次命令才证得了：
  // 前台阻塞意味着 Agent 在它返回之前说不了话，所以地址得由内核自己写到 stderr。
  const home = freshHome();
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({
    projects: [entry('111454', '簿子里原有的项目')],
  }));

  const child = spawn(process.execPath, [path.join(KERNEL, 'bin', 'baox.mjs'), 'projects-page'],
    { env: { ...process.env, BAOX_HOME: home, BAOX_NO_AUTO_OPEN: '1' } });

  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  const url = await new Promise((resolve, reject) => {
    child.stderr.on('data', (d) => {
      stderr += d;
      const m = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/\?nonce=[0-9a-f]+/);
      if (m) resolve(m[0]);
    });
    child.on('exit', (code) => reject(new Error(`命令没等页面就退了（code=${code}）：${stdout}`)));
  });
  assert.match(stderr, /维护项目簿/, 'stderr 上要说清这是哪个页面');

  const base = new URL(url);
  const html = await (await fetch(base)).text();
  assert.ok(html.includes('111454'), '开页就该看见簿子里已有的项目');
  assert.ok(html.includes('核对并加入'), '页面上要有录入条');
  assert.equal(stdout, '', '没点「完成」之前命令不该有输出——它是阻塞的');

  await post(base, '/done');
  const code = await new Promise((r) => child.on('exit', r));

  assert.equal(code, 0);
  const json = JSON.parse(stdout);
  assert.equal(json.command, 'projects-page');
  assert.equal(json.status, 'done');
  assert.equal(json.projectCount, 1);
  assert.equal(json.bookPath, path.join(home, 'projects.json'));
}));
