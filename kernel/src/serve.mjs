import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { annotateProjects } from './projects.mjs';

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

// 本地选择界面。刻意设计成**前台阻塞**：内核起服务、等用户点提交、拿到结果就自己退出。
// 这样就不存在"会话结束后怎么收"的问题 —— 进程的生命周期就是这一次选择的生命周期。
// 端口用 0（临时端口），因此永远不会和别的东西冲突。
export function renderPage(spec, nonce) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const type = spec.multiple ? 'checkbox' : 'radio';
  const rows = spec.options.map((o, i) => `
    <label class="row">
      <input type="${type}" name="sel" value="${esc(o.id)}" ${!spec.multiple && i === 0 ? 'checked' : ''}>
      <span class="main">
        <span class="label">${esc(o.label)}</span>
        ${o.detail ? `<span class="detail">${esc(o.detail)}</span>` : ''}
      </span>
    </label>`).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(spec.title || 'baox')}</title><style>
:root{color-scheme:light dark}
body{font:16px/1.6 -apple-system,"PingFang SC",sans-serif;margin:0;padding:32px 20px;
  display:flex;justify-content:center;background:Canvas;color:CanvasText}
main{width:100%;max-width:620px}
h1{font-size:20px;margin:0 0 4px}
p.prompt{margin:0 0 20px;opacity:.7}
p.hint{margin:10px 0 0;font-size:13px;opacity:.65}
.row{display:flex;gap:12px;align-items:flex-start;padding:14px 16px;margin-bottom:10px;
  border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:10px;cursor:pointer}
.row:hover{background:color-mix(in srgb,CanvasText 6%,transparent)}
.row:has(:checked){border-color:#2563eb;background:color-mix(in srgb,#2563eb 10%,transparent)}
.main{display:flex;flex-direction:column}
.label{font-weight:600}
.detail{font-size:14px;opacity:.65;margin-top:2px}
button{width:100%;margin-top:20px;padding:14px;font-size:16px;font-weight:600;color:#fff;
  background:#2563eb;border:0;border-radius:10px;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
#done{display:none;text-align:center;padding:48px 0;font-size:17px}
</style></head><body><main>
<form id="f">
  <h1>${esc(spec.title || '请选择')}</h1>
  <p class="prompt">${esc(spec.prompt || '')}</p>
  ${rows}
  <button type="submit">提交</button>
</form>
<div id="done">已提交，可以关闭这个页面，回到 Claude Code 继续。</div>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button'); btn.disabled = true;
  const selected = [...document.querySelectorAll('input[name=sel]:checked')].map(i => i.value);
  if (!selected.length) { btn.disabled = false; alert('请至少选择一项'); return; }
  await fetch('/submit?nonce=${nonce}', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selected })
  });
  document.getElementById('f').style.display = 'none';
  document.getElementById('done').style.display = 'block';
});
</script></main></body></html>`;
}

export function serveSelection(spec, opts = {}) {
  return serveLocal((nonce) => renderPage(spec, nonce), opts,
    (body) => ({ status: 'submitted', selected: body.selected, at: new Date().toISOString() }));
}

/**
 * 看图读数的确认页。**这是把候选变成已解析值的唯一通道** ——
 * 用户在对话里说"没问题"不算，必须在这里逐份勾选并提交。
 * 页面把内核读到的字段原样列出来，让用户拿着原图逐项核对。
 */
export function renderConfirmPage(spec, nonce) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cards = spec.items.map((it) => `
    <label class="row">
      <input type="checkbox" name="sel" value="${esc(it.materialId)}">
      <span class="main">
        <span class="label">${esc(it.fileName)} <span class="tag">${esc(it.docTypeLabel)}</span></span>
        <table>${it.fields.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
        ${it.unreadable.length ? `<span class="detail">看不清、没有读出来的字段：${esc(it.unreadable.join('、'))}</span>` : ''}
      </span>
    </label>`).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>核对看图读数</title><style>
:root{color-scheme:light dark}
body{font:16px/1.6 -apple-system,"PingFang SC",sans-serif;margin:0;padding:32px 20px;
  display:flex;justify-content:center;background:Canvas;color:CanvasText}
main{width:100%;max-width:620px}
h1{font-size:20px;margin:0 0 4px}
p.prompt{margin:0 0 20px;opacity:.7}
p.hint{margin:10px 0 0;font-size:13px;opacity:.65}
.row{display:flex;gap:12px;align-items:flex-start;padding:14px 16px;margin-bottom:10px;
  border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:10px;cursor:pointer}
.row:has(:checked){border-color:#2563eb;background:color-mix(in srgb,#2563eb 10%,transparent)}
.main{display:flex;flex-direction:column;flex:1;min-width:0}
.label{font-weight:600}
.tag{font-weight:400;font-size:13px;opacity:.6;margin-left:6px}
table{margin-top:8px;border-collapse:collapse;font-size:14px}
th{text-align:left;font-weight:400;opacity:.6;padding:2px 16px 2px 0;white-space:nowrap;vertical-align:top}
td{padding:2px 0;font-variant-numeric:tabular-nums;word-break:break-all}
.detail{font-size:14px;opacity:.65;margin-top:8px}
button{width:100%;margin-top:20px;padding:14px;font-size:16px;font-weight:600;color:#fff;
  background:#2563eb;border:0;border-radius:10px;cursor:pointer}
#done{display:none;text-align:center;padding:48px 0;font-size:17px}
</style></head><body><main>
<form id="f">
  <h1>核对看图读数</h1>
  <p class="prompt">下面是从图片里读出来的字段。请对照原始图片逐项核对，
  <b>只勾选与图片完全一致的那几份</b>。没有勾选的会留在待确认项里，不会进入下一步。</p>
  ${cards}
  <button type="submit">确认勾选的这些与图片一致</button>
</form>
<div id="done">已提交，可以关闭这个页面，回到 Claude Code 继续。</div>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button'); btn.disabled = true;
  const selected = [...document.querySelectorAll('input[name=sel]:checked')].map(i => i.value);
  await fetch('/submit?nonce=${nonce}', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selected })
  });
  document.getElementById('f').style.display = 'none';
  document.getElementById('done').style.display = 'block';
});
</script></main></body></html>`;
}

export function serveConfirmation(spec, opts = {}) {
  return serveLocal((nonce) => renderConfirmPage(spec, nonce), opts,
    (body) => ({ status: 'submitted', confirmed: body.selected ?? [], at: new Date().toISOString() }));
}


/**
 * 合并交通发票的逐段分摊页。**这是逐段金额进入系统的唯一通道。**
 *
 * 行程单上的逐段金额只作为预填候选摆在这里，并且明确标注来源 ——
 * 行程单是参考材料，它的金额不是票面法定金额，必须由用户看过、认过、提交，才算数。
 * 页面自己不做四舍五入、不自动补差额；对不上就让用户看见差多少，由他去核对。
 */
export function renderAllocatePage(spec, nonce) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cards = spec.items.map((it) => `
    <section class="card" data-material="${esc(it.materialId)}" data-total="${esc(it.totalAmount)}">
      <h2>${esc(it.fileName)}</h2>
      <p class="detail">发票号码 ${esc(it.maskedNumber ?? '—')}　票面价税合计 <b>${esc(it.totalAmount)}</b> 元　共 ${it.segments.length} 段</p>
      ${it.candidateFrom ? `<p class="detail hint">下面的金额来自${esc(it.candidateFrom)}，只是预填的<b>候选</b>，请对照原始材料逐段核对后再提交。</p>` : ''}
      <table class="seg">
        <tr><th>段</th><th>日期</th><th>城市</th><th>起讫</th><th>本段价税合计</th></tr>
        ${it.segments.map((s, i) => `<tr>
          <td>${i + 1}</td><td>${esc(s.date ?? '—')}</td><td>${esc(s.city ?? '—')}</td><td>${esc(s.route ?? '—')}</td>
          <td><input inputmode="decimal" name="seg" value="${esc(s.amount ?? '')}" placeholder="0.00"></td>
        </tr>`).join('')}
      </table>
      <p class="sum">合计 <span class="v">—</span></p>
    </section>`).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>逐段金额分摊</title><style>
:root{color-scheme:light dark}
body{font:16px/1.6 -apple-system,"PingFang SC",sans-serif;margin:0;padding:32px 20px;
  display:flex;justify-content:center;background:Canvas;color:CanvasText}
main{width:100%;max-width:720px}
h1{font-size:20px;margin:0 0 4px}
h2{font-size:16px;margin:0 0 4px}
p.prompt{margin:0 0 20px;opacity:.7}
p.hint{margin:10px 0 0;font-size:13px;opacity:.65}
.card{padding:16px;margin-bottom:14px;border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:10px}
.detail{font-size:14px;opacity:.7;margin:0 0 8px}
.hint{opacity:.85}
table.seg{width:100%;border-collapse:collapse;font-size:14px}
table.seg th{text-align:left;font-weight:400;opacity:.6;padding:4px 8px 4px 0}
table.seg td{padding:4px 8px 4px 0;vertical-align:middle}
input{width:110px;padding:6px 8px;font:inherit;font-variant-numeric:tabular-nums;
  border:1px solid color-mix(in srgb,CanvasText 30%,transparent);border-radius:6px;background:Canvas;color:CanvasText}
.sum{margin:10px 0 0;font-size:14px;font-variant-numeric:tabular-nums}
.sum .v{font-weight:600}
.sum.bad .v{color:#dc2626}
.sum.good .v{color:#16a34a}
button{width:100%;margin-top:20px;padding:14px;font-size:16px;font-weight:600;color:#fff;
  background:#2563eb;border:0;border-radius:10px;cursor:pointer}
#done{display:none;text-align:center;padding:48px 0;font-size:17px}
</style></head><body><main>
<form id="f">
  <h1>逐段金额分摊</h1>
  <p class="prompt">这几张发票票面只有一个合计金额，但对应多段行程。
  <b>每段的价税合计必须由你给出</b> —— 系统不会平均、按比例、按距离或按时长分摊。
  各段相加必须与票面价税合计<b>分毫不差</b>。</p>
  ${cards}
  <button type="submit">提交这些逐段金额</button>
</form>
<div id="done">已提交，可以关闭这个页面，回到 Claude Code 继续。</div>
<script>
const cents = (v) => Math.round(Number(v) * 100);
function refresh() {
  for (const card of document.querySelectorAll('.card')) {
    const want = cents(card.dataset.total);
    const vals = [...card.querySelectorAll('input[name=seg]')].map(i => i.value.trim());
    const el = card.querySelector('.sum');
    if (vals.some(v => !/^\\d+(\\.\\d{2})?$/.test(v))) { el.className = 'sum'; el.querySelector('.v').textContent = '—'; continue; }
    const got = vals.reduce((a, v) => a + cents(v), 0);
    el.className = 'sum ' + (got === want ? 'good' : 'bad');
    el.querySelector('.v').textContent = (got / 100).toFixed(2) + ' / ' + card.dataset.total
      + (got === want ? '　对上了' : '　差 ' + ((got - want) / 100).toFixed(2));
  }
}
document.addEventListener('input', refresh); refresh();
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button'); btn.disabled = true;
  const allocations = {};
  for (const card of document.querySelectorAll('.card')) {
    // 统一成两位小数再提交；内核只收两位小数，"26" 这种写法在这里规整掉。
    allocations[card.dataset.material] = [...card.querySelectorAll('input[name=seg]')]
      .map(i => { const c = cents(i.value.trim()); return Number.isFinite(c) ? (c / 100).toFixed(2) : i.value.trim(); });
  }
  await fetch('/submit?nonce=${nonce}', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ allocations })
  });
  document.getElementById('f').style.display = 'none';
  document.getElementById('done').style.display = 'block';
});
</script></main></body></html>`;
}

export function serveAllocation(spec, opts = {}) {
  return serveLocal((nonce) => renderAllocatePage(spec, nonce), opts,
    (body) => ({ status: 'submitted', allocations: body.allocations ?? {}, at: new Date().toISOString() }));
}

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
p.hint{margin:10px 0 0;font-size:13px;opacity:.65}
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

/**
 * 个人项目簿的维护页。簿子的增删只发生在这张页面的提交上——有后果的动作要一次
 * 可追溯的提交，不走对话，也不走 CLI（ADR-0009）。
 *
 * **删除和「复检全部」还不在这一版**，各有各的票；页面上现在没有删除按钮，不是漏了。
 *
 * 页面上只有两样东西：一条录入条和当前项目列表。录入条收**项目号和过期时间**，
 * 没有填名称的地方——名称永远是 ERP 回读值，页面上多一个名称框就是在邀请用户
 * 写一个没有权威性、还会和 ERP 错位的名字。过期时间反过来只能由用户给：
 * "这个项目我还报不报"是他的判断，ERP 那边没有这个事实。**它可以留空**（＝永不过期），
 * 页面上就得把这句话说出来——不少项目根本没有明确结题日期，一个看着必填的框
 * 只会逼人瞎填一个 2099。
 *
 * **这一页显示的是全簿，不是可选集合。** 失效的项目（过期的、复检没过的）在选择器里
 * 消失，但在这里必须看得见、必须标着原因——看不见就没法清理。失效**不删除任何东西**，
 * 删除永远是用户的动作。
 *
 * 每次「核对并加入」都是一次真的 ERP 只读核对，所以它可能被拒。被拒不终结这次打开：
 * 判定显示在录入条下面，列表照旧，用户改一个号接着来。
 *
 * 列表的行有两处写法：服务端这一份和页面里 `redraw()` 那一份。是有意留的——
 * 开页那一份不依赖 JS 跑没跑起来（`baox projects-page` 的用例就是直接读 HTML 断言的），
 * 提交之后那一份要就地刷新。两处都只拼这三格，改的时候一起改。
 */
/**
 * 列表里的一行。失效的那一行**照样在列表里**，只是压暗、挂上短标，
 * 并另起一行说清是哪一类问题——用户要照着这句话决定改过期时间还是删掉它。
 *
 * 这一份和页面里 `redraw()` 那一份是有意留的两处写法：开页那一份不依赖 JS 跑没跑起来
 * （`baox projects-page` 的用例就是直接读 HTML 断言的），提交之后那一份要就地刷新。
 * 两处摆的格子必须一样，改的时候一起改。
 */
function rowHtml(p, esc, day) {
  const why = p.statusNote
    ? `\n    <tr class="why"><td colspan="6">${esc(p.statusNote)}</td></tr>`
    : '';
  return `
    <tr class="${p.selectable ? '' : 'dead'}">
      <td class="num">${esc(p.number)}</td>
      <td class="name">${esc(p.name ?? '—')}</td>
      <td class="exp">${p.expiresOn === null ? '永不过期' : esc(String(p.expiresOn))}</td>
      <td class="at">${day(p.confirmedAt)}</td>
      <td class="st">${esc(p.statusLabel)}</td>
      <td class="act"><button class="del" data-number="${esc(p.number)}" title="从项目簿删除">删除</button></td>
    </tr>${why}`;
}

export function renderProjectBookPage(spec, nonce) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // 失效判定和它的措辞都在内核（projects.mjs），页面只负责摆出来。`spec.today` 让用例
  // 定住"今天"；真跑的时候不给，现算。
  const projects = annotateProjects(spec.projects ?? [], spec.today);
  const day = (s) => (s ? esc(String(s).slice(0, 10)) : '—');
  const rows = projects.map((p) => rowHtml(p, esc, day)).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>维护项目簿</title><style>
:root{color-scheme:light dark}
body{font:16px/1.6 -apple-system,"PingFang SC",sans-serif;margin:0;padding:32px 20px;
  display:flex;justify-content:center;background:Canvas;color:CanvasText}
main{width:100%;max-width:620px}
h1{font-size:20px;margin:0 0 4px}
p.prompt{margin:0 0 20px;opacity:.7}
p.hint{margin:10px 0 0;font-size:13px;opacity:.65}
form.bar{display:flex;gap:10px}
input{flex:1;min-width:0;padding:12px 14px;font:inherit;border-radius:10px;
  border:1px solid color-mix(in srgb,CanvasText 30%,transparent);background:Canvas;color:CanvasText}
button{padding:12px 18px;font-size:15px;font-weight:600;color:#fff;background:#2563eb;
  border:0;border-radius:10px;cursor:pointer;white-space:nowrap}
button:disabled{opacity:.5;cursor:default}
button.plain{color:CanvasText;background:transparent;
  border:1px solid color-mix(in srgb,CanvasText 30%,transparent)}
#msg{margin:14px 0 0;padding:12px 14px;font-size:14px;line-height:1.5;border-radius:10px;display:none}
#msg.ok{display:block;background:color-mix(in srgb,#16a34a 14%,transparent)}
#msg.bad{display:block;background:color-mix(in srgb,#dc2626 14%,transparent)}
h2{font-size:14px;font-weight:400;opacity:.6;margin:28px 0 8px}
.head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.tools{display:flex;gap:8px}
.tools button{padding:7px 12px;font-size:13px;font-weight:400}
table{width:100%;border-collapse:collapse;font-size:15px}
th{text-align:left;font-weight:400;font-size:13px;opacity:.6;padding:0 12px 6px 0}
td{padding:8px 12px 8px 0;border-top:1px solid color-mix(in srgb,CanvasText 14%,transparent);
  word-break:break-all}
td.num{font-variant-numeric:tabular-nums;white-space:nowrap}
td.at,td.exp{opacity:.6;font-size:13px;white-space:nowrap}
td.st{font-size:13px;white-space:nowrap}
tr.dead td{opacity:.45}
tr.dead td.st{opacity:1;color:#b45309;font-weight:600}
tr.why td{border-top:0;padding-top:0;font-size:13px;opacity:.75;color:#b45309}
td.act{padding-right:0;text-align:right;width:1%;white-space:nowrap}
td.act button{padding:4px 10px;font-size:13px;font-weight:400;color:#b91c1c;background:transparent;
  border:1px solid color-mix(in srgb,#b91c1c 35%,transparent)}
tr.dead td.act button{opacity:1}
#empty{padding:18px 0;opacity:.6;font-size:14px}
footer{margin-top:28px;display:flex;justify-content:flex-end}
#done{display:none;text-align:center;padding:48px 0;font-size:17px}
</style></head><body><main>
<div id="page">
  <h1>维护项目簿</h1>
  <p class="prompt">从 ERP 里复制一个项目号粘到下面。baox 会<b>当场向 ERP 核对</b>一次：
  存在、已审核、未禁用才加入；项目名称由 ERP 回读写入，不用你填。</p>

  <form class="bar" id="f">
    <input id="number" name="number" placeholder="粘一个项目号" autocomplete="off" autofocus>
    <input id="expiresOn" name="expiresOn" type="date" aria-label="过期时间（可留空）">
    <button type="submit" id="add">核对并加入</button>
  </form>
  <p class="hint">过期时间<b>可以留空</b>——留空＝永不过期。填了的话，过了那天这个项目
  就不再出现在报销时的选择器里，但仍然留在下面这张表上，删不删由你决定。</p>
  <p id="msg"></p>

  <div class="head">
    <h2>当前项目（<span id="count">${projects.length}</span>）</h2>
    <div class="tools">
      <button class="plain" id="recheck">复检全部</button>
      <button class="plain" id="purge">清理全部失效</button>
    </div>
  </div>
  <p class="hint">「复检全部」向 ERP 查一次，把录入之后才被禁用或删掉的项目标出来——
  它<b>只做标记，不删任何东西</b>。要清掉标着失效的那些，点「清理全部失效」；
  单独一条用它那一行的「删除」，都<b>不再问第二遍</b>。</p>
  <table id="list">
    <thead><tr><th>项目号</th><th>名称（ERP 回读）</th><th>过期时间</th><th>加入时间</th>
      <th>状态</th><th></th></tr></thead>
    <tbody id="rows">${rows}</tbody>
  </table>
  <div id="empty" ${projects.length ? 'hidden' : ''}>还没有项目。粘一个项目号加进来，报销时就能从这里选。</div>

  <footer><button class="plain" id="finish">完成</button></footer>
</div>
<div id="done">已收工，可以关闭这个页面，回到 Claude Code 继续。</div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const day = (s) => (s ? esc(String(s).slice(0, 10)) : '—');

// 内核回给页面的簿子已经标好了 selectable / statusLabel / statusNote：
// 浏览器这边算不了"今天"，更不该自己编一套失效的说法。
function redraw(projects) {
  $('rows').innerHTML = projects.map((p) =>
    '<tr class="' + (p.selectable ? '' : 'dead') + '"><td class="num">' + esc(p.number)
    + '</td><td class="name">' + esc(p.name ?? '—')
    + '</td><td class="exp">' + (p.expiresOn === null ? '永不过期' : esc(String(p.expiresOn)))
    + '</td><td class="at">' + day(p.confirmedAt)
    + '</td><td class="st">' + esc(p.statusLabel ?? '')
    + '</td><td class="act"><button class="del" data-number="' + esc(p.number)
    + '" title="从项目簿删除">删除</button></td></tr>'
    + (p.statusNote ? '<tr class="why"><td colspan="6">' + esc(p.statusNote) + '</td></tr>' : ''),
  ).join('');
  $('count').textContent = projects.length;
  $('empty').hidden = projects.length > 0;
}

function say(text, ok) {
  $('msg').textContent = text;
  $('msg').className = ok ? 'ok' : 'bad';
}

/**
 * 页面上的每一次动作都走这一条路：把动作交给内核，内核回什么就显示什么、
 * 拿它回的簿子重画列表。判定、措辞、失效标注一概不在浏览器这边算——
 * 页面自己动一下列表，就会和盘上的簿子出现两个版本。
 */
async function act(body, working) {
  const buttons = [...document.querySelectorAll('#page button')];
  buttons.forEach((b) => { b.disabled = true; });
  say(working, true);
  try {
    const res = await fetch('/submit?nonce=${nonce}', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await res.json();
    if (!payload.ok) {
      // 内核这一次抛了——这不是"被拒"，是没跑通。列表保持原样，不去猜它现在是什么样。
      say('这一下没能跑完：' + payload.error, false);
      return null;
    }
    // 内核的判定就是要显示给用户的那句话；页面不改写它，也不替它总结，
    // 连"这算不算好消息"都是内核给的（succeeded）——「请先去登录」不该是绿的。
    const r = payload.result;
    say(r.note ?? r.status, r.succeeded === true);
    if (r.book) redraw(r.book.projects);
    return r;
  } catch (err) {
    say('没能把这一下交给 baox：' + err.message, false);
    return null;
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

$('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const number = $('number').value;
  if (!number.trim()) return;
  // 过期时间空着就原样递一个空串：留空是用户的一个明确表示（永不过期），
  // 页面不替他编一个日期，也不把这个键藏起来。
  const r = await act({ action: 'intake', number, expiresOn: $('expiresOn').value },
    '正在向 ERP 核对……');
  if (r && r.status === 'admitted') { $('number').value = ''; $('expiresOn').value = ''; }
  $('number').focus();
});

// 删除是硬删，点下去就走，**这里刻意没有二次确认弹窗**：簿子不是账本，没有审计价值，
// 误删的代价只是重新粘一次项目号；而一个弹窗会让"定期清理"烦到没人做。
$('rows').addEventListener('click', (e) => {
  const btn = e.target.closest('button.del');
  if (btn) act({ action: 'remove', number: btn.dataset.number }, '正在删除……');
});

$('purge').addEventListener('click', () => act({ action: 'purge' }, '正在清理失效项……'));

// 复检要往 ERP 跑一趟，比别的动作慢：先说一句，用户才知道页面没死。
$('recheck').addEventListener('click', () =>
  act({ action: 'recheck' }, '正在向 ERP 复检整本簿子（只做标记，不会删任何东西）……'));

$('finish').addEventListener('click', async () => {
  $('finish').disabled = true;
  try {
    await fetch('/done?nonce=${nonce}', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
  } catch (err) {
    // 服务已经不在了（多半是闲置超时先收了工）。收工照样是收工——这一页上加过的项目
    // 每一条在提交那一刻就落了盘。要是这里不接住，按钮会一直是灰的，页面永远停在原地。
    $('done').textContent = '这一页已经收工了（baox 那边等超时先退出了）。'
      + '加进去的项目都已经存好，可以关掉这个页面。';
  }
  $('page').style.display = 'none';
  $('done').style.display = 'block';
});
</script></main></body></html>`;
}

/**
 * 把维护页架在长驻形态上。页面每提交一次就走一次录入闸门，判定原样回给页面，
 * 服务不关；点「完成」才收工，交回收工那一刻簿子的样子。
 *
 * `intake`、`book` 和 `today` 都可注入，测试因此能整条跑通而不碰 ERP、不碰真实数据根，
 * 还能把"今天"定死。
 *
 * **闸门只收项目号和过期时间**，而且是**逐个具名取出来**再往下传的：页面递来的别的字段
 * 一律不传——名称是 ERP 回读值，`lastVerdict` 是复检写的，浏览器递什么都不该能写进簿子。
 *
 * 回给页面和收工时交出的簿子都**先标好失效**（`annotateProjects`）：浏览器那边算不了
 * "今天"，措辞也只该有内核一处出处。
 */
/**
 * 哪些结果算"这一下办成了"。**由内核说了算，页面只照着上色**——它连"今天"都算不了，
 * 更不该自己判断一句话是好消息还是坏消息。
 *
 * 写成**白名单**是故意的：黑名单（"不是 rejected 就算好"）会在下一个状态出现的那天
 * 默默把它涂成绿色，而最会误导人的恰恰是这几个——「请先去登录」和「簿子里本来就没有这个号」
 * 涂成绿色，用户会以为复检做完了、以为删掉了。
 */
const PAGE_SUCCEEDED = new Set(['admitted', 'removed', 'purged', 'none', 'empty', 'done']);

export function serveProjectBookPage({ intake, remove, purge, recheck, book, today, ...opts } = {}) {
  // 离开内核的簿子只经过这一道：出口有三个（开页的 HTML、每次提交的回包、收工的结果），
  // 三个都得带着同一份失效判定，各写各的就会在同一条项目上给出两种说法。
  const annotate = (b) => ({ ...b, projects: annotateProjects(b?.projects ?? [], today) });

  /**
   * 页面上的四个动作各走各的内核入口，**按 `action` 分派，一律逐个具名取参数**。
   * 没有 `action` 的提交按录入算：这一页的第一形态只有录入（#77），
   * 缓存在浏览器里的旧页面不该因此变成一次乱来的调用。
   *
   * 认不出来的动作是一次**被拒**，不是一次录入——落到录入上就意味着拿一个空号
   * 去问一次 ERP，还给用户一句他看不懂的"还没填项目号"。
   */
  // 没接上的动作是一次被拒，不是一次静悄悄的成功：页面拿 `{ok:true}` 却什么都没发生，
  // 用户会以为删掉了，直到下一次开页才发现那条还在。
  const need = (fn, label) => {
    if (!fn) throw new Error(`这一页没有接上「${label}」，这一下什么都没做`);
    return fn;
  };
  const actions = {
    // 闸门只收项目号和过期时间。过期时间只在页面递了这个键的时候才往下传：没递＝
    // 没有这个框（旧页面缓存、直接 POST），传 null 让闸门当成留空，而不是拿一个
    // undefined 去当日期比。
    intake: (body) => need(intake, '核对并加入')(String(body?.number ?? ''),
      body?.expiresOn === undefined ? null : String(body.expiresOn)),
    // 删除只按项目号删。名称是 ERP 回读值、判定是复检写的，浏览器递什么都不该作数。
    remove: (body) => need(remove, '删除')(String(body?.number ?? '')),
    // 清理和复检**一个参数都不收**：删哪些由内核按此刻的失效判定算，
    // 让页面指定就等于让浏览器自己认定谁失效了。
    purge: () => need(purge, '清理全部失效')(),
    recheck: () => need(recheck, '复检全部')(),
  };

  return serveResidentPage((nonce) => renderProjectBookPage({ ...book(), today }, nonce), {
    ...opts,
    onSubmit: async (body) => {
      const name = body?.action === undefined ? 'intake' : String(body.action);
      const run = Object.prototype.hasOwnProperty.call(actions, name) ? actions[name] : null;
      if (!run) throw new Error(`认不出这个动作：${name}`);
      const r = await run(body);
      // 办没办成由内核判，页面照着上色就行（见 PAGE_SUCCEEDED）。
      const judged = { ...r, succeeded: PAGE_SUCCEEDED.has(r?.status) };
      return r?.book ? { ...judged, book: annotate(r.book) } : judged;
    },
    onDone: () => {
      const { projects } = annotate(book());
      return { status: 'done', at: new Date().toISOString(),
        projectCount: projects.length,
        // 全簿和可选各给一个数：差额就是用户该去清理的那些。
        selectableCount: projects.filter((p) => p.selectable).length,
        projects };
    },
  });
}

/** 读一次请求体里的 JSON；读不出来抛，由调用处决定怎么答。 */
async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * 起一个只听回环地址的临时端口服务，把地址交给 onReady 并自己把页面打开。
 * 两种形态（一次性、长驻）共用它，因此"临时端口 + 127.0.0.1 + 自动打开"这三条
 * 只有一处写法，不会在新形态上走样。
 */
function listenLocal(server, nonce, onReady, onListening) {
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/?nonce=${nonce}`;
    onReady?.(url);
    openInBrowser(url);
    onListening();
  });
}

/**
 * 长驻形态的本地页面。**它加在一次性形态旁边，不替代后者** ——
 * 确认读数、逐段分摊、任务选择、确认身份和通用选择页各自只收一次提交，
 * "一次提交就 resolve 并关服务"对它们是对的语义，一个字都不用改。
 * （这条性质原本写在 ADR-0002 里，是无条件的；本形态把它收窄到一次性形态，
 * 已在那份 ADR 的补记里说明。）
 *
 * 项目维护页不是这个形状：用户要在同一次打开里反复"核对并加入 / 删除 / 复检"，
 * 最后才点「完成」。所以这里的服务在提交之后**不关**：每次提交交给内核处理，处理结果
 * 原样回给页面（`{ok:true,result}`），页面据此就地刷新自己。
 *
 * 页面这一侧的约定（后续维护页照此写）：
 * - `GET  /?nonce=…`        取页面本身，可以反复取
 * - `POST /submit?nonce=…`  一次操作，答 `{ok:true,result}`；内核判定为拒绝时答 `{ok:false,error}`，
 *                           `error` 是 `onSubmit` 抛出的那句话，**会原样显示给用户**
 * - `POST /done?nonce=…`    用户点「完成」，服务关闭，`onDone` 的返回值就是这一次打开的最终结果
 *
 * 安全约定与一次性形态完全相同：临时端口、只绑 127.0.0.1、一个随机 nonce 守护**全部**端点，
 * 不匹配一律 404。一次被拒的请求既不会进到内核，也不会替用户把页面关掉。
 *
 * `timeoutMs` 是**闲置**超时：用户在页面上每做一次操作就重新计时，并且一次正在处理中的提交
 * 不会被它砍断。长驻页一开就是一段活儿——按绝对时长砍会在用户正干着的时候把页面收走，
 * 而一次要往 ERP 跑几个来回的"复检全部"耗时超过闲置阈值是正常的，不是没人了。
 */
export function serveResidentPage(
  render, { timeoutMs = 30 * 60 * 1000, onReady, onSubmit, onDone } = {}) {
  const nonce = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    let timer;
    let inFlight = 0;
    const sockets = new Set();
    // close() 只等已有连接自己散场；页面那边是长连接，所以关的时候把它们一并断掉，
    // 否则"点了完成"和"端口真的放开了"之间会隔着一段说不清的时间。
    const shutdown = (settle) => {
      clearTimeout(timer);
      server.close(settle);
      for (const s of sockets) s.destroy();
    };
    // 闲置计时：每做一次操作就拨回去。**手上还有没答完的提交就不算闲置** ——
    // 否则一次慢的核对会在自己写响应的当口被连socket一起拆掉。
    const keepAlive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (inFlight > 0) return keepAlive();
        shutdown(() => resolve({ status: 'timeout', timeoutMs }));
      }, timeoutMs);
    };
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.searchParams.get('nonce') !== nonce) { res.writeHead(404).end('not found'); return; }

      if (req.method === 'GET' && url.pathname === '/') {
        keepAlive();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(render(nonce));
      }

      if (req.method === 'POST' && url.pathname === '/submit') {
        let body;
        try { body = await readJson(req); }
        catch { res.writeHead(400).end('bad json'); return; }
        keepAlive();
        inFlight += 1;
        // 内核可以拒绝这一次操作（查无此号、已禁用……）。那是页面要显示给用户的答案，
        // 不是收工 —— 用户改一个数再来一次就是了。
        let payload;
        try { payload = { ok: true, result: await onSubmit?.(body) }; }
        catch (e) { payload = { ok: false, error: e?.message ?? String(e) }; }
        finally { inFlight -= 1; }
        keepAlive();
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/done') {
        let body;
        try { body = await readJson(req); }
        catch { res.writeHead(400).end('bad json'); return; }
        clearTimeout(timer);
        // 点「完成」这个动作本身就是收工。用户在对话里说"弄好了"不算。
        let final, failed;
        try { final = (await onDone?.(body)) ?? { status: 'done', at: new Date().toISOString() }; }
        catch (e) { failed = e; }
        // 响应真的写出去了才动服务器：body 还在缓冲里就 destroy socket，页面收到的是半截。
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}', () => shutdown(() => (failed ? reject(failed) : resolve(final))));
        return;
      }

      res.writeHead(404).end('not found');
    });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    server.on('error', reject);
    listenLocal(server, nonce, onReady, keepAlive);
  });
}

function serveLocal(render, { timeoutMs = 8 * 60 * 1000, onReady } = {}, onSubmit) {
  const nonce = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    let timer;
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/' && url.searchParams.get('nonce') === nonce) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(render(nonce));
      }
      if (req.method === 'POST' && url.pathname === '/submit' && url.searchParams.get('nonce') === nonce) {
        let body;
        try { body = await readJson(req); }
        catch { res.writeHead(400).end('bad json'); return; }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        clearTimeout(timer);
        // 提交这个动作本身就是确认。用户在对话里说"确认了"不算。
        server.close(() => resolve(onSubmit(body)));
        return;
      }
      res.writeHead(404).end('not found');
    });
    server.on('error', reject);
    listenLocal(server, nonce, onReady, () => {
      timer = setTimeout(() => {
        server.close(() => resolve({ status: 'timeout', timeoutMs }));
      }, timeoutMs);
    });
  });
}
