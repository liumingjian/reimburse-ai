# Rule parsers: material kinds with pluggable layouts, manual fill and tiered edits

With no model in the loop, rule parsers and the user are the only producers of 字段候选 (field candidates). We split parsing into two levels, a coarse 材料种类 (material kind) and pluggable 版式 (layouts), so a new vendor layout plugs in without touching downstream code. We also let the user edit any field, within limits set by where the value came from. Decided in [#154](https://github.com/liumingjian/reimburse-ai/issues/154).

## Decisions

- **Kind and layout.** A material kind owns the field-slot schema, the deterministic checks, how the material joins 费用事件 (expense events) and category derivation, and the 手工补填 (manual fill) form. v1 has five kinds:
  - `vat_invoice`: 全电发票 (fully digital e-invoice), for lodging and ride-hailing;
  - `rail_ticket`;
  - `ride_itinerary`;
  - `hotel_folio`;
  - `taxi_receipt`.

  A layout parser belongs to one kind and only recognises and extracts. The v1 layouts are `vat_invoice/einvoice`, `rail_ticket/12306`, `ride_itinerary/amap`, `hotel_folio/labelled` and `taxi_receipt/machine_printed`. Supporting 滴滴 (Didi) itineraries takes one new layout module and one registry line. A folio layout recognises on the folio's own field labels, not a chain name, so it covers every chain (#211, #212). A new kind, such as meal receipts or supplies, also needs a category and an ERP mapping, so it is outside v1.

  *Amended 2026-10-08 ([#356](https://github.com/liumingjian/reimburse-ai/issues/356)).* Dining (餐饮) is admitted deliberately, as 招待费 (hospitality). v1 now has seven kinds: the five above, `payment_screenshot` (ADR-0032) and `dining_receipt`, the 餐饮小票 (a restaurant's itemised checkout slip). Its role is reference, like `hotel_folio`. It has one layout, `dining_receipt/labelled`, which recognises only when all three hold: a receipt-style title (结账单, 消费小票, 消费清单, 顾客联), an amount labelled 实付, 实收, 应付 or 合计, and none of the folio anchors (入住日期, 离店日期, 房号). The `hotel_folio/labelled` layout is unchanged, and the two never both match one document. Only `paidAmount` is required; when a slip prints both an original total and an amount paid, the amount paid is taken. Merchant, date and time, original total and discount are optional, and nothing is back-calculated. The category it brings, `hospitality`, maps to FY009001, recorded as `user_declared` until a real ERP save reads it back. Supplies stay outside v1.
- **Dispatch.** Each layout exposes `recognise(doc)` and `parse(doc)`. `recognise` matches on hard anchors only. When exactly one layout matches, it parses. When none matches, the material is unrecognised. When several match, a blocking pending item is raised. First match wins no longer holds; it was the rule in `50931a3:kernel/src/parse.mjs` and in `extractDocument`. A recognised layout with missing fields raises `missing_required`; that material still counts as recognised.
- **Input.** Parsers read one source-agnostic model of positioned 文字观测 (text observations). The PDF adapter (unpdf) and the OCR adapter (`onnxruntime-node`, in-process per [#147](https://github.com/liumingjian/reimburse-ai/issues/147)) both produce it. NFKC normalisation, perspective correction of the taxi photo and QR decoding run before parsing. Shared layout helpers live in a module inside `server/`, which is their only consumer.
- **Candidates.** The shape follows [#20](https://github.com/liumingjian/reimburse-ai/issues/20).
  - **Source.** A candidate's source is `rule:<kind>/<layout>` plus a `parserVersion`, or `user`. A derived candidate also names its rule, for example `rule:taxi_receipt/machine_printed.year_from_suffix`.
  - **Evidence.** Evidence refs carry `materialId`, page, text-observation ids and visible text. The OCR score stays on the text observation; candidates carry no confidence.
  - **Segments.** Segment slots are keyed `segments[i].<field>`. A re-parse that changes the segment count makes segment-keyed answers stale.
- **QR.** On a 全电发票 the QR code is a second evidence source, `rule:vat_invoice/einvoice_qr`, which yields the invoice number, issue date, total including tax, and 专票/普票 (special or ordinary VAT invoice). A mismatch with the face is #20's `conflict`. An undecodable QR is advisory.

  *Amended 2026-09-19.* **The QR judges nothing.** It stays a source — it fills a field the face did not give, and the face wins wherever both speak — but a disagreement between the two is an advisory note and raises no 待确认项. #20's `conflict` finding kind is removed with its only producer; `qr_differs` replaces it.

  Two things decided this. The 二维码 on a 数电票 is not an authority the business treats as one, so a mismatch is not evidence against the face. And the check had just produced six false alarms in a row: `decodeRaster`'s `ImageData` shim installed a class on `globalThis` whose field initialisers closed over the arguments of the call that created it, so every image after the first in a process decoded as the first one. Six 高德打车 invoices reported a seventh one's QR and 「二维码与票面不一致」 each time. That bug is fixed (`qr.test.ts` reads two documents in one process, the shape the parse worker actually runs in), and this amendment stands on its own regardless: the check was costing the user blocking items it could never let them resolve — the only action a QR conflict ever offered was 排除.
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
  - `hotel_folio/labelled`: PDF and image. Each value is read by position from its label: right of it within half a text height, else directly below within one text height.
  - `taxi_receipt/machine_printed`: photo.

  - `dining_receipt/labelled`: PDF and photo (*amended 2026-10-08*, #356).

  Anything else is unrecognised, including 曹操出行 (Caocao) itineraries, road tickets and other vouchers. Payment screenshots are never parsed. They appear on the print sheet, and at inventory only their presence is checked, for the 住宿 (accommodation) trio of invoice, folio and screenshot ([#213](https://github.com/liumingjian/reimburse-ai/issues/213)).

  *Amended 2026-10-08 by ADR-0032.* Payment screenshots are parsed: a sixth kind, `payment_screenshot`, with one layout, `payment_screenshot/labelled` (image), assigned to 住宿 invoices by payment date and checked by sum.

  `vat_invoice/einvoice` recognises an invoice when **at least one** item row names a v1 税收分类 (tax class), not when every row does: a real ride-hailing invoice bundles a 服务费 or 经纪代理服务 row beside the ride, and the whole invoice is not thrown away over it. The accepted classes are the fine ones, `住宿服务` and `运输服务`, and the parent ones, `生产生活服务` and `交通运输服务`, the parents only together with a description that names the v1 service (`住宿费`, `客运服务费`) — a parent class covers freight and much else besides. The categories are unchanged: no 费用类别 (expense category) and no 材料种类 (material kind) is added to this matrix.

  *Amended 2026-10-08 (#356).* The input set gains the dining invoice and the 餐饮小票. `vat_invoice/einvoice` also accepts the fine class `餐饮服务`, which derives the category `hospitality` (招待费); an invoice for anything else, such as office supplies, stays unrecognised. A dining invoice and its 餐饮小票 pair one to one, and the invoice's 价税合计 must equal the slip's amount paid to the cent; merchant and date are not compared. Both are required: a dining invoice with no slip, a slip whose amount does not match, and a slip with no invoice each raise a blocking 待确认项 whose only answers are to supply the material or exclude, with no 「确认没有」 and no payment screenshot. The hotel invoice and 结账单 pair by the same one-to-one, exact-to-the-cent matcher, so lodging behaves as before.

  **Known gap.** Every `*餐饮服务*` invoice is hospitality. A travel meal or an overtime meal cannot yet be claimed under any other expense item: the invoice face does not say which kind of meal it was, and the category is derived, never chosen (ADR-0006). Letting the user choose would reopen ADR-0006 for one category; deferring it keeps dining to a single rule until the company asks for meals under another item.

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
- **Tests:** each layout has tests on `@baox/fixtures`. The `m` fixtures are the demo scenario's sample materials; the `r` fixtures are regression-only and reproduce how a real face is drawn — split text runs, fields sharing one baseline, a bundled item row, an unreadable cell:
  - `vat_invoice`: m01, m03, m05; r01 (发票号码 apart from its label), r02 (letter-spaced title), r201 (a bundled non-v1 item row), r206 (`*交通运输服务*` and fields on one baseline), r207 (a goods table whose cells are left-aligned under centred headers), r208 (a 项目名称 wrapped onto a second line);
  - `hotel_folio/labelled`: m02; r210 (a folio photo whose labels and values are separate boxes, dates as `2026/08/09` and `2026年08月22日`);
  - `ride_itinerary/amap`: m04; r202 (a leg amount that reads 待结算), r205 (a wrapped 上车时间 cell and 元-suffixed amounts);
  - `rail_ticket`: m07, m08; r204 (a trip row with a seat cell, 票价 apart from its amount);
  - `taxi_receipt`: m09, m10;
  - unrecognised: m06, m11.

  *Amended 2026-10-08 (#356).* m11 becomes the supported dining invoice, and a new office-supplies invoice takes its place as the unrecognised one; synthetic 餐饮小票 fixtures (matching, mismatched, discounted, photo) cover `dining_receipt/labelled` until real samples join the private corpus. So far: m13 (a 结账单 whose 实收 equals m11's 价税合计) and m14 (a discounted 消费清单 whose 实付 does).

  Private samples run through `test:private`, which gates per layout, medium and field (#196): text-layer PDFs must
  be 100% recognised and 100% right per field; OCR images at least 98% (`server/src/quality/private-gate.ts`).
  That gate scores only what an expectation sidecar declares, so `REQUIRED_EXPECTATIONS` names the keys a layout's
  samples must all be written down for — a field nobody wrote down is one the gate cannot see (#199).
