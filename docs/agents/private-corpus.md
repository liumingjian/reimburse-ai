# The private corpus (`pnpm test:private`)

Real materials are never committed. They live only on the maintainer's machine, and `pnpm test:private`
(`server/src/quality/private-gate.ts`) measures the rule parsers against them there. Without the corpus the command
prints one skip line and exits 0, so CI and every other machine stay unaffected.

## Setting it up

1. Pick a directory outside the repository, e.g. `~/Documents/baox-private-corpus`.
2. Put every material under `<kind>/<layout>/`, the same ids the registry uses
   (`server/src/parse/layouts/index.ts`) — e.g. `vat_invoice/einvoice/`, `rail_ticket/12306/`,
   `ride_itinerary/amap/`, `hotel_folio/labelled/`. Accepted extensions: `.pdf`, `.jpg`, `.jpeg`, `.png`.
   A file that must match **no** layout goes under `unrecognised/` instead. Anything outside these two shapes is
   counted as ignored and measured by nothing.
3. Beside a material, optionally add `<file>.expected.json` — a flat `{"<slot key>": "<value>"}` map of the fields
   that matter, written exactly as the layout emits them (`"totalAmount": "314.50"`, `"travelDate": "2026-08-23"`).
   Keys are the layout's own slot keys; leg fields are `segments[0].amount` and so on.
4. Run it:

   ```sh
   BAOX_PRIVATE_CORPUS=~/Documents/baox-private-corpus pnpm test:private
   ```

## What it gates

Per layout and medium: the share of files recognised by that layout, the share of files whose sidecar declares every
key `REQUIRED_EXPECTATIONS` asks that layout for, and per expected key the share read exactly right.

"Read" means the layout's own read: the value `factsOf` (`server/src/parse/facts.ts`) picks, counted only when the
face or a derivation of the layout supplied it. A value that only a second source, such as the QR code of a
fully-digitalised VAT e-invoice (全电发票), filled in is shown in the app but scores as unread. So a face-rule
regression on a field the QR also carries still fails the gate.

The middle row
(`(expectations)`) exists because the gate scores only what a sidecar declares: #199 shipped with 8 of 10 real 全电发票
faces whose item table went unread while every scored field was green, because no sidecar named 项目名称, 不含税金额
or 税额. Adding a sample means writing its required keys down, or the gate fails.

Derive each expected value from the source document itself — its own text and layout — and never from the parser's
output. An expectation taken from the code under test proves nothing. When a value cannot be established
independently, leave the key out and say so rather than guessing. Floors live in `THRESHOLDS`: text-layer PDFs must be 100% recognised and 100% right per field — a rule is
deterministic, so a miss on a real file is a rule bug, not noise — and OCR images at least 98%.

## Why the output is safe to paste

The report is aggregate only: layout ids, media, slot keys and counts. A file name is handed to the parser (a layout
may look at it) but never printed, and no field value is ever printed. `server/src/quality/private-gate.test.ts` pins
that guarantee with a corpus whose file name and field values are unique strings, and fails if either appears in the
report.

Expectation sidecars carry real values, so they belong in the corpus directory next to the materials — never in the
repository, and never in an issue, a commit message or a test receipt.

## Turning a private misread into a committed case

A misread found here becomes a regression case in `server/src/parse/snapshots/` without committing the file:

```sh
pnpm --filter @baox/server exec tsx scripts/probe-parse.ts \
  --capture src/parse/snapshots/<case> --redact <map.json> <file>
```

`<map.json>` is a flat `{"<as printed>": "<replacement>"}` map of every personal or real value on the face; a value
drawn across several text runs needs a replacement of the same length. The probe refuses to write a snapshot in which a
mapped value is still readable. Keep `<map.json>` out of the repository, then write `<case>.expected.json` by hand
(same rule as above: from the document, with the redacted values). `server/src/parse/snapshots.test.ts` runs every case.
