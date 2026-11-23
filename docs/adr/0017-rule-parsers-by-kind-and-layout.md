# Rule parsers: material kinds with pluggable layouts, manual fill and tiered edits

**Amended by [ADR-0043](0043-reference-materials-are-optional.md) (2026-11-23).** The missing companion document rules for lodging and dining now follow the shared invoice flow. Employees can enter missing expense details directly.

With no model in the loop, rule parsers and the user are the only producers of 字段候选 (field candidates). We split parsing into two levels, a coarse 材料种类 (material kind) and pluggable 版式 (layouts), so a new vendor layout plugs in without touching downstream code. We also let the user edit any field, within limits set by where the value came from. Decided in [#154](https://github.com/liumingjian/reimburse-ai/issues/154).

## Decisions

- **Kind and layout.** A material kind owns the field-slot schema, the deterministic checks, how the material joins 费用事件 (expense events) and category derivation, and the 手工补填 (manual fill) form. With ADR-0032 and [#356](https://github.com/liumingjian/reimburse-ai/issues/356), v1 has seven kinds. The original five gained `payment_screenshot` in ADR-0032 and now gain `dining_receipt`:
  - `vat_invoice`: 全电发票 (fully digital e-invoice), for lodging, ride-hailing, and dining;
  - `rail_ticket`;
  - `ride_itinerary`;
  - `hotel_folio`;
  - `taxi_receipt`;
  - `payment_screenshot`;
  - `dining_receipt`: 餐饮小票 (itemised restaurant checkout slip), a reference material.

  A layout parser belongs to one kind and only recognises and extracts. The v1 layouts are `vat_invoice/einvoice`, `rail_ticket/12306`, `ride_itinerary/amap`, `ride_itinerary/didi` (added by [#445](https://github.com/liumingjian/reimburse-ai/issues/445)), `ride_itinerary/baidu`, `ride_itinerary/ruqi` (added by the 2026-11-22 agreement), `hotel_folio/labelled`, `taxi_receipt/machine_printed`, `payment_screenshot/labelled`, and `dining_receipt/labelled`. Supporting 滴滴 (Didi) itineraries takes one new layout module and one registry line. A folio layout recognises on the folio's own field labels, not a chain name, so it covers every chain (#211, #212). Dining is a deliberate scope amendment in #356. Supplies remain outside v1.
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
  - `ride_itinerary/didi`: PDF ([#445](https://github.com/liumingjian/reimburse-ai/issues/445)). The 行程单 the 滴滴 platform issues, titled `滴滴出行-行程单`, or `第三方网约车服务提供方<carrier>—行程单` for a third-party carrier booked through it; the display name names the carrier (`曹操出行行程单`). Same slots as 高德, read by the same table reader, over several pages when the header repeats on each. Legs print `MM-DD`: the year is derived from 行程起止日期 (`year_from_range`), and a date it cannot place in exactly one year is left missing. The legs are adopted only as a whole: 序号 1..n, n = 共N笔, every leg dated and priced, and the amounts summing to 合计 to the cent.
  - `ride_itinerary/baidu` and `ride_itinerary/ruqi`: original PDF, added by the [2026-11-22 scope agreement](../design/baidu-ruqi-itineraries.md). Distinct face titles and headers identify the layouts, regardless of the booking platform. Both print full dates and wrapped cells; declared count, row sequence, valid dates, positive trip amounts and exact total conservation gate adoption of the table. Baidu's material label names the platform, while each expense summary uses the row's printed service provider, falling back to the platform if absent. Ruqi has no city column: a trip's city is derived only when both endpoints explicitly begin with the same municipality name; absent or different prefixes leave the city unresolved. No map lookup or seller-location inference is used.
  - `hotel_folio/labelled`: PDF and image. Each value is read by position from its label: right of it within half a text height, else directly below within one text height. A value in a run of its own drops one leading colon (#447). 入住 = 离店 is kept as printed with an advisory note; 离店 before 入住 is a blocking `dates_reversed` (#448).
  - `taxi_receipt/machine_printed`: photo.
  - `payment_screenshot/labelled`: image, per ADR-0032.
  - `dining_receipt/labelled`: PDF and photo. Receipt titles include 小票, 消费小票, 结账单, 消费清单, and 顾客联. Recognition requires a receipt-style title and an amount labelled 实付, 实收, 应付, or 合计, with none of the hotel anchors 入住日期, 离店日期, or 房号. The hotel folio layout is unchanged. The two layouts must not both match one document. `paidAmount` is required. 实付 or 实收 wins over an original total. Merchant, date and time, original total, and discount are optional. No amount is back-calculated.

  Anything else is unrecognised, including 曹操出行 (Caocao) itineraries on the carrier's own face (one issued through 滴滴 is `ride_itinerary/didi` since #445), road tickets, supplies invoices, and other vouchers. The 住宿 (accommodation) trio of invoice, folio, and screenshot is checked at inventory ([#213](https://github.com/liumingjian/reimburse-ai/issues/213)). ADR-0032 amended the original presence-only screenshot check on 2026-10-08. Payment screenshots are parsed, assigned to 住宿 invoices by payment date, and checked by sum. The existing accommodation missing-material answers remain unchanged.

  Dining requires both an invoice and a 餐饮小票. They pair one-to-one when invoice 价税合计 equals receipt `paidAmount` exactly to the cent, without tolerance. Automatic pairing requires exactly one invoice and one receipt per amount. Under #372, the user can explicitly select a dining invoice for a receipt, including in equal-amount groups. Valid explicit pairs are removed before unique residual matching. The accommodation matcher is unchanged. Merchant and date do not constrain pairing. Missing receipt, mismatched amounts, and a receipt without an invoice all block. The mismatch item shows both amounts. The user can upload missing material from the pending item. A batch starts inventory only if at least one file is accepted. An unrecognised receipt can submit its kind, independently supplied paid amount, and invoice selection together. Receipt fields and selection are separate append-only facts in one transaction. Selection never fills or changes the paid amount. Invalid selections remain blocking after correction, exclusion, or reinventory; they reserve an available target until explicitly replaced, reset, or excluded. Another receipt cannot take an occupied or reserved invoice. Association changes require an unconfirmed, finished inventory and stop at the existing lifecycle and ERP locks. The user supplies or corrects evidence, selects a valid association, resets to automatic matching, or excludes the material. There is no 「确认没有」 answer. Payment screenshots and card slips do not count as dining receipts, and dining requires no payment screenshot. The paired invoice and receipt print on one page, one half each.

  `vat_invoice/einvoice` recognises an invoice when **at least one** item row names a v1 税收分类 (tax class), not when every row does: a real ride-hailing invoice bundles a 服务费 or 经纪代理服务 row beside the ride, and the whole invoice is not thrown away over it. The accepted classes are the fine ones, `住宿服务`, `运输服务`, and `餐饮服务`, and the parent ones, `生产生活服务` and `交通运输服务`. The parents require a description naming the v1 service (`住宿费`, `客运服务费`), because they also cover other services.

  Every `*餐饮服务*` invoice derives 招待费 (`hospitality`), never a user-selected category, per ADR-0006. Company rules map it to FY009001 with source `user_declared` until the first real ERP save reads it back (#366). The accepted gap is that travel meals and overtime meals also derive hospitality and cannot yet be claimed under another expense item. Hospitality detail fields are outside #356. The new layout needs 3–5 real invoice and receipt pairs in the private corpus, including a discounted receipt and a photo, and required field expectations in the private gate (#365). Synthetic fixtures alone do not prove real-receipt accuracy.

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
  - `hotel_folio/labelled`: m02; r210 (a folio photo whose labels and values are separate boxes, dates as `2026/08/09` and `2026年08月22日`); the redacted capture `hotel-folio-huazhu-colon-run` (a 华住 face that prints each colon with its value, #447; its dates edited for a same-day and a reversed stay, #448);
  - `ride_itinerary/amap`: m04; r202 (a leg amount that reads 待结算), r205 (a wrapped 上车时间 cell and 元-suffixed amounts);
  - `ride_itinerary/didi`: no fixture; redacted captures of real faces, `didi-itinerary-single-page` (edited for the third-party title, a New Year range and the refusals) and `didi-itinerary-two-page-wrapped` (a table over two pages, wrapped cells); m06 must stay unrecognised;
  - `rail_ticket`: m07, m08; r204 (a trip row with a seat cell, 票价 apart from its amount);
  - `taxi_receipt`: m09, m10;
  - unrecognised before #356: m06, m11. #356 admits m11 as a dining invoice and replaces its unsupported-invoice role with a supplies fixture.

  Private samples run through `test:private`, which gates per layout, medium and field (#196): text-layer PDFs must
  be 100% recognised and 100% right per field; OCR images at least 98% (`server/src/quality/private-gate.ts`).
  That gate scores only what an expectation sidecar declares, so `REQUIRED_EXPECTATIONS` names the keys a layout's
  samples must all be written down for — a field nobody wrote down is one the gate cannot see (#199).
