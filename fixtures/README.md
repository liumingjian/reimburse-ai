# Sample materials

Generate the sample materials with `pnpm --filter @baox/fixtures generate`; regenerate one material with `node fixtures/scripts/generate.mjs <id>`. The business file names are listed in `sample-materials.json`.

Dining sample IDs are stable across the #356 tickets:

| ID | Generated file | Business file name | Purpose |
| --- | --- | --- | --- |
| m11 | m11-other-invoice.pdf | 餐饮_发票.pdf | Supported dining VAT invoice, hospitality / 招待费, total 240.00 |
| m12 | m12-office-supplies-invoice.pdf | 办公用品_发票.pdf | Unsupported office-supplies VAT invoice, total 240.00 |
| m13 | m13-dining-receipt.pdf | 餐饮_小票.pdf | Itemised restaurant receipt, paid 240.00 |
| m14 | m14-discounted-dining-receipt.pdf | 餐饮_优惠小票.pdf | Original total 300.00, discount 60.00, paid 240.00 |

The default mock task uses m12 for the unsupported-material journey. New dining scenarios use m11. The office-supplies invoice number is 26312000000103317791; the dining invoice number is 26312000000103317790.

Each dining receipt pairs with m11 when uploaded alone alongside it. Uploading both receipts leaves them unpaired because their equal amounts do not identify a unique match. Their merchant and consumption date deliberately differ from the invoice's seller and issue date.
