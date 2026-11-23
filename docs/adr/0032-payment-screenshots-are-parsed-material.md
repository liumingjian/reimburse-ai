# 支付截图 are parsed material, assigned to stays by date and checked by sum

**Amended by [ADR-0043](0043-reference-materials-are-optional.md) (2026-11-23).** Missing screenshots need no separate acknowledgement. Assignment uses the actual stay dates adopted on the expense when available, including dates entered by the employee.

ADR-0017 kept payment screenshots out of parsing: they were images for the print sheet, checked only for presence,
and #329 had them uploaded one 住宿 invoice at a time from that invoice's 待确认项. QA showed the cost: users upload a
stay's invoice, folio and screenshots together, and the screenshots came back unrecognised. This ADR amends ADR-0017
so the app tells which files are payment screenshots and puts each with its stay. Decided in
[#336](https://github.com/liumingjian/reimburse-ai/issues/336); still no model in the loop.

## Decisions

- **A sixth kind.** `payment_screenshot` (支付截图) is a material kind with `role: 'reference'`: it goes through upload,
  parsing, the unrecognised item and 手工补填 like any material, and like a folio it never forms a line and never
  reaches ERP. Its fields are amount, payment time, payee and transaction number; they serve matching and display
  only.
- **One field-based layout.** `payment_screenshot/labelled` recognises on three hard anchors, whatever the app: a
  payment-success word (交易成功, 支付成功), a 支付时间 label, and a negative amount. That covers Alipay, WeChat Pay
  and bank apps without a layout per app. A refund (positive amount, 退款成功) is not a payment and stays
  unrecognised. A screenshot no rule reads is filled in by hand as 支付截图: amount and payment date required, time
  and payee optional.
- **Assignment is derived.** A screenshot belongs to the 住宿 invoice whose stay it was paid in, from 30 days before
  check-in (prepaid bookings) to 1 day after check-out; the stay dates are the paired folio's, and without a folio the
  invoice's issue date stands in for check-out. When several stays fit: the nearest wins, then the one whose hotel
  the payee names (folio hotel name or invoice seller), then the one the amount fits. The payee is never grounds to
  reject: a platform payee (高德酒店) is normal. Nothing about the assignment is stored; it is computed at every
  inventory, so it follows a changed invoice or folio. Only the user's choices are stored, as pending answers:
  assigning a screenshot no stay took, moving one (改归属), or removing one. A choice always beats the derivation.
- **Sum check.** A stay's screenshots are complete when their amounts add up to at least the invoice's 价税合计;
  more is shown as information (实付比发票多 21.34) and raises nothing. Less raises a 待确认项: upload more, correct an
  amount, or confirm that is all (「已传齐」, now asked only for a shortfall). A stay with no screenshot keeps
  「确认没有支付截图」.
- **Unassigned and duplicate screenshots** each raise a 待确认项. Unassigned: assign it to a stay or remove it.
  Duplicate: the same transaction number when both have one, else the same amount and payment time to the second;
  the user keeps one. Nothing is dropped silently.
- **No cap.** #331's limit of 6 per invoice goes; the print continuation page grows to as many pages as the group
  needs.
- **The 待确认项 upload stays** as a shortcut: it adds `payment_screenshot` materials already assigned to that invoice,
  as a new upload batch, and starts inventory again over it (adding a file is a new inventory version). Nothing is written
  to the `payment_screenshot` table any more.

## Considered Options

- **Keep screenshots in the `payment_screenshot` table and add amount columns.** Screenshots would still need a
  separate upload path, and manual fill, duplicate checks and removal would be built a second time beside the
  material ones.
- **A layout per payment app.** Each wallet redesign or new bank app would be unrecognised again; the three anchors
  are what every payment receipt prints.
- **Exact match between payments and invoice.** Real stays fail it: the QA stay paid 357.48 for a 336.14 invoice (an
  OTA booking price for one night, the desk price for the other).
- **A model to classify screenshots.** Ruled out by ADR-0017 and not needed: the anchors are unambiguous.

## Consequences

- **ADR-0017:** amended. The kind list gains `payment_screenshot`, the layout list `payment_screenshot/labelled`, and
  the input matrix no longer says payment screenshots are never parsed.
- **#329:** groups already in the `payment_screenshot` table keep being read. They count as present but have no
  amounts, so a stay with any of them gets no sum check and still needs 「已传齐」. No migration: those tables are
  append-only (as with #312).
- **Print:** #333's layout stands. One screenshot prints beside the folio; two or more go to the continuation page,
  which takes every screenshot of the stay, materials and table rows alike.
- **Invoice-guided folio proposal** (#336 decision 7c) is the folio-side counterpart: an unrecognised image holding a
  住宿 invoice's exact total and nearby dates is proposed as its folio, and the user confirms it. It too is a rule over
  read text, not a model.
- **Private corpus:** payment screenshots join it under `payment_screenshot/labelled/`, gated like every OCR layout
  (98%).
