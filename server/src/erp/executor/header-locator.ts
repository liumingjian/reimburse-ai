// The ONE rule for finding a header field (表头字段) of the 费用报销单, shared by the write path (`erpform.headerField`)
// and the read-only path (`reader.readHeaderField`).
//
// It used to be two rules, and they disagreed on the live ERP. Measured on the same document at the same instant,
// one open form instance `9484004c-…`:
//   headerField     FCAUSA -> {"ok":false,"reason":"表头字段 FCAUSA 有 2 个可见实例…","visibleInstances":2}
//   readHeaderField FCAUSA -> {"ok":true,"id":"9484004c-…-FCAUSA-EDITOR","visibleInstances":1,"visibleNodes":2}
// One form renders a wrapper `<div id="<uuid>-FCAUSA">` AND an `-EDITOR` control under the same form prefix, so
// counting raw visible NODES counts one form twice and refuses every header field on the page — including the one
// the read path had just read. What distinguishes two forms is the form-instance UUID prefix, not the node count,
// so the nodes are grouped by that prefix and the groups are counted.
//
// Fail-closed, as `save-contract.md` requires: zero visible groups would fall back to a stale hidden form, more than
// one group would be a guess about which 单 is being written to, and an ambiguous control inside the one group is
// refused rather than picked. `scroll` is for writes only — the reconcile probe must have no side effects.

import { HIT_JS, type Reach } from './hit';

export type HeaderField = Partial<Reach> & {
  ok: boolean; reason?: string; id?: string; instance?: string; tag?: string;
  instances?: number; visibleInstances?: number; visibleNodes?: number;
  focused?: boolean; value: string; x: number; y: number;
};

export const headerFieldSnippet = (key: string, { scroll = false } = {}) => `(() => {
  const key = ${JSON.stringify(key)};
  const fieldSuffix = '-' + key;
  const editorSuffix = fieldSuffix + '-EDITOR';
  const all = [...document.querySelectorAll('[id]')]
    .filter((n) => n.id.endsWith(fieldSuffix) || n.id.endsWith(editorSuffix));
  if (all.length === 0) return { ok: false, reason: '页面上找不到表头字段 ' + key };
  const showing = (x) => {
    const b = x.getBoundingClientRect();
    const st = getComputedStyle(x);
    return b.width > 0 && b.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const visible = all.filter(showing);
  if (visible.length === 0) return { ok: false,
    reason: '表头字段 ' + key + ' 没有可见实例', instances: all.length, visibleInstances: 0 };
  const instanceOf = (n) => n.id.endsWith(editorSuffix)
    ? n.id.slice(0, -editorSuffix.length) : n.id.slice(0, -fieldSuffix.length);
  const groups = new Map();
  for (const n of visible) {
    const instance = instanceOf(n);
    const group = groups.get(instance) ?? [];
    group.push(n);
    groups.set(instance, group);
  }
  if (groups.size > 1) return { ok: false,
    reason: '表头字段 ' + key + ' 有 ' + groups.size + ' 个可见表单实例，认不出是哪一张单的',
    instances: all.length, visibleInstances: groups.size, visibleNodes: visible.length };
  const [instance, group] = groups.entries().next().value;
  const editors = group.filter((x) => x.id.endsWith(editorSuffix));
  if (editors.length > 1) return { ok: false,
    reason: '表头字段 ' + key + ' 的同一表单实例有 ' + editors.length + ' 个可见编辑控件，拒绝猜测',
    instances: all.length, visibleInstances: groups.size, visibleNodes: visible.length };
  const n = editors[0] || group[0];
  if (${scroll ? 'true' : 'false'}) n.scrollIntoView({ block: 'center', inline: 'nearest' });
  const nestedInputs = n.matches('input,textarea') ? [n] : [...n.querySelectorAll('input,textarea')];
  if (nestedInputs.length > 1) return { ok: false,
    reason: '表头字段 ' + key + ' 的可见编辑控件不唯一，拒绝猜测',
    instances: all.length, visibleInstances: groups.size, visibleNodes: visible.length };
  const input = nestedInputs[0] || null;
  const t = input || n;
  const a = document.activeElement;
  // Where to click it AND what a mouse event there would actually reach. The second half is why: live 2026-09-19
  // the 处理结果 window floated over this very field at z-index 10005 with no 遮罩, elementFromPoint(371, 334)
  // answered a SPAN「接收发票」 inside the report, and the write blamed the control for not taking focus.
  // Read-only, so the reconcile probe may ask it too.
  return { ok: true, id: n.id, instance, tag: t.tagName,
    instances: all.length, visibleInstances: groups.size, visibleNodes: visible.length,
    focused: a === t || (n.contains(a) && a !== n),
    value: String(input ? input.value : n.innerText).replace(/\\s+/g, ' ').trim(),
    ...(${HIT_JS})(t) };
})()`;
