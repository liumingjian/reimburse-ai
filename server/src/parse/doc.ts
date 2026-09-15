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
