// The one input model every layout parser reads (ADR-0017): positioned 文字观测 (text observations) plus the decoded
// QR / barcode payloads of the material. The PDF adapter (`pdf.ts`, unpdf) fills it today; the OCR adapter (#186) fills
// the same shape from a corrected photo, so a layout never knows where its text came from.

export type TextObservation = {
  // `p<page>.<n>`: stable within one document, used as evidence refs.
  id: string;
  // 1-based.
  page: number;
  // Lower-left corner in PDF user space (points, y grows upward). The OCR adapter converts to the same orientation.
  x: number;
  y: number;
  width: number;
  height: number;
  // NFKC-normalised and trimmed: full-width `（：￥` become `(:¥`. Match anchors against this.
  text: string;
  // As read, for display in evidence.
  raw: string;
  // OCR only (#186): the recogniser's score stays on the observation; candidates carry no confidence.
  score?: number;
};

export type ParseDoc = {
  mediaType: 'pdf' | 'image';
  pageCount: number;
  observations: readonly TextObservation[];
  // Decoded QR / barcode payloads in reading order; empty when nothing was decodable.
  codes: readonly string[];
};

export function normalise(text: string): string {
  return text.normalize('NFKC').trim();
}

// Text without any whitespace: anchors ignore letter-spacing such as `电 子 发 票`.
export function compact(text: string): string {
  return text.replace(/\s+/g, '');
}

// Observations grouped into visual rows (same page, baselines within `tolerance` points), top to bottom, each row
// left to right.
export function rows(doc: ParseDoc, page = 1, tolerance = 3): TextObservation[][] {
  const sorted = doc.observations.filter((o) => o.page === page).sort((a, b) => b.y - a.y || a.x - b.x);
  const out: TextObservation[][] = [];
  for (const observation of sorted) {
    const row = out[out.length - 1];
    const anchor = row?.[0];
    if (row && anchor && Math.abs(anchor.y - observation.y) <= tolerance) row.push(observation);
    else out.push([observation]);
  }
  for (const row of out) row.sort((a, b) => a.x - b.x);
  return out;
}

// One visual row read as a single string. Real PDFs split a line into several text runs — a label and its value, a
// table cell, sometimes one run per glyph — so a layout matches its hard anchors against this joined text instead of
// against one observation (ADR-0017: the haystack widens, the patterns stay fully anchored).
export type JoinedRow = {
  page: number;
  // Baseline of the row in PDF user space, for callers that relate rows to each other.
  y: number;
  // The row's observations left to right, joined and compacted the same way anchors are. Match against this.
  text: string;
  // The contributing observations, left to right, each with its id: evidence refs keep naming real text runs, and a
  // caller that needs columns (itinerary cells) buckets these by x.
  observations: readonly TextObservation[];
};

// The joined-row view of a page: `rows()` seen as text. Raw observations stay available; this derives from them.
export function joinedRows(doc: ParseDoc, page = 1, tolerance = 3): JoinedRow[] {
  return rows(doc, page, tolerance).map((row) => ({
    page,
    y: row[0]?.y ?? 0,
    text: compact(row.map((o) => o.text).join('')),
    observations: row,
  }));
}

// A contiguous run of one row's observations, read as a single string. A face that prints two labelled fields side by
// side (the 铁路电子客票 box: `乘车日期：…` next to `开车时间：…`) and splits a label from its value gives an anchor
// neither a single observation nor the whole joined row to match: the span is the haystack that holds both.
export type RowSpan = {
  page: number;
  y: number;
  // The span's observations joined and compacted, the same way `JoinedRow.text` is.
  text: string;
  observations: readonly TextObservation[];
};

// How wide a span may get. The widest anchor in this repo is a 20-digit 发票号码 (invoice number) drawn one digit per
// text run behind its label, and no field on a v1 face is longer than a company name. Without a cap, a row's spans are
// n(n+1)/2 strings of O(n^3) characters in total, and an anchor that is simply absent — a normal case — enumerates all
// of them; row width comes from the uploaded file, and OCR puts many small boxes on one baseline.
const MAX_SPAN_RUNS = 24;
const MAX_SPAN_CHARS = 64;
// How far apart two text runs may be drawn and still be read as one field, as a multiple of the text height. The
// glyphs of one field are drawn edge to edge and a label sits a few points from its value, while the field printed
// beside them on the same baseline is a column away.
const BLOCK_GAP = 1.5;

const spanOf = (row: JoinedRow, start: number, size: number): RowSpan => {
  const observations = row.observations.slice(start, start + size);
  return { page: row.page, y: row.y, text: compact(observations.map((o) => o.text).join('')), observations };
};

// Every contiguous span of a row, shortest first, then left to right — so an anchor binds to the narrowest run of text
// that satisfies it rather than swallowing the field printed beside it.
export function spans(row: JoinedRow): RowSpan[] {
  const out: RowSpan[] = [];
  const widest = Math.min(row.observations.length, MAX_SPAN_RUNS);
  for (let size = 1; size <= widest; size += 1) {
    for (let start = 0; start + size <= row.observations.length; start += 1) {
      const span = spanOf(row, start, size);
      if (span.text.length <= MAX_SPAN_CHARS) out.push(span);
    }
  }
  return out;
}

// Every span of one visual block of a row that begins at `start`, **widest first**. The start is pinned and the block
// ends where a gap opens, so a caller that reads what is printed right after a label takes the whole of it and nothing
// else: a glyph-by-glyph `¥560.00` has sub-runs (`0.00`, `60.00`) that read as an amount too, and the narrowest of
// them is never the value on the face (ADR-0017: a face fact is read, never inferred); the 销售方 box printed to the
// right of the 购买方 box is not part of the buyer's name either.
export function spansAt(row: JoinedRow, start: number): RowSpan[] {
  const runs = row.observations;
  let widest = 0;
  while (start + widest < runs.length && widest < MAX_SPAN_RUNS) {
    const current = runs[start + widest];
    if (!current) break;
    const previous = runs[start + widest - 1];
    if (previous && current.x - (previous.x + previous.width) > Math.max(previous.height, current.height) * BLOCK_GAP) break;
    widest += 1;
  }
  const out: RowSpan[] = [];
  for (let size = widest; size >= 1; size -= 1) {
    const span = spanOf(row, start, size);
    if (span.text.length <= MAX_SPAN_CHARS) out.push(span);
  }
  return out;
}

// The first span, row by row, whose whole text matches `pattern`. The pattern stays fully anchored: only the haystack
// narrows (ADR-0017).
export function matchSpan(lines: readonly JoinedRow[], pattern: RegExp): { span: RowSpan; match: RegExpExecArray } | null {
  for (const row of lines) {
    for (const span of spans(row)) {
      const match = pattern.exec(span.text);
      if (match) return { span, match };
    }
  }
  return null;
}

// Like `matchSpan`, but among the spans that share a first observation it takes the widest match, not the narrowest.
// `matchSpan` is right for a fixed-length anchor (`^发票号码:(\d{20})$`), where the narrowest match is the whole field.
// It is wrong for a label followed by free text (`^席别:(.+)$`): there the narrowest match is the value's first text
// run — one character on a face that draws its values glyph by glyph.
export function matchWidestSpan(lines: readonly JoinedRow[], pattern: RegExp): { span: RowSpan; match: RegExpExecArray } | null {
  for (const row of lines) {
    for (let start = 0; start < row.observations.length; start += 1) {
      for (const span of spansAt(row, start)) {
        const match = pattern.exec(span.text);
        if (match) return { span, match };
      }
    }
  }
  return null;
}

// Money as integer cents, so sums conserve exactly. Accepts `¥3,433.96`, `-1.94`; null when not a 2-decimal amount.
export function cents(text: string): number | null {
  const match = /^¥?(-)?(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})$/.exec(compact(text));
  if (!match) return null;
  const value = Number((match[2] ?? '').replace(/,/g, '')) * 100 + Number(match[3]);
  return match[1] ? -value : value;
}

export function money(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const DAY_MS = 86_400_000;
// Whole days from one `YYYY-MM-DD` date to another (a stay's nights).
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
