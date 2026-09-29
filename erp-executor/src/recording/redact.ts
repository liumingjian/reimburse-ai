// Turns a captured live page into a committable fixture: redacted HTML the fake ERP serves, plus the page facts that
// live outside the DOM. Redaction keeps structure and drops values:
//   - the ERP identity (显示名, account, 账套) becomes a placeholder the fake fills in: {{DISPLAY_NAME}} {{ACCOUNT}}
//     {{TENANT}}, wherever it appears (text, attributes, input values, localStorage);
//   - every digit in text and in value-like attributes becomes `0`, so dates, amounts, bill numbers and phone
//     numbers keep their shape and lose their value. Ids and classes keep their digits (a form instance's UUID is
//     what groups a header field's nodes); the ERP build is kept verbatim (it is the compatibility fingerprint);
//   - every non-empty input value is masked whole: an editor holds data, never UI vocabulary;
//   - text under a node a mask rule names is masked whole: `K3CLOUD_MASKS` for the value displays every K3Cloud page
//     has, plus the flow's own `mask` (lists, widgets that show other people's work);
//   - e-mail addresses are replaced.
// `findLeaks` is the last line: the recorder refuses to write anything that still contains a secret.

import type { CapturedNode, CapturedPage } from './capture';

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
 */
export const K3CLOUD_MASKS: readonly MaskRule[] = [hasClass('ui-poplistedit-displayname'), gridValue, hasClass('kd_top_k3cloud_datacenter'), hasId('datacenter_ct')];

export type RedactOptions = { secrets: Secrets; keep?: readonly string[]; mask?: readonly MaskRule[] };

export type RecordedPageFacts = {
  url: string; title: string; viewport: CapturedPage['viewport']; resVer: string | null;
  loginInfo: Record<string, string> | null; frames: CapturedPage['frames']; count: number; pruned: number;
};

const PLACEHOLDERS = [['displayName', '{{DISPLAY_NAME}}'], ['account', '{{ACCOUNT}}'], ['tenant', '{{TENANT}}']] as const;
const MASK = '＊';
/** Attributes that name structure, not values: their digits are kept (a form instance's UUID, a column span). */
const STRUCTURAL = new Set(['id', 'class', 'for', 'data-kdformid', 'colspan', 'rowspan', 'tabindex']);
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
    if (STRUCTURAL.has(name)) return identity(raw);
    if (name === 'value') return value(raw);
    return text(raw);
  };

  const maskedText = (s: string) => (s.trim() ? MASK.repeat(Math.min([...s.trim()].length, 8)) : s);

  function html(node: CapturedNode, ancestors: CapturedNode[] = [], masked = false): string {
    const hide = masked || mask.some((rule) => rule(node, ancestors));
    const attrs = Object.entries(node.a).map(([name, raw]) => ` ${name}="${escape(hide && name !== 'id' && name !== 'class' ? maskedText(raw) : attribute(name, raw))}"`).join('');
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

  return { text, value, identity, page };
}

/** Which secrets `output` still contains, by name only: the values themselves are never reported. */
export function findLeaks(output: string, secrets: Secrets): string[] {
  const lower = output.toLowerCase();
  return (Object.entries(secrets) as Array<[string, string | undefined]>)
    .filter(([, value]) => !!value && value.trim().length >= 2 && lower.includes(value.trim().toLowerCase()))
    .map(([name]) => name);
}
