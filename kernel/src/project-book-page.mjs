import { annotateProjects } from './projects.mjs';

export function renderProjectBookPage(spec, nonce) {
  const esc = (value) => String(value ?? '').replace(/[&<>\"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[c]));
  const projects = annotateProjects(spec?.book?.projects ?? [], spec?.today);
  const rows = projects.length ? projects.map((project) => `
    <tr>
      <td class="number">${esc(project.number)}</td>
      <td class="name">${esc(project.name ?? '—')}</td>
      <td>${esc(project.expiresOn ?? '永不过期')}</td>
      <td><span class="status ${project.selectable ? 'ok' : 'bad'}">${esc(project.statusLabel)}</span>
        ${project.statusNote ? `<div class="note">${esc(project.statusNote)}</div>` : ''}</td>
      <td><button type="button" class="link danger" data-remove="${esc(project.number)}">删除</button></td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty">当前项目簿为空，请录入第一个项目。</td></tr>';

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>个人项目簿</title>
<style>
:root{color-scheme:light dark}
body{font:16px/1.6 -apple-system,"PingFang SC",sans-serif;margin:0;padding:28px 18px;
  display:flex;justify-content:center;background:Canvas;color:CanvasText}
main{width:100%;max-width:900px}h1{font-size:22px;margin:0 0 4px}
p.lead{margin:0 0 20px;opacity:.7}.panel{padding:16px 0;border-top:1px solid color-mix(in srgb,CanvasText 20%,transparent)}
.form{display:grid;grid-template-columns:minmax(150px,1fr) minmax(170px,1fr) auto;gap:10px;align-items:end}
label{display:block;font-size:14px;opacity:.75}input{box-sizing:border-box;width:100%;margin-top:4px;padding:9px 10px;
  font:inherit;border:1px solid color-mix(in srgb,CanvasText 30%,transparent);border-radius:6px;background:Canvas;color:CanvasText}
button{padding:9px 14px;font:inherit;border:0;border-radius:6px;cursor:pointer;background:#2563eb;color:#fff}
button:disabled{opacity:.55;cursor:wait}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
button.secondary{background:color-mix(in srgb,CanvasText 12%,transparent);color:CanvasText}
button.danger{background:#b91c1c}.link{padding:3px 0;background:transparent;color:#b91c1c}
button.link.danger{background:transparent;color:#b91c1c;min-width:3em;white-space:nowrap}
table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;font-weight:500;opacity:.65}
th,td{padding:9px 8px 9px 0;border-bottom:1px solid color-mix(in srgb,CanvasText 14%,transparent);vertical-align:top}
td.number{white-space:nowrap;font-variant-numeric:tabular-nums}td.name{overflow-wrap:anywhere;word-break:break-word}
.status{display:inline-block}.status.ok{color:#15803d}.status.bad{color:#b91c1c}.note{font-size:13px;opacity:.7;overflow-wrap:anywhere}
.empty{text-align:center;opacity:.65;padding:24px}.message{min-height:1.6em;margin:12px 0;color:#b91c1c}
@media(max-width:640px){body{padding:22px 14px}.form{grid-template-columns:1fr}.form button{width:100%}
  table{font-size:13px}th,td{padding-right:5px}.actions button{flex:1 1 45%}}
</style></head><body><main>
<h1>个人项目簿</h1>
<p class="lead">项目号从 ERP 核验后加入当前登录身份的项目簿。失效项目仍会保留，直到你删除它。</p>
<section class="panel"><form id="intake" class="form">
  <div><label for="number">项目号</label><input id="number" name="number" autocomplete="off" required></div>
  <div><label for="expires">过期时间（可留空）</label><input id="expires" name="expires" type="date"></div>
  <button type="submit">核验并加入</button>
</form><div id="message" class="message" role="status"></div></section>
<section class="panel"><table><thead><tr><th>项目号</th><th>名称</th><th>过期时间</th><th>状态</th><th></th></tr></thead>
<tbody>${rows}</tbody></table>
<div class="actions"><button type="button" class="secondary" id="recheck">复检全部</button>
  <button type="button" class="secondary" id="purge">清理全部失效</button>
  <button type="button" class="secondary" id="done">完成</button></div></section>
<script>
const nonce=${JSON.stringify(nonce)};
const message=document.getElementById('message');
let inFlight=false;
const setBusy=(busy)=>document.querySelectorAll('button').forEach((button)=>{button.disabled=busy});
async function action(action, extra={}){
  if(inFlight)return false;
  inFlight=true;setBusy(true);
  let reloadPending=false;
  try{
    message.textContent='';
    const response=await fetch('/submit?nonce='+encodeURIComponent(nonce),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...extra})});
    let body={};try{body=await response.json()}catch{}
    if(!response.ok){message.textContent=body.result?.note||body.result?.reasons?.join('；')||body.error||'操作没有完成';return false}
    message.textContent=body.result?.note||'已完成';
    reloadPending=true;
    setTimeout(()=>location.reload(),350);return true;
  }catch{
    message.textContent='操作没有完成，请检查网络后重试';return false;
  }finally{
    if(!reloadPending){inFlight=false;setBusy(false)}
  }
}
document.getElementById('intake').addEventListener('submit',async(e)=>{e.preventDefault();
  const number=document.getElementById('number').value.trim();const expires=document.getElementById('expires').value;
  await action('intake',{number,expiresOn:expires||null});
});
document.getElementById('recheck').addEventListener('click',()=>action('recheck'));
document.getElementById('purge').addEventListener('click',()=>action('purge'));
for(const button of document.querySelectorAll('[data-remove]'))button.addEventListener('click',()=>action('remove',{number:button.dataset.remove}));
document.getElementById('done').addEventListener('click',async()=>{
  if(inFlight)return;
  inFlight=true;setBusy(true);
  let closed=false;
  try{
    const response=await fetch('/done?nonce='+encodeURIComponent(nonce),{method:'POST'});
    let body={};try{body=await response.json()}catch{}
    if(!response.ok){message.textContent=body.result?.note||body.error||'页面没有正常结束，请检查当前 ERP 身份后重试';return}
    closed=true;
    document.body.innerHTML='<main><h1>维护已结束</h1><p>可以回到终端继续报销流程。</p></main>';
  }catch{
    message.textContent='页面没有正常结束，请检查网络后重试';
  }finally{
    if(!closed){inFlight=false;setBusy(false)}
  }
});
</script></main></body></html>`;
}
