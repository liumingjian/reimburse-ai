# The private corpus (`pnpm test:private`)

Real materials are never committed. They live only on the maintainer's machine, and `pnpm test:private`
(`server/src/quality/private-gate.ts`) measures the rule parsers against them there. Without the corpus the command
prints one skip line and exits 0, so CI and every other machine stay unaffected.

## Setting it up

1. Pick a directory outside the repository, e.g. `~/Documents/baox-private-corpus`.
2. Put every material under `<kind>/<layout>/`, the same ids the registry uses
   (`server/src/parse/layouts/index.ts`) — e.g. `vat_invoice/einvoice/`, `rail_ticket/12306/`,
   `ride_itinerary/amap/`. Accepted extensions: `.pdf`, `.jpg`, `.jpeg`, `.png`.
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

Per layout and medium: the share of files recognised by that layout, and per expected key the share read exactly
right. Floors live in `THRESHOLDS`: text-layer PDFs must be 100% recognised and 100% right per field — a rule is
deterministic, so a miss on a real file is a rule bug, not noise — and OCR images at least 98%.

## Why the output is safe to paste

The report is aggregate only: layout ids, media, slot keys and counts. A file name is handed to the parser (a layout
may look at it) but never printed, and no field value is ever printed. `server/src/quality/private-gate.test.ts` pins
that guarantee with a corpus whose file name and field values are unique strings, and fails if either appears in the
report.

Expectation sidecars carry real values, so they belong in the corpus directory next to the materials — never in the
repository, and never in an issue, a commit message or a test receipt.
