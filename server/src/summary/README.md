# Reimbursement summary

`template.xlsx` is a scrubbed copy of the finance form's main worksheet. It retains the company heading, static labels, styles, merges, row/column dimensions and A4 portrait centered print setup. Historical inputs, formula caches, document properties, the personnel worksheet and the original shared strings have been removed. The private source workbook is never a fixture or build input.

`workbook.ts` patches only authorized cell payloads in that ZIP package. Do not round-trip the template through a workbook exporter: tested exporters drop its print settings. `preview.ts` reads the same template's geometry and labels and fills the same persisted summary data. Excel's numeric and uppercase totals remain formulas; the preview shows their corresponding result.

The download and SVG routes recheck current confirmation and employee identity on every request, with `Cache-Control: no-store`. Never register a summary blob with the immutable task `/files` route.

To reproduce native calculation and print checks from the synthetic five-category public scenario:

```sh
BAOX_SUMMARY_EVIDENCE=/tmp/summary.xlsx pnpm --filter @baox/server exec vitest run src/summary.test.ts
uv run --no-project server/scripts/verify-summary-workbook.py /tmp/summary.xlsx --output /tmp/summary-native
```

The script requires LibreOffice (`--soffice` selects the executable). It clears result caches, changes actual downloaded inputs, invokes the native engine, checks eight numeric/Chinese currency results, and exports an A4 PDF. Inspect that PDF visually with Chinese fonts available. This proves LibreOffice recalculation; Microsoft Excel has not been tested.
