const jsonForScript = (value) => JSON.stringify(value ?? {}).replace(/</g, '\\u003c');

/** Show a source-backed hotel stay range without deriving dates from filenames or invoices. */
export const formatDateRange = (start, end) => {
  const first = String(start ?? '').trim();
  const last = String(end ?? '').trim();
  if (last && last !== first) return [first, last].filter(Boolean).join(' 至 ');
  return first || last || '—';
};

/**
 * Variant B: read the classified expense lines on the left and assign the
 * selected lines to an identity-scoped project-book entry on the right.
 *
 * `spec.projects` is the complete allowlist captured before the page opens.
 * Search may reduce what is visible, but it must never reduce that allowlist.
 */
export function renderSelectionPage(spec = {}, nonce) {
  const json = jsonForScript(spec);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>baox 项目归属</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f5f7f6;color:#202923;font:14px/1.5 -apple-system,"PingFang SC",sans-serif;letter-spacing:0;overflow-x:hidden}
header{padding:18px 24px;background:#fff;border-bottom:1px solid #d7dfda;display:flex;align-items:center;gap:24px;flex-wrap:wrap}
h1{font-size:20px;margin:0}h2{font-size:16px;margin:0 0 12px}input,button{font:inherit}
input{border:1px solid #bcc9c1;border-radius:4px;padding:8px;min-width:0;background:#fff;color:#202923}
input[type=checkbox]{width:18px;height:18px;margin:0;accent-color:#26734e;vertical-align:middle}
button{cursor:pointer;border:1px solid #bcc9c1;border-radius:4px;background:#fff;color:inherit;padding:9px 12px;white-space:normal;overflow-wrap:anywhere}
button:disabled{cursor:default;opacity:.5}.layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,340px);gap:24px;padding:24px;max-width:1500px;margin:auto}
.toolbar{display:flex;gap:16px;align-items:center;margin-bottom:16px;flex-wrap:wrap}.group{margin:0 0 24px}.group h2{display:flex;align-items:center;gap:10px;padding-bottom:10px;border-bottom:2px solid #cbd7ce}
.group h2 small{color:#65716a;font-size:12px;font-weight:400}.expense{display:grid;grid-template-columns:20px minmax(0,1fr) minmax(72px,100px);gap:12px;padding:14px 0;border-bottom:1px solid #dce3de;align-items:start}
.expense p{margin:4px 0;overflow-wrap:anywhere}.meta{color:#65716a;font-size:12px}.amount{text-align:right;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.assignment{color:#245da0;overflow-wrap:anywhere}
aside{border-left:1px solid #d7dfda;padding-left:24px;align-self:start;position:sticky;top:20px;max-height:calc(100vh - 40px);overflow:auto;min-width:0}
.target{display:flex;width:100%;text-align:left;justify-content:space-between;gap:10px;margin:8px 0}.target span{overflow-wrap:anywhere}.target small{display:block;color:#65716a}
#search{width:100%;margin-bottom:8px}#selected{margin-bottom:16px}#conflict{background:#fff2df;border:1px solid #deb674;padding:12px;margin:12px 0;border-radius:4px}#conflict p{margin:0 0 8px;overflow-wrap:anywhere}#conflict button{margin:4px 2px}
#query-status{min-height:1.5em;color:#65716a;overflow-wrap:anywhere}.empty{color:#65716a;margin:8px 0;overflow-wrap:anywhere}
footer{padding:16px 24px;position:sticky;bottom:0;background:#fff;border-top:1px solid #d7dfda;display:flex;gap:20px;align-items:center;justify-content:space-between;flex-wrap:wrap}
#submit{background:#26734e;color:#fff;border-color:#26734e}.error{color:#a13232;overflow-wrap:anywhere}#purpose{width:min(360px,100%)}#filter{margin-left:auto}
@media(max-width:800px){header{padding:16px;gap:12px}.layout{grid-template-columns:minmax(0,1fr);padding:16px;gap:16px}aside{position:static;max-height:none;border-left:0;border-top:1px solid #d7dfda;padding:16px 0 0}.expense{grid-template-columns:20px minmax(0,1fr) minmax(64px,80px);gap:8px}footer{padding:12px 16px}#purpose{width:100%}header label{width:100%}}
</style></head><body><header><h1>baox 项目归属</h1><span id="city" aria-label="常驻城市"></span><label>报销事由 <input id="purpose" maxlength="100" required></label></header>
<main class="layout"><section aria-label="费用明细"><div class="toolbar"><label><input id="all" type="checkbox"> 全选当前明细</label><label id="filter"><input id="unassigned" type="checkbox"> 仅未归属</label></div><div id="expenses"></div></section>
<aside aria-label="项目工作台"><h2>项目工作台</h2><div id="selected" role="status"></div><div id="legacy" class="error"></div><div id="conflict" hidden role="alert"><p id="conflict-text"></p><button id="only-empty" type="button">只处理未归属</button><button id="overwrite" type="button">确认覆盖</button><button id="cancel" type="button">取消</button></div><h2>本次已归入</h2><div id="used"></div><h2>个人项目簿中的可选项目</h2><input id="search" type="search" placeholder="查找项目号或名称" aria-label="查找个人项目簿"><div id="query-status" role="status" aria-live="polite"></div><div id="projects"></div></aside></main>
<footer><span id="summary" role="status"></span><button id="submit" type="button">确认项目归属</button><span id="error" class="error" role="alert"></span></footer>
<script>
const spec=${json};const nonce=${JSON.stringify(nonce ?? '')};const lineDate=${formatDateRange.toString()};
const el=id=>document.getElementById(id);const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const lines=Array.isArray(spec.lines)?spec.lines:[];
const selected=new Set();
const assignments=Object.fromEntries(lines.map(l=>[String(l.lineId),String(l.project??'').trim()]));
const initialProjects=Array.isArray(spec.projects)?spec.projects:[];
const allowedProjects=new Map(initialProjects.filter(p=>p&&String(p.number||'').trim()).map(p=>[String(p.number).trim(),{...p,number:String(p.number).trim()}]));
let displayedProjects=[...allowedProjects.values()];
const names=new Map([...allowedProjects.values()].map(p=>[p.number,String(p.name??'').trim()]));
let pendingProject=null;let searchSerial=0;let debounceTimer=null;let inFlight=false;
const money=rows=>{const cents=rows.reduce((sum,l)=>{const value=Number(l.totalAmount);return sum+(Number.isFinite(value)?Math.round(value*100):0)},0);return (cents/100).toFixed(2)};
const visible=()=>lines.filter(l=>!el('unassigned').checked||!assignments[String(l.lineId)]);
const selectedLines=()=>lines.filter(l=>selected.has(String(l.lineId)));
const projectName=number=>names.get(number)||allowedProjects.get(number)?.name||number;
const closeConflict=()=>{pendingProject=null;el('conflict').hidden=true};
el('purpose').value=String(spec.purpose??'');el('city').textContent='常驻城市：'+String(spec.homeCity??'—');el('legacy').textContent=String(spec.previousSelectionWarning??'');
function projectButton(number,name){const rows=lines.filter(l=>assignments[String(l.lineId)]===number);const allowed=allowedProjects.has(number);const disabled=!selected.size||!allowed;return '<button class="target" type="button" data-project="'+esc(number)+'" '+(disabled?'disabled':'')+'><span>'+esc(name||number)+'<small>'+esc(number)+(rows.length?' · '+rows.length+' 条 · '+money(rows)+' 元':'')+'</small></span><span>'+(allowed?'归入':'已锁定')+'</span></button>'}
function render(){const groups=new Map();for(const line of visible()){const key=String(line.categoryLabel||'费用类别待确认');groups.set(key,[...(groups.get(key)||[]),line]);}
el('expenses').innerHTML=groups.size?[...groups].map(([category,rows])=>'<section class="group"><h2><input type="checkbox" data-group="'+esc(category)+'" aria-label="选择'+esc(category)+'" '+(rows.length&&rows.every(l=>selected.has(String(l.lineId)))?'checked':'')+'>'+esc(category)+' <small>'+rows.length+' 条</small></h2>'+rows.map(l=>{const id=String(l.lineId);const project=assignments[id];return '<div class="expense"><input type="checkbox" data-line="'+esc(id)+'" aria-label="选择明细 '+esc(id)+'" '+(selected.has(id)?'checked':'')+'><div><strong>'+esc(lineDate(l.date,l.checkOut))+' · '+esc(l.city||l.kindLabel||'—')+'</strong><p>'+esc(l.route||l.fileName||'—')+'</p><p class="meta">'+esc(l.maskedNumber||'—')+' · '+esc(l.fileName||'—')+'</p><p class="assignment">'+esc(project?(projectName(project)||project):'未归属')+'</p></div><strong class="amount">'+esc(l.totalAmount??'—')+' 元</strong></div>'}).join('')+'</section>').join(''):'<p class="empty">没有可显示的费用明细</p>';
const used=[...new Set(Object.values(assignments).filter(Boolean))];el('used').innerHTML=used.map(number=>projectButton(number,projectName(number))).join('')||'<p class="empty">暂无</p>';
el('projects').innerHTML=displayedProjects.filter(p=>!used.includes(p.number)).map(p=>projectButton(p.number,p.name)).join('')||'<p class="empty">没有匹配的可选项目</p>';
el('selected').textContent='已选 '+selected.size+' 条 · '+money(selectedLines())+' 元';const assigned=Object.values(assignments).filter(Boolean).length;el('summary').textContent='已归属 '+assigned+' / '+lines.length+' 条 · 合计 '+money(lines)+' 元';el('submit').disabled=assigned!==lines.length||!el('purpose').value.trim()||!!pendingProject||inFlight;
const shown=visible();el('all').checked=shown.length>0&&shown.every(l=>selected.has(String(l.lineId)));el('all').indeterminate=shown.some(l=>selected.has(String(l.lineId)))&&!el('all').checked;for(const box of document.querySelectorAll('[data-group]')){const rows=groups.get(box.dataset.group)||[];box.indeterminate=rows.some(l=>selected.has(String(l.lineId)))&&!box.checked;}
}
function apply(number,onlyEmpty){if(!number||!allowedProjects.has(number))return;for(const id of selected)if(!onlyEmpty||!assignments[id])assignments[id]=number;selected.clear();closeConflict();render();}
document.addEventListener('change',event=>{const target=event.target;if(target.dataset.line){const id=target.dataset.line;target.checked?selected.add(id):selected.delete(id);}else if(target.dataset.group||target.id==='all'){for(const line of visible().filter(l=>!target.dataset.group||String(l.categoryLabel||'费用类别待确认')===target.dataset.group)){target.checked?selected.add(String(line.lineId)):selected.delete(String(line.lineId));}}else if(target.id==='unassigned'){selected.clear();}closeConflict();render();});
document.addEventListener('click',event=>{const button=event.target.closest('[data-project]');if(!button||button.disabled)return;const number=String(button.dataset.project);if(!allowedProjects.has(number)||!selected.size)return;const conflicts=[...selected].filter(id=>assignments[id]&&assignments[id]!==number);if(conflicts.length){pendingProject=number;el('conflict-text').textContent=conflicts.length+' 条明细已有其他项目归属，请确认是否覆盖';el('conflict').hidden=false;render();}else apply(number,false);});
el('only-empty').onclick=()=>apply(pendingProject,true);el('overwrite').onclick=()=>apply(pendingProject,false);el('cancel').onclick=()=>{closeConflict();render()};el('purpose').oninput=render;
const localFilter=query=>{const q=query.trim().toLocaleLowerCase();return [...allowedProjects.values()].filter(p=>!q||String(p.number).toLocaleLowerCase().includes(q)||String(p.name??'').toLocaleLowerCase().includes(q));};
async function search(){const query=el('search').value;const turn=++searchSerial;if(!spec.searchProjectsEnabled){displayedProjects=localFilter(query);el('query-status').textContent=displayedProjects.length?'':'没有匹配的可选项目';render();return;}el('query-status').textContent='查询个人项目簿';try{const response=await fetch('/projects?nonce='+encodeURIComponent(nonce)+'&q='+encodeURIComponent(query));let result={};try{result=await response.json()}catch{}if(turn!==searchSerial)return;if(!response.ok)throw Error(result.error||'项目簿查询失败');const returned=Array.isArray(result.projects)?result.projects:[];displayedProjects=returned.map(p=>allowedProjects.get(String(p?.number??'').trim())).filter(Boolean);el('query-status').textContent=displayedProjects.length?(result.more?'结果超过 50 个，请缩小查找范围':''):'没有匹配的可选项目';render();}catch(error){if(turn!==searchSerial)return;displayedProjects=[];el('query-status').textContent=error.message||'项目簿查询失败';render();}}
el('search').oninput=()=>{clearTimeout(debounceTimer);debounceTimer=setTimeout(search,250)};
el('submit').onclick=async()=>{if(inFlight)return;const projects=Object.fromEntries(lines.map(l=>[String(l.lineId),assignments[String(l.lineId)]]));const missing=Object.values(projects).filter(v=>!v).length;const purpose=el('purpose').value.trim();if(missing||!purpose){el('error').textContent='报销事由和每一条明细的项目都要填写';return;}inFlight=true;el('error').textContent='';el('submit').disabled=true;try{const response=await fetch('/submit?nonce='+encodeURIComponent(nonce),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({homeCity:spec.homeCity,purpose,projects})});let result={};try{result=await response.json()}catch{}if(!response.ok||result.ok===false||result.result?.verdict==='rejected')throw Error(result.result?.reasons?.join('；')||result.error||'提交失败');el('summary').textContent='项目归属已确认';}catch(error){inFlight=false;el('error').textContent=error.message||'提交失败，请检查网络后重试';render();}};
render();search();
</script></body></html>`;
}

export const renderProjectWorkbench = renderSelectionPage;
