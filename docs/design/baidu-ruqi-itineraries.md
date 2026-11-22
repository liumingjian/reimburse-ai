# Baidu Maps and Ruqi ride itineraries

Status: implemented and verified; the maintainer completed manual QA on the Mac and authorised PR creation and merge on 2026-11-22.

## Confirmed scope

- Support both the Baidu Maps itinerary face and the Ruqi itinerary face represented by the four supplied PDFs.
- Support original PDFs in this iteration. Screenshot and photo support is deferred until supported by real samples.
- Identify layouts from document evidence. The Ruqi face has no Baidu branding and must not be identified as a Baidu face from its directory or upload context.

## Sample evidence

The private originals are under `/Users/lmj/Documents/temp/baox-test/baidu-tickets`. They remain outside version control, together with any expected-value sidecars containing real data.

- The Baidu face is titled `百度地图打车行程单` / `BAIDU MAP ITINERARY`. It has one trip, a service-provider column, an explicit city column, full-year trip dates, and a per-trip `可开票金额` column.
- The Ruqi face is titled `如祺出行--行程单` / `ON TIME--ITINERARY`. It has three trips, full-year dates, wrapped route cells, and no dedicated city column. Its endpoints explicitly name Guangzhou or Foshan, depending on the trip.
- Both itineraries declare a trip count and total. Their printed trip amounts sum exactly to their respective invoice totals.
- Both accompanying invoices are standard electronic VAT invoices for passenger transport. One has a negative discount item; totals must come from the printed totals rather than an individual item row.
- Before this extension, the read-only parse probe recognised both invoices as `vat_invoice/einvoice`, with no missing fields and matching QR evidence; both itineraries returned `no_layout`.

## Existing contracts

[ADR-0017](../adr/0017-rule-parsers-by-kind-and-layout.md) provides the material-kind/layout extension point. This extension reuses it without introducing a new material kind or a new ADR.

The existing glossary distinguishes a layout from a carrier name. Existing material association requires an exact, unique total match; each independent itinerary trip forms an expense event. Trip gross amounts are adopted only when they conserve the invoice total. City-based expense categorisation uses the task's home-city snapshot.

## Confirmed behaviour and acceptance

The maintainer accepted the following decisions on 2026-11-22:

- Q3: derive a Ruqi trip's city only when both route endpoints explicitly name the same municipality. Otherwise retain the existing pending workflow rather than looking up or guessing locations.
- Q4: label the Baidu material by its platform and each candidate line by that row's printed service provider. Use the platform label when the provider is missing, without introducing a new blocking requirement.
- Q5: verify inventory, whole-list confirmation, print output and generated ERP detail data using all four originals. With Guangzhou as the home city, expect four lines: three local trips totalling 97.11 and one out-of-town trip of 11.11, for a combined total of 108.22. Each invoice prints with its own itinerary. A live ERP write is outside the recommended acceptance scope.

Verification additionally exposed an existing print-heading assumption: a voucher's trips may fall in different expense categories and have nonconsecutive business numbers after category sorting. The correction lists only the actual numbers and all categories present, while keeping the invoice and itinerary together on one page.

These decisions complete the interview frontier. They extend the existing layout and carrier concepts rather than introducing a new material kind or domain term.

## Verification

- Recognition: 17 Baidu/Ruqi layout tests and all 39 recognition snapshot cases passed. The two new captures preserve the real PDF geometry with private values replaced.
- Printing: all seven layout tests passed, including a regression that failed before correcting the nonconsecutive-number and mixed-category heading.
- Related tests: the final changed-file run passed 81 files and failed three fake-ERP reconciliation cases in one file. That entire file passed all ten tests when rerun alone. An earlier broader related run also required isolated ERP-file reruns; all six of those files passed. These results are not a single green merge-gate run.
- Server type checking and repository lint passed.
- Private accuracy gate: all four supplied PDF originals passed recognition and every declared field at 100%, using independently transcribed sidecars in `/Users/lmj/baox-private-corpus-baidu-ruqi`. This result covers the supplied corpus only.
- Built-app acceptance: `ride-itineraries` passed real browser upload, inventory, project assignment, whole-list confirmation, print preview and PDF download. Four trips matched their expected dates, cities, routes and three monetary amounts. Both print pages contain the corresponding invoice and itinerary, with accurate business numbers and category headings.
- The offline production fill-plan builder accepted the confirmed snapshot: four matching detail lines, two invoice originals, and no itinerary uploaded as an invoice. No ERP action was started.

The final browser evidence is under `/Users/lmj/.baox-verify/2026-11-22T05-57-35-439Z-ride-itineraries/`, including screenshots, task snapshots, the downloaded print sheet, and the offline ERP plan. These private artifacts stay outside Git. The merge-gate result is recorded in the PR; the full e2e suite and deployment gate are outside this change's acceptance scope.
