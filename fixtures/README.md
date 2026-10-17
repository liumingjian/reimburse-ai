# Sample materials

Generate the sample materials with `pnpm --filter @baox/fixtures generate`; regenerate one material with `node fixtures/scripts/generate.mjs <id>`. The business file names are listed in `sample-materials.json`.

Dining sample IDs are stable across the #356 tickets:

| ID | Generated file | Business file name | Purpose |
| --- | --- | --- | --- |
| m11 | m11-other-invoice.pdf | 餐饮_发票.pdf | Supported dining VAT invoice, hospitality / 招待费, total 240.00 |
| m12 | m12-office-supplies-invoice.pdf | 办公用品_发票.pdf | Unsupported office-supplies VAT invoice, total 240.00 |
| m13 | m13-dining-receipt.pdf | 餐饮_小票.pdf | Itemised restaurant receipt, paid 240.00 |
| m14 | m14-discounted-dining-receipt.pdf | 餐饮_优惠小票.pdf | Original total 300.00, discount 60.00, paid 240.00 |
| m15 | m15-mismatched-dining-receipt.pdf | 餐饮_金额不一致小票.pdf | Paid 239.99, mismatches m11 by 0.01 |
| m16 | m16-dining-receipt-photo.jpg | 餐饮_小票照片.jpg | Phone photo, original total 300.00, discount 60.00, paid 240.00 |

The default mock task uses m12 for the unsupported-material journey. New dining scenarios use m11. The office-supplies invoice number is 26312000000103317791; the dining invoice number is 26312000000103317790.

Each of m13, m14, and m16 pairs with m11 when uploaded alone alongside it. The m15 receipt's paid amount of 239.99 does not match the invoice's 240.00. Uploading several receipts with the same paid amount leaves them unpaired because the amounts do not identify a unique match. Their merchant and consumption date deliberately differ from the invoice's seller and issue date.

Dining print fixtures use m11 in the top half and the paired receipt in the bottom half. The matching PDF, discounted PDF, and photo each have a separate page image, one-page PDF, and rotation variants. The default mock task's seven-page print sheet remains the existing travel scenario.
