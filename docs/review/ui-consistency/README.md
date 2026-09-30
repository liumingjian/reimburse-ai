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

## After

`after/` holds the same states after #319's four PRs, same size and crop. Pairs worth comparing first:

| State | What changed |
| --- | --- |
| `05-pending-lodging-missing-payment` | 结账单 / 发票 switcher inside the viewer frame; one button row (ghost · secondary · primary) with notes below; one detail list |
| `07-review-actions` | Equal summary fields; 去打印 / 去报销 as Tiles with aligned buttons; one edit group |
| `13-settings-extension-disconnected` | Two-column field grid, formatted times; tutorial → download → next step, 撤销配对 apart |
| `03-upload-long-names` | Fixed file-row columns, middle ellipsis, two-line reasons |
| `05-pending-all-done` | Handled items as a table |
| `06-project-assign` | Lodging rows two lines like the rest |
| `01-tasks-service-disconnected` | Inline loading instead of a black circle |

Known remainders: the inventory's expanded material tables and the unassigned-materials table sit in different containers, so their status columns do not share one x; Carbon modal bodies keep Carbon's 80% text measure.
