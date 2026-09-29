import { rows, type ParseDoc, type TextObservation } from './doc';
import type { ParseInput } from './material';
import { readDoc } from './media';
import type { DocReaders } from './readers';

// The snapshot adapter of the `DocReaders` port (`readers.ts`). A document snapshot is the `ParseDoc` a real material
// produced (text runs with their geometry, QR payloads), stored as JSON. It turns a misread into a committable
// regression case without the original file, and lets recognition tests run without pdfjs or OCR.
//
// Cases live in `snapshots/` as `<case>.doc.json` + `<case>.expected.json`; `snapshots.test.ts` runs them all. Capture
// one with the probe: `tsx scripts/probe-parse.ts --capture <case path> --redact <map.json> <file>`.

// Reads the stored document whichever medium is asked for, as long as it is the medium the snapshot was taken from.
export function snapshotReaders(doc: ParseDoc): DocReaders {
  const read = (medium: ParseDoc['mediaType']) => async () => {
    if (doc.mediaType !== medium) throw new Error(`the snapshot is a ${doc.mediaType} document, read as ${medium}`);
    return doc;
  };
  return { pdf: read('pdf'), image: read('image') };
}

// The document a material produces through `readers` (in practice the production readers), as plain data.
export async function captureDoc(input: Pick<ParseInput, 'fileName' | 'mime' | 'bytes'>, readers: DocReaders): Promise<ParseDoc> {
  const doc = await readDoc(input, readers);
  return {
    mediaType: doc.mediaType,
    pageCount: doc.pageCount,
    codes: [...doc.codes],
    observations: doc.observations.map(({ id, page, x, y, width, height, text, raw, score }) => ({ id, page, x, y, width, height, text, raw, ...(score === undefined ? {} : { score }) })),
  };
}

// Swaps every occurrence of each `map` key for its value, in the text runs and in the QR payloads, and keeps
// everything else: ids, pages, boxes, scores, the number and order of runs and codes. A QR payload keeps its field
// structure as long as neither side of an entry contains its separator.
//
// A value drawn across several runs of one visual row (a 发票号码 drawn one digit per run) is found in the row's
// joined text and swapped character by character, so every run keeps its own glyphs' boxes; its replacement must have
// the same length. Within one run any length goes. A run whose text changed has `raw` set to the new text.
//
// Throws when a key is still readable afterwards (in a run, a row, a page read as one string, or a payload): a value
// wrapped across rows, say. Split it into the parts each row prints and redact those; a partial redaction never
// leaves this function.
export function redactDoc(doc: ParseDoc, map: Readonly<Record<string, string>>): ParseDoc {
  const entries = Object.entries(map).sort(([a], [b]) => b.length - a.length);
  for (const [key] of entries) if (key.trim() === '') throw new Error('redactDoc: an empty key would match everywhere');
  const texts = doc.observations.map((o) => o.text);
  const index = new Map(doc.observations.map((o, i) => [o, i]));
  const lines: number[][] = [];
  for (let page = 1; page <= doc.pageCount; page += 1) for (const row of rows(doc, page)) lines.push(row.map((o) => index.get(o) ?? -1));

  for (const [key, value] of entries) {
    for (const line of lines) {
      // Occurrences left to right; runs edited right to left so earlier offsets stay valid.
      const joined = line.map((i) => texts[i] ?? '').join('');
      const edits: { run: number; at: number; length: number; text: string }[] = [];
      for (let start = joined.indexOf(key); start >= 0; start = joined.indexOf(key, start + key.length)) edits.push(...split(line, texts, start, key, value));
      for (const edit of edits.reverse()) {
        const text = texts[edit.run] ?? '';
        texts[edit.run] = text.slice(0, edit.at) + edit.text + text.slice(edit.at + edit.length);
      }
    }
  }

  const redacted: ParseDoc = {
    ...doc,
    codes: doc.codes.map((code) => entries.reduce((payload, [key, value]) => payload.split(key).join(value), code)),
    observations: doc.observations.map((o, i): TextObservation => {
      const text = texts[i] ?? o.text;
      return text === o.text ? o : { ...o, text, raw: text };
    }),
  };
  const left = entries.map(([key]) => key).filter((key) => readable(redacted, key));
  if (left.length > 0) throw new Error(`redactDoc: ${left.length} key(s) still readable after redaction (wrapped across rows?); redact the parts each row prints`);
  return redacted;
}

// The edits that replace `key` at `start` of a row's joined text: one per run it spans.
function split(line: readonly number[], texts: readonly string[], start: number, key: string, value: string) {
  const edits: { run: number; at: number; length: number; text: string }[] = [];
  let offset = 0;
  for (const run of line) {
    const length = (texts[run] ?? '').length;
    const from = Math.max(start, offset);
    const to = Math.min(start + key.length, offset + length);
    if (from < to) edits.push({ run, at: from - offset, length: to - from, text: '' });
    offset += length;
  }
  if (edits.length === 1 && edits[0]) edits[0].text = value;
  else {
    if (value.length !== key.length) throw new Error(`redactDoc: a value drawn across ${edits.length} runs needs a replacement of the same length (${key.length} characters)`);
    let taken = 0;
    for (const edit of edits) {
      edit.text = value.slice(taken, taken + edit.length);
      taken += edit.length;
    }
  }
  return edits;
}

function readable(doc: ParseDoc, key: string): boolean {
  const bare = key.replace(/\s+/g, '');
  if (doc.codes.some((code) => code.includes(key))) return true;
  if (doc.observations.some((o) => o.text.includes(key) || o.raw.includes(key))) return true;
  for (let page = 1; page <= doc.pageCount; page += 1) {
    const lines = rows(doc, page).map((row) => row.map((o) => o.text).join(''));
    if (lines.some((line) => line.includes(key))) return true;
    if (bare !== '' && lines.join('').replace(/\s+/g, '').includes(bare)) return true;
  }
  return false;
}

// One observation per line, so a snapshot diff reads run by run.
export function formatDocSnapshot(doc: ParseDoc): string {
  const list = (items: readonly unknown[]) => (items.length === 0 ? '[]' : `[\n${items.map((item) => `    ${JSON.stringify(item)}`).join(',\n')}\n  ]`);
  return `{\n  "mediaType": ${JSON.stringify(doc.mediaType)},\n  "pageCount": ${doc.pageCount},\n  "codes": ${list(doc.codes)},\n  "observations": ${list(doc.observations)}\n}\n`;
}

export function parseDocSnapshot(json: string): ParseDoc {
  const doc = JSON.parse(json) as Partial<ParseDoc>;
  if ((doc.mediaType !== 'pdf' && doc.mediaType !== 'image') || typeof doc.pageCount !== 'number' || !Array.isArray(doc.codes) || !Array.isArray(doc.observations)) {
    throw new Error('not a document snapshot: expected { mediaType, pageCount, codes, observations }');
  }
  return doc as ParseDoc;
}
