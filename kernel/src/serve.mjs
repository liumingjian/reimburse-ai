import http from 'node:http';
import crypto from 'node:crypto';
import { closeEgoTab, isEgoControlError, openEgoTab } from './ego.mjs';
import {
  AUTO_OPEN_OFF, EGO_BROWSER, browserMode, openDefaultBrowser,
} from './browser-open.mjs';
import { renderProjectBookPage } from './project-book-page.mjs';
import { renderSelectionPage } from './project-workbench.mjs';

// 正式流程使用操作系统默认浏览器；ego 只在显式 BAOX_BROWSER=ego 时使用。
// 保留这个同步兼容导出，旧调用方只把它当作“已发起”信号。
export function openInBrowser(url, options = {}) {
  if ((options?.env ?? process.env)[AUTO_OPEN_OFF] === '1') return false;
  void openDefaultBrowser(url, options ?? {}).catch(() => {});
  return true;
}

// 本地页面刻意设计成**前台阻塞**：内核起服务、等用户点提交、拿到结果就自己退出。
// 这样就不存在"会话结束后怎么收"的问题 —— 进程的生命周期就是这一次选择的生命周期。
// 端口用 0（临时端口），因此永远不会和别的东西冲突。
//
// 1.0.0 起，业务本地页面只剩两处：**重新绑定身份**和**浏览完整项目目录**。
// Reset 另用一页只收破坏性操作确认，不接收任何业务事实。通用单选页（`select`）和逐段分摊页
// （`allocate`）都已经下线 —— 分摊改走对话提问（`ask_user`），读数确认改走终端表格
// （`confirm_table`）。

/**
 * 任务选择页。**这是项目归属、常驻城市和事由进入系统的唯一通道。**
 *
 * 页面刻意只问材料证明不了的三件事。费用类别不在这里 —— 它由内核按常驻城市和
 * 票面事实推导，不是用户的选择题；把它做成下拉框等于请用户去改一个有确定答案的结论。
 * 常驻城市写在最上面并说明它会决定市内交通算本地还是外地，让用户知道自己在定什么。
 */
export { renderSelectionPage };
export const renderTaskSelectPage = renderSelectionPage;

export function serveTaskSelection(spec = {}, opts = {}) {
  const { searchProjects: findProjects = null, onSubmit, acceptResult, ...localOpts } = opts;
  const allowed = new Map((Array.isArray(spec.projects) ? spec.projects : [])
    .filter((project) => project && String(project.number ?? '').trim())
    .map((project) => [String(project.number).trim(), project]));
  const searchProjects = findProjects ? async (query) => {
    const found = await findProjects(query);
    const rows = Array.isArray(found) ? found : found?.projects;
    const projects = (Array.isArray(rows) ? rows : [])
      .map((project) => allowed.get(String(project?.number ?? '').trim()))
      .filter(Boolean);
    return { projects, more: !Array.isArray(found) && found?.more === true };
  } : null;
  const pageSpec = { ...spec, searchProjectsEnabled: !!searchProjects };
  return serveLocal((nonce) => renderSelectionPage(pageSpec, nonce),
    { ...localOpts, searchProjects },
    onSubmit ?? ((body) => ({ status: 'submitted', homeCity: body.homeCity, purpose: body.purpose,
      projects: body.projects ?? {}, at: new Date().toISOString() })),
    acceptResult ?? ((result) => result?.verdict !== 'rejected'));
}

export function serveProjectBookPage(spec, {
  onIntake, onRemove, onPurge, onRecheck, onDone, ...opts
} = {}) {
  const currentBook = () => typeof spec.book === 'function' ? spec.book() : spec.book;
  const submit = async (body = {}) => {
    const action = body.action;
    if (action === 'intake') return onIntake?.(body.number, body.expiresOn);
    if (action === 'remove') return onRemove?.(body.number);
    if (action === 'purge') return onPurge?.();
    if (action === 'recheck') return onRecheck?.();
    return { status: 'rejected', note: '没有识别这个维护动作' };
  };
  return serveLocal((nonce) => renderProjectBookPage({ ...spec, book: currentBook() ?? { projects: [] } }, nonce),
    { ...opts, resident: true, onDone,
      acceptResult: (result) => ['admitted', 'removed', 'purged', 'none', 'done', 'empty']
        .includes(result?.status) }, submit);
}

export function renderResetPage(spec, nonce) {
  const home = String(spec.home).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>完全重置 baox</title><style>
body{font:16px/1.6 -apple-system,"PingFang SC",sans-serif;margin:0;padding:32px 20px;
  display:flex;justify-content:center}main{width:100%;max-width:560px}
code{word-break:break-all}button{width:100%;padding:14px;font-size:16px;font-weight:600;color:#fff;
  background:#dc2626;border:0;border-radius:10px;cursor:pointer}.warn{padding:14px 16px;background:#fee2e2;color:#7f1d1d;border-radius:10px}
#done{display:none;text-align:center;padding:48px 0}</style></head><body><main>
<form id="f"><h1>完全重置 baox</h1>
<p>将清空 <code>${home}</code> 中的全部本地内容，包括任务、身份、流程进度、日志、浏览器登录状态，并关闭 baox 专用浏览器。</p>
<p class="warn">此操作不可恢复。不会删除原始报销材料，也不会修改 ERP 或卸载 baox。</p>
<button type="submit">完全重置</button></form>
<div id="done">正在重置，请回到 Claude Code 查看结果。</div>
<script>document.getElementById('f').addEventListener('submit',async(e)=>{e.preventDefault();
e.target.querySelector('button').disabled=true;await fetch('/submit?nonce=${nonce}',{method:'POST',
headers:{'content-type':'application/json'},body:JSON.stringify({confirmed:true})});
document.getElementById('f').style.display='none';document.getElementById('done').style.display='block';});</script>
</main></body></html>`;
}

export function serveResetConfirmation(spec, opts = {}) {
  return serveLocal((nonce) => renderResetPage(spec, nonce), opts,
    (body) => ({ status: body.confirmed === true ? 'submitted' : 'declined' }));
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
  <p class="prompt">下面是 baox 从 ego task space 里的 ERP 页面<b>直接读到</b>的当前登录身份。
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
    回到 ego task space 里的 ERP 页面换回本人登录。
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
  timeoutMs = 8 * 60 * 1000, onReady,
  env = process.env, openTab, closeTab, openBrowser = openDefaultBrowser,
  searchProjects: findProjects = null,
  resident = false, onDone, acceptResult = () => true,
} = {}, onSubmit, submitAccepted = acceptResult) {
  const useEgo = browserMode(env) === EGO_BROWSER;
  const egoOpenTab = openTab ?? openEgoTab;
  const egoCloseTab = closeTab ?? closeEgoTab;
  const nonce = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    let timer;
    let finishing = false;
    let localPage = null;
    let localTabMayExist = false;
    let localTabOpenError = null;
    let localTabOpening = Promise.resolve();
    const requests = new Set();
    const sockets = new Set();
    const closeLocalTab = async () => {
      if (!useEgo) return;
      await localTabOpening;
      if (!localPage && localTabMayExist) {
        throw new Error('本地交互页标签清理状态未知',
          localTabOpenError ? { cause: localTabOpenError } : undefined);
      }
      if (!localPage?.tabId) return;
      const id = localPage.tabId;
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const closed = await egoCloseTab(id);
          if (closed !== false) {
            localPage = null;
            return;
          }
          lastError = new Error(`ego-browser 仍保留本地交互页标签: ${id}`);
        } catch (error) {
          if (isEgoControlError(error)) throw error;
          lastError = error;
        }
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
    const armTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish({ status: 'timeout', timeoutMs }), timeoutMs);
    };
    const server = http.createServer(async (req, res) => {
      requests.add(req);
      const release = () => requests.delete(req);
      req.once('close', release);
      req.once('error', release);
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/projects'
        && url.searchParams.get('nonce') === nonce && findProjects) {
        try {
          const result = await findProjects(url.searchParams.get('q') ?? '');
          res.writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(result ?? { projects: [] }));
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: error.message }));
        }
        return;
      }
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
        if (resident) {
          let result;
          try {
            result = await onSubmit(body);
          } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json' })
              .end(JSON.stringify({ ok: false, error: error.message }));
            armTimer();
            return;
          }
          if (finishing || req.aborted) return;
          const accepted = submitAccepted(result);
          res.writeHead(accepted ? 200 : 400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ ok: accepted, result: result ?? null }));
          armTimer();
          return;
        }
        let result;
        try { result = await onSubmit(body); }
        catch (error) {
          res.writeHead(500, { 'content-type': 'application/json' })
            .end(JSON.stringify({ ok: false, error: error.message }));
          armTimer();
          return;
        }
        if (!submitAccepted(result)) {
          res.writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ ok: false, result: result ?? null }));
          armTimer();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, result: result ?? null }), () => {
            clearTimeout(timer);
            // 提交这个动作本身就是确认。用户在对话里说"确认了"不算。
            finish(result);
          });
        return;
      }
      if (resident && req.method === 'POST' && url.pathname === '/done'
        && url.searchParams.get('nonce') === nonce) {
        if (finishing || req.aborted) return;
        let result;
        try { result = onDone ? await onDone() : { status: 'done' }; }
        catch (error) {
          res.writeHead(500, { 'content-type': 'application/json' })
            .end(JSON.stringify({ ok: false, error: error.message }));
          armTimer();
          return;
        }
        if (!submitAccepted(result)) {
          res.writeHead(409, { 'content-type': 'application/json' })
            .end(JSON.stringify({ ok: false, result: result ?? null }));
          armTimer();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }), () => finish(result));
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
      onReady?.(url, server);
      if (env?.[AUTO_OPEN_OFF] !== '1') {
        if (useEgo) {
          // 本地交互页与 ERP 共用同一个持久 ego task space，但只有显式
          // BAOX_BROWSER=ego 才走这条路径。
          localTabOpening = (async () => {
            localTabMayExist = true;
            try {
              const page = await egoOpenTab(url, { wait: true, timeoutSeconds: 30 });
              if (!page?.tabId) throw new Error('ego-browser 没有返回本地交互页 tab id');
              localPage = page;
              localTabMayExist = false;
            } catch (error) {
              localTabOpenError = error;
              if (error?.code === 'EGO_TASK_SPACE_REQUIRED') localTabMayExist = false;
            }
          })().then(() => {
            if (localTabOpenError && !finishing) finish(null, localTabOpenError);
          });
        } else {
          localTabOpening = Promise.resolve().then(() => openBrowser(url)).then((opened) => {
            if (opened === false || opened?.status === 'failed' || opened?.ok === false) {
              const error = new Error('系统默认浏览器未能打开本地交互页');
              error.code = 'BROWSER_OPEN_FAILED';
              throw error;
            }
          }).catch((error) => {
            localTabOpenError = error;
            if (!finishing) finish(null, error);
          });
        }
      }
      armTimer();
    });
  });
}
