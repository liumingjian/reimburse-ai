// Turns a captured live page into a committable fixture: redacted HTML the fake ERP serves, plus the page facts that
// live outside the DOM. Redaction keeps structure and drops values:
//   - the ERP identity (display name (显示名), account, tenant (账套)) becomes a placeholder the fake fills in:
//     {{DISPLAY_NAME}} {{ACCOUNT}} {{TENANT}}, wherever it appears (text, attributes, input values, localStorage);
//   - every digit in text and in value-like attributes becomes `0`, so dates, amounts, bill numbers and phone
//     numbers keep their shape and lose their value. `STRUCTURAL` attributes (ids, classes, the attributes that
//     refer to ids, data-field and friends) and link paths are kept whole, masked subtree or not, because they are
//     what the executor's selectors read (a form instance's UUID is what groups a header field's nodes); the ERP build
//     is kept verbatim (it is the compatibility fingerprint);
//   - every non-empty input value is masked whole: an editor holds data, never UI vocabulary;
//   - text under a node a mask rule names is masked whole: `K3CLOUD_MASKS` for the value displays every K3Cloud page
//     has, plus the flow's own `mask` (lists, widgets that show other people's work);
//   - e-mail addresses are replaced.
// `findLeaks` is the last line: the recorder refuses to write anything that still contains a secret.

import { CLICK_MARK, type CapturedNode, type CapturedPage, type ClickTarget } from './capture';

export type Secrets = { displayName?: string | undefined; account?: string | undefined; tenant?: string | undefined; password?: string | undefined };

/** Matches a captured node whose text must be masked whole, given its ancestors (nearest last). */
export type MaskRule = (node: CapturedNode, ancestors: readonly CapturedNode[]) => boolean;

export const hasClass = (name: string): MaskRule => (node) => (node.a['class'] ?? '').split(/\s+/).includes(name);
export const hasId = (id: string): MaskRule => (node) => node.a['id'] === id;
const textOf = (node: CapturedNode): string => node.c.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');

/**
 * Grid columns whose cell text is an ERP option, not data: the 发票类型 a new 费用明细行 starts with (普通发票) is
 * what the fill reads and changes. Every other grid cell that holds words is masked; numbers keep their zeroed shape.
 */
export const GRID_OPTION_FIELDS: ReadonlySet<string> = new Set(['FINVOICETYPE']);
const gridValue: MaskRule = (node, ancestors) => hasClass('kd-grid-cellspan')(node, ancestors) &&!GRID_OPTION_FIELDS.has(node.a['data-field'] ?? '') && /\p{L}/u.test(textOf(node));

/**
 * Value displays that are plain text rather than an editor's value, found in the first live recording (2026-09-29):
 * a 选择类 (F7) field shows its value's name in `span.ui-poplistedit-displayname` next to the masked code (申请部门
 * showed the employee's team there), a grid cell shows its value in `span.kd-grid-cellspan` (a new 费用明细行's
 * 费用承担部门 is the same team), and the 数据中心 (data centre) name sits on the console's header button and in
 * the login page's data-centre picker.
 *
 * And, found in the #309 recordings: a list form (我的费用报销) shows the account's bills as rows of its `<uuid>-FLIST`
 * grid, every value cell carrying `data-rowid`, and its quick filter shows saved 方案 (filter schemes) by name, one of
 * which was named after the colleague who shared it. The console's main menu titles each category's (hidden) list
 * with the category name, and a customer's own category is named after the customer.
 */
const listRow: MaskRule = (node, ancestors) => 'data-rowid' in node.a && ancestors.some((a) => /-FLIST$/.test(a.a['id'] ?? ''));
export const K3CLOUD_MASKS: readonly MaskRule[] = [
  hasClass('ui-poplistedit-displayname'), gridValue, hasClass('kd_top_k3cloud_datacenter'), hasId('datacenter_ct'),
  listRow, hasClass('SchemeItemControlTemplate'), hasClass('SelectedSchemeItemControlTemplate'), hasClass('kd-tabsnewsyle-list'),
];

export type RedactOptions = { secrets: Secrets; keep?: readonly string[]; mask?: readonly MaskRule[] };

export type RecordedPageFacts = {
  url: string; title: string; viewport: CapturedPage['viewport']; resVer: string | null;
  loginInfo: Record<string, string> | null; frames: CapturedPage['frames']; count: number; pruned: number;
};

const PLACEHOLDERS = [['displayName', '{{DISPLAY_NAME}}'], ['account', '{{ACCOUNT}}'], ['tenant', '{{TENANT}}']] as const;
const MASK = '＊';
/**
 * Attributes that name structure, not values, kept whole (identities swapped, nothing else): element ids and the
 * attributes that refer to them, a grid cell's field key and row index, Kendo's element uids, spans and tab order.
 * The replay sees the selectors the live page offers, and one UUID reads the same in every attribute that carries it.
 */
export const STRUCTURAL: ReadonlySet<string> = new Set([
  'id', 'class', 'for', 'colspan', 'rowspan', 'tabindex',
  'data-kdformid', 'data-field', 'data-rowid', 'data-uid', 'data-kdid', 'data-arg', 'data-index', 'data-offset-index',
  'aria-activedescendant', 'aria-controls', 'aria-owns', 'aria-describedby', 'aria-labelledby',
]);
/**
 * Kept whole like `STRUCTURAL`: a link's path. The capture already cut every `href` down to its path (or its scheme),
 * so what is left names a page of the site (`/k3cloud/html5/dform.aspx`), not a value, and zeroing its digits would
 * make the replay's links point nowhere the live page does.
 */
export const structuralAttribute = (name: string): boolean => STRUCTURAL.has(name) || name === 'href';
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ESCAPES[c]!);
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function redactor({ secrets, keep = [], mask: flowMask = [] }: RedactOptions) {
  const mask = [...K3CLOUD_MASKS, ...flowMask];
  const identities = PLACEHOLDERS.flatMap(([key, placeholder]) => {
    const value = secrets[key]?.trim();
    return value ? [{ value, placeholder }] : [];
  }).sort((a, b) => b.value.length - a.value.length);
  const kept = [...new Set(keep.filter(Boolean))].sort((a, b) => b.length - a.length);
  // One pass: identities and kept tokens are left alone (identities swapped for their placeholder), the rest masked.
  const tokens = [...identities.map((i) => i.value), ...kept];
  const splitter = tokens.length ? new RegExp(`(${tokens.map(escapeRegExp).join('|')})`, 'gi') : null;
  const placeholderOf = (piece: string) => identities.find((i) => i.value.toLowerCase() === piece.toLowerCase())?.placeholder;

  /** Identity values swapped for placeholders; nothing else touched. For ids and classes. */
  const identity = (s: string) => (splitter ? s.split(splitter).map((piece, i) => (i % 2 ? placeholderOf(piece) ?? piece : piece)).join('') : s);

  /** Identities swapped, digits zeroed, e-mail addresses replaced. For text and value-like attributes. */
  const text = (s: string) => {
    const pieces = splitter ? s.split(splitter) : [s];
    return pieces.map((piece, i) => {
      if (i % 2) return placeholderOf(piece) ?? piece;
      return piece.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, 'someone@example.invalid').replace(/\d/g, '0');
    }).join('');
  };

  /** An editor's value: its identity placeholder when it is one, otherwise masked whole. */
  const value = (s: string) => {
    const trimmed = s.trim();
    if (!trimmed) return s;
    const placeholder = placeholderOf(trimmed);
    if (placeholder) return placeholder;
    return MASK.repeat(Math.min([...trimmed].length, 8));
  };

  const attribute = (name: string, raw: string) => {
    if (structuralAttribute(name)) return identity(raw);
    if (name === 'value') return value(raw);
    return text(raw);
  };

  const maskedText = (s: string) => (s.trim() ? MASK.repeat(Math.min([...s.trim()].length, 8)) : s);

  /** Whether a node's text and value attributes are masked whole: under a masked ancestor, or named by a mask rule. */
  const hidden = (node: CapturedNode, ancestors: readonly CapturedNode[], masked: boolean) => masked || mask.some((rule) => rule(node, ancestors));

  /** A node's text as the page's HTML shows it after redaction: masked subtrees masked, the rest as `text`. */
  const redactedText = (node: CapturedNode, ancestors: CapturedNode[], masked: boolean): string => {
    const hide = hidden(node, ancestors, masked);
    return node.c.map((child) => (typeof child === 'string' ? (hide ? maskedText(child) : text(child)) : redactedText(child, [...ancestors, node], hide))).join('');
  };

  function html(node: CapturedNode, ancestors: CapturedNode[] = [], masked = false): string {
    const hide = hidden(node, ancestors, masked);
    const attrs = Object.entries(node.a).map(([name, raw]) => ` ${name}="${escape(hide && !structuralAttribute(name) ? maskedText(raw) : attribute(name, raw))}"`).join('');
    const style = node.s ? ` style="${node.s}"` : '';
    const open = `<${node.t}${attrs} data-rec-box="${node.b.join(',')}"${style}>`;
    if (VOID.has(node.t)) return open;
    const inline = node.c.some((child) => typeof child === 'string');
    const inner = node.c.map((child) => (typeof child === 'string' ? escape(hide ? maskedText(child) : text(child)) : html(child, [...ancestors, node], hide)));
    return `${open}${inline ? inner.join('') : inner.map((part) => `\n${part}`).join('') + (inner.length ? '\n' : '')}</${node.t}>`;
  }

  function loginInfo(info: Record<string, unknown> | null): Record<string, string> | null {
    if (!info) return null;
    return Object.fromEntries(Object.entries(info).map(([key, raw]) => [key, placeholderOf(String(raw ?? '').trim()) ?? MASK]));
  }

  /** The page as fixture HTML, and its facts for the manifest. */
  function page(captured: CapturedPage, header: string): { html: string; facts: RecordedPageFacts } {
    const body = html(captured.body);
    return {
      html: `<!doctype html>\n<!--\n${header.replace(/--/g, '- -')}\n-->\n<html>\n<head><title>${escape(text(captured.title))}</title></head>\n${body}\n</html>\n`,
      facts: {
        url: captured.url, title: text(captured.title), viewport: captured.viewport, resVer: captured.resVer,
        loginInfo: loginInfo(captured.loginInfo), frames: captured.frames.map((frame) => ({ ...frame, path: identity(frame.path) })),
        count: captured.count, pruned: captured.pruned,
      },
    };
  }

  /** The text of the node that carries the click mark, redacted exactly as `html` redacts it; null without a mark. */
  function markedText(node: CapturedNode, ancestors: CapturedNode[] = [], masked = false): string | null {
    if (CLICK_MARK in node.a) return redactedText(node, ancestors, masked);
    const hide = hidden(node, ancestors, masked);
    for (const child of node.c) {
      if (typeof child === 'string') continue;
      const found = markedText(child, [...ancestors, node], hide);
      if (found !== null) return found;
    }
    return null;
  }

  /**
   * Where a click landed, for the manifest. Its text is read off the redacted page, not off the live `innerText`,
   * which also carries the text of masked descendants; without a mark on the page it is masked whole.
   */
  function click(captured: CapturedPage, target: ClickTarget) {
    const marked = markedText(captured.body);
    const clickText = marked === null ? maskedText(target.text) : marked.replace(/\s+/g, ' ').trim().slice(0, 60);
    return { tag: target.tag, id: identity(target.id), controlId: identity(target.controlId), text: clickText };
  }

  return { text, value, identity, page, click };
}

/** Which secrets `output` still contains, by name only: the values themselves are never reported. */
export function findLeaks(output: string, secrets: Secrets): string[] {
  const lower = output.toLowerCase();
  return (Object.entries(secrets) as Array<[string, string | undefined]>)
    .filter(([, value]) => !!value && value.trim().length >= 2 && lower.includes(value.trim().toLowerCase()))
    .map(([name]) => name);
}
