import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { CDP_PORT, version, targets, newTab, closeTab } from './chrome.mjs';

// 地址只写进 stderr 是不够的：这些命令**前台阻塞**，Agent 在它返回之前既看不到 stderr
// 也说不出话，于是"把地址给用户"这一步永远发生在用户已经干等完之后。所以内核自己把页面打开。
// 打不开也不算错 —— stderr 上的地址仍然是兜底。
const AUTO_OPEN_OFF = 'BAOX_NO_AUTO_OPEN';
export function openInBrowser(url) {
  if (process.env[AUTO_OPEN_OFF] === '1') return false;
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

// 本地页面刻意设计成**前台阻塞**：内核起服务、等用户点提交、拿到结果就自己退出。
// 这样就不存在"会话结束后怎么收"的问题 —— 进程的生命周期就是这一次选择的生命周期。
// 端口用 0（临时端口），因此永远不会和别的东西冲突。
//
// 1.0.0 起，本地页面只剩两处：**重新绑定身份**和**浏览完整项目目录**。
// 通用单选页（`select`）和逐段分摊页（`allocate`）都已经下线 —— 分摊改走对话提问
// （`ask_user`），读数确认改走终端表格（`confirm_table`）。少一个页面就少一条
// "用户在别处点过头"的路径，而这一版的全部意义就是只剩一条路径。

/**
 * 任务选择页。**这是项目归属、常驻城市和事由进入系统的唯一通道。**
 *
 * 页面刻意只问材料证明不了的三件事。费用类别不在这里 —— 它由内核按常驻城市和
 * 票面事实推导，不是用户的选择题；把它做成下拉框等于请用户去改一个有确定答案的结论。
 * 常驻城市写在最上面并说明它会决定市内交通算本地还是外地，让用户知道自己在定什么。
 */
export function renderTaskSelectPage(spec, nonce) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = spec.lines.map((l) => `
    <tr data-line="${esc(l.lineId)}">
      <td><input type="checkbox" name="pick"></td>
      <td>${esc(l.date ?? '—')}</td>
      <td>${esc(l.city ?? '—')}</td>
      <td class="rt">${esc(l.route ?? '—')}</td>
      <td class="num">${esc(l.totalAmount ?? '—')}</td>
      <td class="src">${esc(l.fileName)}<br><span class="detail">${esc(l.kindLabel ?? '')} ${esc(l.maskedNumber ?? '')}</span></td>
      <td><input name="proj" value="${esc(l.project ?? '')}" placeholder="项目号"></td>
    </tr>`).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>任务选择</title><style>
:root{color-scheme:light dark}
body{font:16px/1.6 -apple-system,"PingFang SC",sans-serif;margin:0;padding:32px 20px;
  display:flex;justify-content:center;background:Canvas;color:CanvasText}
main{width:100%;max-width:860px}
h1{font-size:20px;margin:0 0 4px}
h2{font-size:16px;margin:22px 0 6px}
p.prompt{margin:0 0 18px;opacity:.7}
.field{margin-bottom:12px}
.field label{display:block;font-size:14px;opacity:.7;margin-bottom:4px}
input{padding:8px 10px;font:inherit;border-radius:6px;background:Canvas;color:CanvasText;
  border:1px solid color-mix(in srgb,CanvasText 30%,transparent)}
.field input{width:100%;max-width:320px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-weight:400;opacity:.6;padding:6px 8px 6px 0;border-bottom:1px solid color-mix(in srgb,CanvasText 20%,transparent)}
td{padding:8px 8px 8px 0;vertical-align:top;border-bottom:1px solid color-mix(in srgb,CanvasText 10%,transparent)}
td.num{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
td.rt,td.src{word-break:break-all}
td input[name=proj]{width:120px}
.detail{font-size:12px;opacity:.55}
.batch{display:flex;gap:8px;align-items:center;margin:12px 0;font-size:14px;flex-wrap:wrap}
.batch button{width:auto;margin:0;padding:8px 14px;font-size:14px}
button{width:100%;margin-top:20px;padding:14px;font-size:16px;font-weight:600;color:#fff;
  background:#2563eb;border:0;border-radius:10px;cursor:pointer}
#done{display:none;text-align:center;padding:48px 0;font-size:17px}
</style></head><body><main>
<form id="f">
  <h1>任务选择</h1>
  <p class="prompt">下面这几件事材料上没有写，系统也不会替你推断：<b>常驻城市、报销事由、每条明细的项目</b>。
  只有在这里提交，才算数。</p>

  <div class="field">
    <label>常驻城市（决定市内交通算<b>本地</b>还是<b>外地</b>，请如实填本次报销所属员工的常驻城市）</label>
    <input id="city" value="${esc(spec.homeCity ?? '')}" placeholder="例如 广州市">
  </div>
  <div class="field">
    <label>报销事由（写进 ERP 单据表头，必填）</label>
    <input id="purpose" value="${esc(spec.purpose ?? '')}" placeholder="例如 客户支持">
  </div>

  <h2>候选明细的项目归属</h2>
  <div class="batch">
    <label><input type="checkbox" id="all"> 全选</label>
    <input id="bulk" placeholder="项目号">
    <button type="button" id="apply">填到勾选的行</button>
  </div>
  <table>
    <tr><th></th><th>日期</th><th>城市</th><th>起讫</th><th>价税合计</th><th>来源凭证</th><th>项目</th></tr>
    ${rows}
  </table>
  <button type="submit">提交任务选择</button>
</form>
<div id="done">已提交，可以关闭这个页面，回到 Claude Code 继续。</div>
<script>
document.getElementById('all').addEventListener('change', (e) => {
  document.querySelectorAll('input[name=pick]').forEach(i => { i.checked = e.target.checked; });
});
document.getElementById('apply').addEventListener('click', () => {
  const v = document.getElementById('bulk').value.trim();
  if (!v) { alert('先填一个项目号'); return; }
  let n = 0;
  for (const tr of document.querySelectorAll('tr[data-line]')) {
    if (tr.querySelector('input[name=pick]').checked) { tr.querySelector('input[name=proj]').value = v; n += 1; }
  }
  if (!n) alert('先勾选要应用的行');
});
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const projects = {};
  for (const tr of document.querySelectorAll('tr[data-line]')) {
    projects[tr.dataset.line] = tr.querySelector('input[name=proj]').value.trim();
  }
  const missing = Object.values(projects).filter(v => !v).length;
  const city = document.getElementById('city').value.trim();
  const purpose = document.getElementById('purpose').value.trim();
  if (!city || !purpose || missing) {
    alert('常驻城市、事由和每一行的项目都要填' + (missing ? '，还有 ' + missing + ' 行没填项目' : ''));
    return;
  }
  e.target.querySelector('button[type=submit]').disabled = true;
  await fetch('/submit?nonce=${nonce}', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ homeCity: city, purpose, projects })
  });
  document.getElementById('f').style.display = 'none';
  document.getElementById('done').style.display = 'block';
});
</script></main></body></html>`;
}

export function serveTaskSelection(spec, opts = {}) {
  return serveLocal((nonce) => renderTaskSelectPage(spec, nonce), opts,
    (body) => ({ status: 'submitted', homeCity: body.homeCity, purpose: body.purpose,
      projects: body.projects ?? {}, at: new Date().toISOString() }));
}

/**
 * 身份确认页。**这是个人绑定进入系统的唯一通道。**
 *
 * 页面上的每一个值都是内核自己刚从 ERP 页面读出来的，不接受任何输入 ——
 * 用户能做的只有"认"或"不认"。这正是它取代 `--expect <名字>` 的理由：
 * 那条路要用户（经模型转述）打一个字符串出来，而报销主体一旦写错，
 * 发票就进了别人的单子，不可撤销。
 */
export function renderIdentityPage(spec, nonce) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const id = spec.identity;
  const prev = spec.previous;
  const rebind = !!prev;

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>确认报销人身份</title><style>
:root{color-scheme:light dark}
body{font:16px/1.6 -apple-system,"PingFang SC",sans-serif;margin:0;padding:32px 20px;
  display:flex;justify-content:center;background:Canvas;color:CanvasText}
main{width:100%;max-width:560px}
h1{font-size:20px;margin:0 0 4px}
p.prompt{margin:0 0 20px;opacity:.7}
.card{padding:18px 20px;border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:10px}
.card.now{border-color:#2563eb;background:color-mix(in srgb,#2563eb 8%,transparent)}
.card h2{font-size:14px;font-weight:400;opacity:.6;margin:0 0 8px}
table{border-collapse:collapse;font-size:15px}
th{text-align:left;font-weight:400;opacity:.6;padding:3px 18px 3px 0;white-space:nowrap;vertical-align:top}
td{padding:3px 0;word-break:break-all}
td.big{font-size:18px;font-weight:600}
.warn{margin:16px 0 0;padding:14px 16px;font-size:14px;line-height:1.5;border-radius:10px;
  background:color-mix(in srgb,#dc2626 12%,transparent)}
button{width:100%;margin-top:20px;padding:14px;font-size:16px;font-weight:600;color:#fff;
  background:#2563eb;border:0;border-radius:10px;cursor:pointer}
#done{display:none;text-align:center;padding:48px 0;font-size:17px}
</style></head><body><main>
<form id="f">
  <h1>确认报销人身份</h1>
  <p class="prompt">下面是 baox 从专用 Chrome 里的 ERP 页面<b>直接读到</b>的当前登录身份。
  确认之后，这台机器上的 baox 只替这个身份报销；换了人登录会被拦住。</p>

  <div class="card now">
    <h2>ERP 当前登录</h2>
    <table>
      <tr><th>姓名</th><td class="big">${esc(id.displayName ?? '—')}</td></tr>
      <tr><th>登录账号</th><td>${esc(id.account ?? '—')}</td></tr>
      <tr><th>账套</th><td>${esc(id.tenant ?? '—')}</td></tr>
    </table>
  </div>
  ${rebind ? `<div class="warn">
    这台机器原先绑定的是 <b>${esc(prev.displayName ?? prev.account)}</b>
    （账号 ${esc(prev.account)}，账套 ${esc(prev.tenant)}）。
    继续就会<b>改绑到上面这个身份</b>。如果上面显示的不是你本人，请直接关掉这个页面，
    回到专用 Chrome 里换回本人登录。
  </div>` : ''}
  <button type="submit">${rebind ? '是我本人，改绑到这个身份' : '是我本人，就用这个身份'}</button>
</form>
<div id="done">已确认，可以关闭这个页面，回到 Claude Code 继续。</div>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  e.target.querySelector('button').disabled = true;
  await fetch('/submit?nonce=${nonce}', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmed: true })
  });
  document.getElementById('f').style.display = 'none';
  document.getElementById('done').style.display = 'block';
});
</script></main></body></html>`;
}

export function serveIdentityConfirmation(spec, opts = {}) {
  return serveLocal((nonce) => renderIdentityPage(spec, nonce), opts,
    (body) => ({ status: body.confirmed === true ? 'submitted' : 'declined',
      at: new Date().toISOString() }));
}

function serveLocal(render, {
  timeoutMs = 8 * 60 * 1000, onReady, cdpPort = CDP_PORT, openBrowser = openInBrowser,
} = {}, onSubmit) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    let timer;
    let finishing = false;
    let localUrl = null;
    let localTabId = null;
    let localTabMayExist = false;
    let localTabOpenError = null;
    let localTabOpening = Promise.resolve();
    const requests = new Set();
    const sockets = new Set();
    const matchingNewTarget = async (beforeIds, attempts = 1) => {
      let lastError;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const matches = (await targets(cdpPort)).filter((tab) => tab.type === 'page'
            && tab.url === localUrl && tab.id && !beforeIds.has(tab.id));
          if (matches.length === 1) return matches[0];
          if (matches.length > 1) throw new Error('本次新增的本地交互页 target 不唯一');
        } catch (error) { lastError = error; }
        if (attempt < attempts) await pause(20);
      }
      if (lastError) throw lastError;
      return null;
    };
    const closeLocalTab = async () => {
      await localTabOpening;
      if (!localTabId && localTabMayExist) {
        throw new Error('本地交互页标签清理状态未知',
          localTabOpenError ? { cause: localTabOpenError } : undefined);
      }
      if (!localTabId) return;
      const id = localTabId;
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const accepted = await closeTab(id, cdpPort);
          if (accepted) {
            let stillPresent = true;
            for (let check = 0; check < 3; check += 1) {
              stillPresent = (await targets(cdpPort)).some((tab) => tab.id === id);
              if (!stillPresent) {
                localTabId = null;
                return;
              }
              if (check < 2) await pause(20);
            }
          }
        } catch (error) { lastError = error; }
      }
      throw new Error(`本地交互页标签关闭失败: ${id}`, lastError ? { cause: lastError } : undefined);
    };
    const finish = (result, error = null) => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      server.close(async (closeError) => {
        let cleanupError = null;
        try { await closeLocalTab(); } catch (caught) { cleanupError = caught; }
        const originalError = error ?? closeError;
        if (originalError && cleanupError) {
          reject(new AggregateError([originalError, cleanupError],
            `${originalError.message}; cleanup: ${cleanupError.message}`));
        } else if (originalError) reject(originalError);
        else if (cleanupError) reject(cleanupError);
        else resolve(result);
      });
      for (const req of requests) req.destroy();
      for (const socket of sockets) socket.destroy();
    };
    const server = http.createServer(async (req, res) => {
      requests.add(req);
      const release = () => requests.delete(req);
      req.once('close', release);
      req.once('error', release);
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/' && url.searchParams.get('nonce') === nonce) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(render(nonce));
      }
      if (req.method === 'POST' && url.pathname === '/submit' && url.searchParams.get('nonce') === nonce) {
        const chunks = [];
        try {
          for await (const c of req) chunks.push(c);
        } catch (error) {
          if (!finishing && !res.destroyed) res.writeHead(400).end('request aborted');
          return;
        }
        if (finishing || req.aborted) return;
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { res.writeHead(400).end('bad json'); return; }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        clearTimeout(timer);
        // 提交这个动作本身就是确认。用户在对话里说"确认了"不算。
        finish(onSubmit(body));
        return;
      }
      res.writeHead(404).end('not found');
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => {});
    });
    server.on('error', (error) => finish(null, error));
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      const url = `http://127.0.0.1:${port}/?nonce=${nonce}`;
      localUrl = url;
      onReady?.(url, server);
      // 本地交互页不是 ERP 页面：优先借用 baox 已控制的 Chrome 新开一个临时标签。
      // 只有 CDP 本身不可达才回退系统浏览器；创建结果不确定时绝不双开。
      if (process.env[AUTO_OPEN_OFF] !== '1') {
        localTabOpening = (async () => {
          if (!await version(cdpPort)) {
            openBrowser(url);
            return;
          }
          let before;
          try { before = new Set((await targets(cdpPort)).map((tab) => tab.id)); }
          catch (error) {
            localTabOpenError = new Error('本地交互页创建前 target 状态未知', { cause: error });
            return;
          }
          localTabMayExist = true;
          let createError = null;
          try { await newTab(url, cdpPort); } catch (error) { createError = error; }
          let match;
          try { match = await matchingNewTarget(before, createError ? 5 : 1); }
          catch (error) { localTabOpenError = error; return; }
          if (match) {
            localTabId = match.id;
            localTabMayExist = false;
            return;
          }
          localTabOpenError = createError
            ? new Error('本地交互页标签清理状态未知', { cause: createError })
            : new Error('CDP 创建后未发现本次新增的本地交互页 target');
        })();
      }
      timer = setTimeout(() => finish({ status: 'timeout', timeoutMs }), timeoutMs);
    });
  });
}
