import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { ParseOutcome } from '../parse/dispatch';
import { factsOf, type Facts } from '../parse/facts';
import type { ParseInput } from '../parse/material';
import { storedMime } from '../upload-rules';

// Slice 16 (#196): parser quality gates on the private sample corpus, which lives only on the maintainer's mac
// (`BAOX_PRIVATE_CORPUS`). Replaces #14's model-quality metrics for the rule parsers (ADR-0017).
//
// Corpus layout under the root:
//   <kind>/<layout>/<file>.(pdf|jpg|jpeg|png)   expected to be recognised by that layout
//   <kind>/<layout>/<file>.expected.json       optional `{ "<slot key>": "<value>" }` for field accuracy
//   unrecognised/<file>                         expected to match no layout
//
// The report is aggregate only: layout ids, media, slot keys and counts. It never contains a file name, a path or a
// field value, so it is safe to paste anywhere (pinned by `private-gate.test.ts`).

export type Medium = 'pdf' | 'image';
export type Threshold = { recognition: number; field: number };

// Minimum share per layout and medium. Derivation (#147 OCR parity spike, recorded in the #196 PR):
// - pdf: text-layer extraction matched the kernel on every fixture and every private PDF, amounts identical, and QR
//   agreed with the text layer 3/3. The layouts are deterministic rules over exact text, so any miss is a rule bug: 100%.
// - image: OCR had key fields identical to Python RapidOCR 13/13 and perspective kept 2/2 fields, but only on generated
//   taxi photos. OCR reads are not exact, so the floor is #14's carried field-level gate: 98%.
export const THRESHOLDS: Readonly<Record<Medium, Threshold>> = {
  pdf: { recognition: 1, field: 1 },
  image: { recognition: 0.98, field: 0.98 },
};

// Slot keys every sample of a layout has to be written down for. The gate scores what a sidecar declares and nothing
// else, so a field nobody wrote down is a field it cannot see: #199 shipped with 8 of 10 real 全电发票
// (fully-digitalised VAT e-invoice) faces whose 项目名称 (item name), 不含税金额 (net amount) and 税额 (tax amount)
// went unread while this gate reported every einvoice sample right, because no expectation named those keys. A
// sample that does not declare them is a hole in the gate, so it is reported as a failure rather than passed over.
// A layout absent from this map declares whatever its sidecars happen to carry.
export const REQUIRED_EXPECTATIONS: Readonly<Record<string, readonly string[]>> = {
  'vat_invoice/einvoice': ['invoiceNumber', 'issueDate', 'itemName', 'netAmount', 'taxAmount', 'totalAmount'],
  // #210: an itinerary is the only place a ride-hailing invoice's expense city can come from, and its 合计 is what
  // pairs it with that invoice. A sidecar naming neither a leg's 城市 nor the header could not see that every real
  // ride invoice was reaching no line at all, so both are required.
  'ride_itinerary/amap': ['applyDate', 'segmentCount', 'itineraryTotal', 'segments[0].city'],
  'ride_itinerary/didi': ['applyDate', 'segmentCount', 'itineraryTotal', 'segments[0].city'],
  // #212: a folio exists to prove a hotel invoice's stay dates. Both folio photos reached no layout while every scored
  // row stayed green, because no folio sample was in the corpus at all; a folio sample must write both dates down.
  'hotel_folio/labelled': ['checkIn', 'checkOut'],
  // ADR-0032: a screenshot is placed with its stay by its date and counted by its amount.
  'payment_screenshot/labelled': ['amount', 'payDate'],
};

export type CorpusParser = (input: ParseInput) => Promise<ParseOutcome>;
export type GateOptions = { parse?: CorpusParser; out?: (line: string) => void; thresholds?: Readonly<Record<Medium, Threshold>>; required?: Readonly<Record<string, readonly string[]>> };

const MEDIA: Readonly<Record<string, Medium>> = { '.pdf': 'pdf', '.jpg': 'image', '.jpeg': 'image', '.png': 'image' };

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (MEDIA[extname(entry.name).toLowerCase()]) yield path;
  }
}

type Tally = { hit: number; total: number };
type Group = { files: number; recognised: number; declared: number; otherLayout: number; unrecognised: number; ambiguous: number; failed: number; fields: Map<string, Tally> };
const emptyGroup = (): Group => ({ files: 0, recognised: 0, declared: 0, otherLayout: 0, unrecognised: 0, ambiguous: 0, failed: 0, fields: new Map() });

// A field is right when the layout itself read it (`factsOf` origin `face` or `derived`), the value equals the expected
// one, and the layout does not also read it another way: a conflicting read is not a correct read. A value only a
// second source (the e-invoice QR code) supplied does not count: the inventory view shows it, but the gate measures the
// layout's rules, and a face rule that stopped reading a field the QR carries would otherwise still pass.
function fieldRight(facts: Facts, key: string, expected: string): boolean {
  return facts.values[key] === expected && (facts.origins[key] === 'face' || facts.origins[key] === 'derived') && !facts.conflicts.includes(key);
}

async function evaluate(root: string, parse: CorpusParser, required: Readonly<Record<string, readonly string[]>>) {
  const groups = new Map<string, Group>();
  let ignored = 0;
  let unreadableExpectations = 0;
  for (const path of files(root)) {
    const parts = relative(root, path).split(sep);
    const medium = MEDIA[extname(path).toLowerCase()] ?? 'pdf';
    const layoutId = parts[0] === 'unrecognised' ? 'unrecognised' : parts.length >= 3 ? `${parts[0]}/${parts[1]}` : null;
    if (!layoutId) {
      ignored += 1;
      continue;
    }
    const id = `${layoutId}\t${medium}`;
    const group = groups.get(id) ?? emptyGroup();
    groups.set(id, group);
    group.files += 1;
    // The file name goes to the parser (some layouts may look at it) but never into the report. The MIME is the one an
    // upload stores; recognition sniffs the medium from the bytes either way.
    const fileName = parts[parts.length - 1] ?? '';
    const outcome = await parse({ materialId: 'private', fileName, mime: storedMime(fileName, ''), bytes: new Uint8Array(readFileSync(path)) });
    if (outcome.outcome === 'recognised') {
      if (`${outcome.kind}/${outcome.layout}` !== layoutId) {
        group.otherLayout += 1;
        continue;
      }
      group.recognised += 1;
      const sidecar = `${path}.expected.json`;
      if (!existsSync(sidecar)) continue;
      let expected: Record<string, string>;
      try {
        expected = JSON.parse(readFileSync(sidecar, 'utf8')) as Record<string, string>;
      } catch {
        unreadableExpectations += 1;
        continue;
      }
      if ((required[layoutId] ?? []).every((key) => (expected[key] ?? '') !== '')) group.declared += 1;
      const facts = factsOf(outcome);
      for (const [key, value] of Object.entries(expected)) {
        const tally = group.fields.get(key) ?? { hit: 0, total: 0 };
        group.fields.set(key, tally);
        tally.total += 1;
        if (fieldRight(facts, key, String(value))) tally.hit += 1;
      }
    } else if (outcome.outcome === 'unrecognised') {
      if (layoutId === 'unrecognised') group.recognised += 1;
      else group.unrecognised += 1;
    } else if (outcome.outcome === 'ambiguous') group.ambiguous += 1;
    else group.failed += 1;
  }
  return { groups, ignored, unreadableExpectations };
}

// The real recognition over the production readers, loaded only when the gate actually runs against a corpus.
async function productionParser(): Promise<CorpusParser> {
  const [{ parseMaterial }, { productionReaders }] = await Promise.all([import('../parse/material'), import('../parse/readers-production')]);
  return (input) => parseMaterial(input, productionReaders);
}

const pct = (share: number) => `${(share * 100).toFixed(1)}%`;

// Returns the exit code: 0 when every row meets its threshold (or the corpus is not configured), 1 otherwise.
export async function runPrivateGate(root: string | undefined, options: GateOptions = {}): Promise<number> {
  const out = options.out ?? ((line: string) => console.log(line));
  const thresholds = options.thresholds ?? THRESHOLDS;
  if (!root) {
    out('test:private skipped: BAOX_PRIVATE_CORPUS is not set.');
    return 0;
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    out('test:private: BAOX_PRIVATE_CORPUS is not a directory.');
    return 1;
  }
  const parse = options.parse ?? (await productionParser());
  const required = options.required ?? REQUIRED_EXPECTATIONS;
  const { groups, ignored, unreadableExpectations } = await evaluate(root, parse, required);

  let failures = 0;
  const row = (id: string, field: string, tally: Tally, floor: number) => {
    const share = tally.hit / tally.total;
    const ok = share >= floor;
    if (!ok) failures += 1;
    out([id, field, `${tally.hit}/${tally.total}`, pct(share), `>= ${pct(floor)}`, ok ? 'ok' : 'FAIL'].join('\t'));
  };

  out(['layout', 'medium', 'field', 'right', 'accuracy', 'threshold', 'verdict'].join('\t'));
  for (const [id, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const floor = thresholds[id.split('\t')[1] as Medium];
    row(id, '(recognition)', { hit: group.recognised, total: group.files }, floor.recognition);
    // Whether the samples are written down at all, before how well they are read: every recognised sample of a layout
    // with required keys has to declare all of them. Writing an expectation down is not a matter of OCR accuracy, so
    // this row's floor is the whole set on every medium.
    if ((required[id.split('\t')[0] ?? ''] ?? []).length > 0 && group.recognised > 0) row(id, '(expectations)', { hit: group.declared, total: group.recognised }, 1);
    for (const [key, tally] of [...group.fields.entries()].sort(([a], [b]) => a.localeCompare(b))) row(id, key, tally, floor.field);
    const misses = { 'other layout': group.otherLayout, unrecognised: group.unrecognised, ambiguous: group.ambiguous, failed: group.failed };
    const listed = Object.entries(misses).filter(([, n]) => n > 0);
    if (listed.length > 0) out(`  misses: ${listed.map(([what, n]) => `${what} ${n}`).join(', ')}`);
  }
  if (groups.size === 0) out('no samples found under <kind>/<layout>/ or unrecognised/');
  if (ignored > 0) out(`ignored ${ignored} file(s) outside <kind>/<layout>/ or unrecognised/`);
  if (unreadableExpectations > 0) {
    failures += 1;
    out(`FAIL: ${unreadableExpectations} expectation file(s) are not valid JSON`);
  }
  out(failures === 0 ? 'test:private: all gates met' : `test:private: ${failures} gate(s) below threshold`);
  return failures === 0 ? 0 : 1;
}
