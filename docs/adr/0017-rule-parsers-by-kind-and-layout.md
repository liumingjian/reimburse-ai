# Rule parsers: material kinds with pluggable layouts, manual fill and tiered edits

With no model in the loop, rule parsers and the user are the only producers of 字段候选 (field candidates). We split parsing into two levels, a coarse 材料种类 (material kind) and pluggable 版式 (layouts), so a new vendor layout plugs in without touching downstream code. We also let the user edit any field, within limits set by where the value came from. Decided in [#154](https://github.com/liumingjian/reimburse-ai/issues/154).

## Decisions

- **Kind and layout.** A material kind owns the field-slot schema, the deterministic checks, how the material joins 费用事件 (expense events) and category derivation, and the 手工补填 (manual fill) form. v1 has five kinds:
  - `vat_invoice`: 全电发票 (fully digital e-invoice), for lodging and ride-hailing;
  - `rail_ticket`;
  - `ride_itinerary`;
  - `hotel_folio`;
  - `taxi_receipt`.

  A layout parser belongs to one kind and only recognises and extracts. The v1 layouts are `vat_invoice/einvoice`, `rail_ticket/12306`, `ride_itinerary/amap`, `hotel_folio/quanji` and `taxi_receipt/machine_printed`. Supporting 滴滴 (Didi) itineraries or 汉庭 (Hanting) folios takes one new layout module and one registry line. A new kind, such as meal receipts or supplies, also needs a category and an ERP mapping, so it is outside v1.
- **Dispatch.** Each layout exposes `recognise(doc)` and `parse(doc)`. `recognise` matches on hard anchors only. When exactly one layout matches, it parses. When none matches, the material is unrecognised. When several match, a blocking pending item is raised. First match wins no longer holds; it was the rule in `50931a3:kernel/src/parse.mjs` and in `extractDocument`. A recognised layout with missing fields raises `missing_required`; that material still counts as recognised.
- **Input.** Parsers read one source-agnostic model of positioned 文字观测 (text observations). The PDF adapter (unpdf) and the OCR adapter (`onnxruntime-node`, in-process per [#147](https://github.com/liumingjian/reimburse-ai/issues/147)) both produce it. NFKC normalisation, perspective correction of the taxi photo and QR decoding run before parsing. Shared layout helpers live in a module inside `server/`, which is their only consumer.
- **Candidates.** The shape follows [#20](https://github.com/liumingjian/reimburse-ai/issues/20).
  - **Source.** A candidate's source is `rule:<kind>/<layout>` plus a `parserVersion`, or `user`. A derived candidate also names its rule, for example `rule:taxi_receipt/machine_printed.year_from_suffix`.
  - **Evidence.** Evidence refs carry `materialId`, page, text-observation ids and visible text. The OCR score stays on the text observation; candidates carry no confidence.
  - **Segments.** Segment slots are keyed `segments[i].<field>`. A re-parse that changes the segment count makes segment-keyed answers stale.
- **QR.** On a 全电发票 the QR code is a second evidence source, `rule:vat_invoice/einvoice_qr`, which yields the invoice number, issue date, total including tax, and 专票/普票 (special or ordinary VAT invoice). A mismatch with the face is #20's `conflict`. An undecodable QR is advisory.
- **Parser outcomes.** A parser returns `recognised | unrecognised | failed{retryable}`. These replace `needs_model_vision` in `50931a3:packages/image-field-extraction`:
  - `unsupported_document` and `insufficient_evidence` become `unrecognised`;
  - `ocr_failed` becomes a retryable `failed`;
  - `candidate_validation_failed` is no longer a parser outcome, because amount conservation is a validation rule that raises `validation_failure`.
- **Manual fill.** An unrecognised material raises a pending item with three actions: exclude it, mark it as reference material, or fill it in manually. For manual fill the user picks a kind, and the page shows that kind's slots beside the original. Each entry becomes a `user` candidate with evidence `{materialId, page}`. When only some slots are missing or ambiguous, the same form shows just those slots.
- **Edits by field class.** Every field can be edited any number of times, both in pending items and on 整单明细确认 (whole-list confirmation). An edit after confirmation invalidates it by digest, per ADR-0014. The kind schema declares each slot's class:
  - `fact_locked`: a 票面事实 (face fact) from the PDF text layer or the QR code. The user cannot edit it; to dispute it, they exclude or replace the material.
  - `fact_correctable`: a face fact from OCR or manual fill. The user re-transcribes it from the displayed original as a `user` candidate. The new value must pass every check: number format, net + tax = total to the cent, date validity, 发票占用 (invoice occupancy) and duplicates. A missing amount is never back-calculated.
  - `presentation`: wording such as the hotel name, origin and destination text, the city's display name, or the line description. Editing is free, and the edit is stored as a 呈现值 (presentation value) layered over the resolved value. The whole-list confirmation, the print sheet and ERP text fields use the presentation value; checks use the resolved value.
  - `choice`: derived business values, namely 费用类别 (expense category), 费用项目 (expense item) and ERP 发票类型 (ERP invoice type). The user can only choose among values the rules allow. A choice that contradicts the facts is refused, for example 本地市内交通 (local transport) for a trip between two cities.
- **Runtime.** Parsing is a server job that starts after `start_inventory`. It parses PDFs first, then images one at a time in a single `worker_thread`, so HTTP stays responsive. The OCR session loads lazily and is released when the job ends. Progress per material appears in the snapshot.
- **v1 input matrix.**
  - `vat_invoice/einvoice`: PDF and image.
  - `rail_ticket/12306`: PDF.
  - `ride_itinerary/amap`: PDF and image.
  - `hotel_folio/quanji`: PDF.
  - `taxi_receipt/machine_printed`: photo.

  Anything else is unrecognised, including 曹操出行 (Caocao) itineraries, other chains' folios, road tickets and other vouchers. Payment screenshots are never parsed; they appear only on the print sheet.

## Considered Options

- **One parser per kind only.** This means fewer modules, but each new vendor makes one module branch further, and layout quirks collide: the 曹操 invoice's negative discount line and the AA itinerary's wrapped cells would share one module.
- **One parser per layout, with no kind level.** This is flexible, but the schema, checks and manual-fill form would be duplicated per layout, and manual fill would have no layout to offer the user.
- **QR as a check only.** This loses the QR code as a source when OCR misreads an image invoice.
- **Locking every face fact regardless of source.** An OCR misread would leave the user no recourse except replacing the file. **Allowing free edits everywhere** would let a typed number release an invoice, which #20 §5 forbids.

## Consequences

- **#20 §5:** amended. A user may re-transcribe a face fact from the displayed original when it came from OCR or manual fill, and every deterministic check still applies.
- **Earlier ADRs:**
  - supersedes the agent candidates of ADR-0011;
  - revises ADR-0004 and ADR-0013: no model vision and no Python worker; parse failures go to manual fill.
- **`50931a3:packages/image-field-extraction`:** stays frozen. Its rules are ported together with their tests as parity evidence, and the package is deleted in the retirement PR.
- **Contract:** gains the following, each changed in the slice that needs it:
  - `Material.kind`;
  - `Material.layout`, nullable while a material is unrecognised or filled in manually;
  - a checked pattern for `FieldCandidate.source`;
  - a per-field `editClass`;
  - `PendingField.format: money`.

  Manual fill reuses pending items of `kind: form`.
- **Tests:** each layout has tests on `@baox/fixtures`:
  - `vat_invoice`: m01, m03, m05;
  - `hotel_folio/quanji`: m02;
  - `ride_itinerary/amap`: m04;
  - `rail_ticket`: m07, m08;
  - `taxi_receipt`: m09, m10;
  - unrecognised: m06, m11.

  Private samples run through `test:private`, which gates per layout, medium and field (#196): text-layer PDFs must
  be 100% recognised and 100% right per field; OCR images at least 98% (`server/src/quality/private-gate.ts`).
