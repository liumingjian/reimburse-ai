import { compact, type ParseDoc, type TextObservation } from '../doc';
import type { EvidenceRef } from '../layout';

// Reading a face through its field labels, shared by the layouts that read one (`hotel_folio/labelled`,
// `dining_receipt/labelled`). On a PDF a label and its value usually arrive as one text run, sometimes several fields
// to a run (`入住日期:…,房号:…`); on a photo they are separate boxes, so each value is read by position from its label.

// Where a value may sit relative to its label, as multiples of the label's own text height (a photo's pixel scale
// depends on the camera, a PDF's on the font): right of the label with its vertical centre within this band, else the
// box directly below the label with at most this gap. A folio's rows are about 1.1 text heights apart, so half a
// height keeps a value from binding to the label on the neighbouring row.
const ROW_BAND = 0.5;
const BELOW_GAP = 1;

export type Read = { text: string; raw: string; observations: TextObservation[] };

export const ref = (observations: readonly TextObservation[]): EvidenceRef[] =>
  observations.length ? [{ page: observations[0]?.page ?? 1, observationIds: observations.map((o) => o.id), text: observations.map((o) => o.raw).join(' ') }] : [];

const centre = (o: TextObservation) => o.y + o.height / 2;

// A reader over a layout's label table: each field under the labels a face prints for it, on NFKC text without
// whitespace; the first that a document carries is the one read.
export function labelReader<Field extends string>(labels: Readonly<Record<Field, readonly string[]>>) {
  const allLabels: readonly string[] = Object.values<readonly string[]>(labels).flat();

  // A run's `label:value` fields. It splits at a comma or semicolon that a label follows, so `入住日期:…,房号:1426` is
  // two fields and `消费合计:3,640.00` stays one.
  function fields(text: string): string[] {
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
      if (/[,;，；]/.test(text[i] ?? '') && allLabels.some((label) => text.startsWith(label, i + 1))) {
        out.push(text.slice(start, i));
        start = i + 1;
      }
    }
    return [...out, text.slice(start)];
  }

  // What a run carries under `label`: '' for the label alone, the value for the label, its colon and a value in one
  // field; null when the run does not carry it. A longer word that only starts with the label (`房号类型`) is not that
  // label.
  function carried(text: string, label: string): string | null {
    for (const field of fields(compact(text))) {
      if (field === label) return '';
      if (field.startsWith(label) && /^[:：]/.test(field.slice(label.length))) return field.slice(label.length + 1);
    }
    return null;
  }
  const carries = (o: TextObservation, label: string) => carried(o.text, label) !== null;
  const labelOf = (doc: ParseDoc, field: Field): { box: TextObservation; label: string } | undefined => {
    for (const label of labels[field]) {
      const box = doc.observations.find((o) => carries(o, label));
      if (box) return { box, label };
    }
    return undefined;
  };

  // A field's value: in the label's own run when OCR or the text layer kept them together; else the nearest box right
  // of the label within its row band; else the box directly below it within the gap. A box that is itself a label is
  // never a value.
  function valueOf(doc: ParseDoc, field: Field): Read | null {
    const found = labelOf(doc, field);
    if (!found) return null;
    const { box, label } = found;
    const rest = carried(box.text, label);
    if (rest) return { text: rest, raw: carried(box.raw, label) || rest, observations: [box] };
    const others = doc.observations.filter((o) => o !== box && o.page === box.page && !allLabels.some((l) => carries(o, l)));
    const right = others
      .filter((o) => o.x >= box.x + box.width && Math.abs(centre(o) - centre(box)) <= box.height * ROW_BAND)
      .sort((a, b) => a.x - b.x)[0];
    const below = others
      .filter((o) => {
        const gap = box.y - (o.y + o.height);
        return gap >= -box.height * ROW_BAND && gap <= box.height * BELOW_GAP && o.y < box.y && o.x < box.x + box.width && o.x + o.width > box.x;
      })
      .sort((a, b) => b.y - a.y)[0];
    const value = right ?? below;
    return value ? { text: compact(value.text), raw: compact(value.raw), observations: [box, value] } : null;
  }

  return { carries, labelOf, valueOf };
}

// The date shapes a labelled value may take. Each is fully anchored; a value matching none leaves the date missing —
// no looser pattern is tried after these, and the matched digits must still be a calendar date.
const DATE_SHAPES: readonly RegExp[] = [
  // ISO, as the PDF text layer prints it: 2026-08-09.
  /^(\d{4})-(\d{2})-(\d{2})$/,
  // Slashed: 2026/08/09 or 2026/8/9.
  /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/,
  // Dotted: 2026.08.09 or 2026.8.9.
  /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/,
  // Chinese: 2026年08月09日 or 2026年8月9日.
  /^(\d{4})年(\d{1,2})月(\d{1,2})日$/,
  // Compact digits: 20260809. Also how OCR returns an ISO date whose hyphens it did not see.
  /^(\d{4})(\d{2})(\d{2})$/,
  // An ISO date with the second hyphen unseen by OCR: 2026-0809.
  /^(\d{4})-(\d{2})(\d{2})$/,
  // An ISO date with the first hyphen unseen by OCR: 202608-09.
  /^(\d{4})(\d{2})-(\d{2})$/,
  // Hyphen then dot, with or without 日: 2026-9.16, 2026-9.16日.
  /^(\d{4})-(\d{1,2})\.(\d{1,2})日?$/,
];

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// A value in one of `DATE_SHAPES` that is a calendar date, as `YYYY-MM-DD`; null otherwise.
export function dateOf(text: string): string | null {
  for (const shape of DATE_SHAPES) {
    const match = shape.exec(text);
    if (!match) continue;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    return validDate(year, month, day) ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
  }
  return null;
}
