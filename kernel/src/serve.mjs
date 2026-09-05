import http from 'node:http';
import crypto from 'node:crypto';

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
        const chunks = [];
        for await (const c of req) chunks.push(c);
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
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
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const url = `http://127.0.0.1:${port}/?nonce=${nonce}`;
      onReady?.(url);
      timer = setTimeout(() => {
        server.close(() => resolve({ status: 'timeout', timeoutMs }));
      }, timeoutMs);
    });
  });
}
