import { compact, rows, type ParseDoc, type TextObservation } from '../doc';

// The 行程单 leg table, read from positioned text observations (PDF text layer or OCR alike). Shared by the
// `ride_itinerary` layouts; it knows tables, not brands: a layout passes the column patterns, the columns a header must
// carry to count, the column whose numeric cells anchor the legs, and which columns may wrap. Titles, summaries and
// amount formats stay in the layout.
//
// How a table is read:
// - The header is the first row (in page order, top to bottom) whose cells match the required columns.
// - Every observation below the header belongs to the header column whose centre is nearest (within the midpoints to
//   its neighbours).
// - Each numeric cell in the index column anchors one leg. A leg's band runs from midway to the leg above (or to the
//   header) down to midway to the leg below; the last leg's band reaches half a pitch below its baseline.
// - A wrapping column takes every observation in the band, so a cell printed on two lines reads as one value. Any other
//   column takes only the observations on the leg's own baseline, so a neighbouring row can never drift into it.
// - A cell is read top to bottom, left to right, and cut where the text stops being continuous (see `continuous`).

export type ItineraryTableSpec<C extends string> = {
  // Header cell patterns, matched against one compacted text run each.
  columns: readonly (readonly [RegExp, C])[];
  // The columns a header row must carry to count as the table header.
  required: readonly C[];
  // The column whose numeric cells (`1`, `2`, ...) anchor the legs.
  index: C;
  // The columns whose cells may wrap onto the lines below, within the leg's band.
  wrapping: ReadonlySet<C>;
};

// One leg row: its printed 序号 and the observations of each other column, top to bottom. A column with nothing in the
// leg's band is absent.
export type ItineraryLeg<C extends string> = { index: number; cells: Partial<Record<C, TextObservation[]>> };

export type ItineraryTable<C extends string> = {
  // Whether the document carries the table header: a recognition anchor.
  hasHeader(doc: ParseDoc): boolean;
  // The legs in printed order; none when there is no header.
  legs(doc: ParseDoc): ItineraryLeg<C>[];
};

// How far below the line above it a wrapped line may sit, as a multiple of the text height. A continuation line
// follows within about one line height; a wider gap is not a continuation.
const CONTINUATION_GAP = 1.8;
// How far from a leg's baseline a non-wrapping cell may sit, in points.
const BASELINE_TOLERANCE = 3;

const center = (o: TextObservation) => o.x + o.width / 2;

// A cell read as one string: its observations joined and compacted the way anchors are matched everywhere else, so a
// cell that wrapped onto a second line reads as a single value.
export const cellText = (list: readonly TextObservation[] | undefined): string => compact((list ?? []).map((o) => o.text).join(''));
// A cell's printed text, for a fact value: each observation's raw text compacted, joined. Null for an empty cell.
export const cellRaw = (list: readonly TextObservation[] | undefined): string | null => (list ?? []).map((o) => compact(o.raw)).join('') || null;

type Header<C extends string> = { y: number; page: number; columns: { key: C; center: number }[] };

export function itineraryTable<C extends string>(spec: ItineraryTableSpec<C>): ItineraryTable<C> {
  const header = (doc: ParseDoc): Header<C> | null => {
    for (let page = 1; page <= doc.pageCount; page += 1) {
      for (const row of rows(doc, page)) {
        const columns = row.flatMap((o) => {
          const key = spec.columns.find(([pattern]) => pattern.test(compact(o.text)))?.[1];
          return key ? [{ key, center: center(o) }] : [];
        });
        if (spec.required.every((key) => columns.some((c) => c.key === key))) return { y: row[0]?.y ?? 0, page, columns };
      }
    }
    return null;
  };

  return {
    hasHeader: (doc) => header(doc) !== null,
    legs(doc) {
      const head = header(doc);
      return head ? legsBelow(doc, head, spec) : [];
    },
  };
}

// The column an observation belongs to: the header whose centre is nearest, within the midpoints to its neighbours.
function columnOf<C extends string>(head: Header<C>, o: TextObservation): C | null {
  const sorted = [...head.columns].sort((a, b) => a.center - b.center);
  const x = center(o);
  for (let i = 0; i < sorted.length; i += 1) {
    const col = sorted[i];
    if (!col) continue;
    const left = i === 0 ? -Infinity : ((sorted[i - 1]?.center ?? 0) + col.center) / 2;
    const right = i === sorted.length - 1 ? Infinity : (col.center + (sorted[i + 1]?.center ?? 0)) / 2;
    if (x >= left && x < right) return col.key;
  }
  return null;
}

// A cell read top to bottom, cut where the text stops being continuous. A wrapped cell's lines follow each other about
// one line height apart; anything separated by a wider gap is not part of it. The last leg has no next row to bound
// its band, and the right-most column has no right bound either, so without this cut a table total or a right-aligned
// note printed under the table joins that leg's last cell.
function continuous(list: readonly TextObservation[]): TextObservation[] {
  const out: TextObservation[] = [];
  for (const o of list) {
    const previous = out.at(-1);
    if (previous && previous.y - o.y > Math.max(previous.height, o.height) * CONTINUATION_GAP) break;
    out.push(o);
  }
  return out;
}

// The legs printed below one header, on the header's page.
function legsBelow<C extends string>(doc: ParseDoc, head: Header<C>, spec: ItineraryTableSpec<C>): ItineraryLeg<C>[] {
  const below = doc.observations.filter((o) => o.page === head.page && o.y < head.y - 2);
  const anchors = below.filter((o) => /^\d+$/.test(compact(o.text)) && columnOf(head, o) === spec.index).sort((a, b) => b.y - a.y);
  return anchors.map((anchor, i) => {
    const previous = anchors[i - 1];
    const next = anchors[i + 1];
    const pitch = previous ? previous.y - anchor.y : head.y - anchor.y;
    const top = previous ? (previous.y + anchor.y) / 2 : (head.y + anchor.y) / 2;
    const bottom = next ? (anchor.y + next.y) / 2 : anchor.y - pitch / 2;
    const cells: ItineraryLeg<C>['cells'] = {};
    for (const o of below) {
      const column = columnOf(head, o);
      if (!column || column === spec.index) continue;
      const inRow = spec.wrapping.has(column) ? o.y <= top && o.y > bottom : Math.abs(o.y - anchor.y) <= BASELINE_TOLERANCE;
      if (inRow) (cells[column] ??= []).push(o);
    }
    for (const column of Object.keys(cells) as C[]) {
      const list = cells[column];
      if (!list) continue;
      list.sort((a, b) => b.y - a.y || a.x - b.x);
      cells[column] = continuous(list);
    }
    return { index: Number(compact(anchor.text)), cells };
  });
}
