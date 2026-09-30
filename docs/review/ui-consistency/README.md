# Layout consistency audit evidence

The screenshots use synthetic mock data (`?seed=…` on the mock build). No private invoice corpus or production ERP data
appears here. Two long Chinese file names were uploaded on top of the mock samples to stress file-name layout.

`before/` is the baseline at 1440 × 900, full page, cropped to 2400 px. Regenerate any state with
`node web/scripts/ui-shots.mjs --out <dir> --only <name-prefix> --widths 1440` after `pnpm --filter @baox/web build:mock`
(on the Mac). The script covers 50 states at 1440 and 1920.

## Root causes

| # | Root cause | Evidence |
| --- | --- | --- |
| A | Button groups have no size or width rule. `.app-btn-row` mixes kinds, sizes, captions and errors; action bars are `lg` on some steps and `md` on others. | `13-settings-extension-disconnected` (4 buttons, 4 kinds), `05-pending-lodging-missing-payment` (1 + 2 rows), `07-review-actions` |
| B | Nine key/value renderings, often two in one panel (label above next to label left). | `05-pending-item1` vs `05-pending-item2` (form column shifts), `08-print-seg02`, `10-done` |
| C | Summary bars and cards are hand-built per page: summary fields sized by content, action cards not aligned, eight card classes with four paddings. | `04-inventory`, `07-review`, `11-reconcile-T2-expanded` |
| D | Toggles hand-built from Buttons in three places, while two others use ContentSwitcher. | `05-pending-lodging-missing-payment` (结账单 / 发票 tabs 270 vs 242 px), `12-projects-book` |
| E | No truncation rule for file names; headers and short paragraphs wrap one glyph onto a line of its own. | `03-upload-long-names`, `04-inventory-long-names-pending-long-item1`, `06-project-add-dialog` (截止日 / 期), `09-erp-in-progress` |
| F | Tables and form rows do not align: status columns at different x across stacked tables, helper text lifting one field above its row. | `04-inventory`, `04-inventory-duplicate-blocker`, `06-project-add-dialog`, `01-tasks-list` (更新时间 clipped) |
| G | Display bugs found on the way: a page-sized black circle while the service is disconnected, raw ISO timestamps. | `01-tasks-service-disconnected`, `13-settings-extension-disconnected` |
