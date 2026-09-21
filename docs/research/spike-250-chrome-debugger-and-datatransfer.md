# Spike #250 — can `chrome.debugger` reach the piaozone iframe, and does a `DataTransfer` built in `Runtime.evaluate` trigger recognition

**Status: Q1 and Q2 PASSED in a live rehearsal on 2026-09-21.** Chrome on the maintainer's
macOS machine reached the invoice assistant (发票无忧助手) through route B and triggered recognition using
`DataTransfer` inside `Runtime.evaluate`. This measures one synthetic PDF, not unattended end-to-end filling.
Ticket [#250](https://github.com/liumingjian/reimburse-ai/issues/250), spec
[#246](https://github.com/liumingjian/reimburse-ai/issues/246).

The agent operated the probe after the maintainer logged into ERP. Run 1 stopped before either question;
Run 2 answered both, with manual assistance opening the empty draft. No invoice was imported or selected,
and no reimbursement form was saved or deleted. Session-bearing URLs are redacted in the evidence below.

## The two questions

### Q1. Can `chrome.debugger` reach the invoice assistant (发票无忧助手) cross-origin iframe?

The assistant runs at `www.piaozone.com/m4-web/fpzs/…`, inside the K3Cloud page but out of process. The
server-side executor reaches it with raw CDP over a WebSocket: `Target.setAutoAttach {flatten: true}` on the page
target, then a `sessionId` threaded into every message (`server/src/erp/executor/cdp.ts`, `autoAttach`). Neither
`Page.getFrameTree` nor `/json/list` lists the child; `Target.getTargets` lists it unreliably.

`chrome.debugger` speaks the same protocol but addresses it differently: commands take a debuggee object, not a
bare `sessionId`, and whether a flat child session can be addressed from an extension at all is a property of
the Chrome build the maintainer is running. So the spike tries three routes and records all three, even after
one succeeds — #255 and #256 need to know which routes work, not merely that one does.

| Route | Mechanism |
| --- | --- |
| B | `Target.setAutoAttach {flatten:true}` on the tab, then `sendCommand({tabId, sessionId}, …)` |
| C | `Target.getTargets` → `Target.attachToTarget {flatten:true}` → `sendCommand({tabId, sessionId}, …)` |
| A | `chrome.debugger.getTargets()` → `chrome.debugger.attach({targetId})` → `sendCommand({targetId}, …)` |

The proof of reach is `location.href` read inside the child: a value containing `piaozone.com` means the
extension is evaluating in the assistant's own document.

### Q2. Does a `DataTransfer` built inside `Runtime.evaluate` and assigned to the hidden `multiple` file input trigger recognition?

ADR-0021 rejected an all-`chrome.debugger` extension for one reason: `DOM.setFileInputFiles` takes local paths,
and with the invoice originals on the server the extension has no path to give it. The way around it is to build
the `File` objects inside the page from bytes handed in, assemble a `DataTransfer`, and assign `input.files` —
which is what the content-script half of ADR-0021's hybrid was for. If that assignment can be made from
`Runtime.evaluate` instead, the content script is unnecessary and the hybrid collapses into one transport.

The spike does exactly that and nothing else: bytes in (read from a file the maintainer picks, standing in for
the server's `GET /erp/blobs/:sha256`), `File` built in the page, `DataTransfer` assembled, `input.files`
assigned, `input` and `change` dispatched, then the recognised rows read back.

**Acceptance or rejection can establish the mechanism.** The synthetic
`fixtures/generated/m05-caocao-invoice.pdf` contains fabricated invoice data. In Run 2 the assistant accepted
it and produced a row. Recognition is not proof of invoice authenticity. The sample must remain unselected
and must never be imported. Assignment, dispatched events, and the assistant response together are the evidence.

## What was built

`spike/piaozone-debugger-probe/` — an unpacked MV3 extension, deliberately outside the pnpm workspace and
deliberately throwaway. Plain JavaScript with no build step or dependencies. Four focused locator regression tests cover the
ambiguity found in Run 1; they do not replace the live ERP measurements.

| File | What it is |
| --- | --- |
| `manifest.json` | MV3, `debugger` + `tabs`, host permission for the ERP origin |
| `background.js` | Opens the panel. Nothing else — an MV3 service worker can be evicted mid-run |
| `panel.html` / `panel.css` / `panel.js` | The rehearsal, one button per step, all in a normal extension tab |
| `page.js` | Page-side expressions, ported from the executor's measured locators |
| `cdp.js` | `chrome.debugger` wrapped so every command passes the brake |
| `brake.js` | The four barriers, plus the self-test that proves them at load time |
| `RUNBOOK.zh-CN.md` | The maintainer's runbook (Chinese, because its reader is a person) |

### Why it cannot cross the consumption boundary

ADR-0025 puts invoice consumption at the 发票导入单据 click. A 排练 (rehearsal) must be structurally incapable
of reaching it, and "structurally" here means four independent barriers, each sufficient on its own:

1. **No code path names the button.** The caption appears only in `brake.js`'s forbidden list, and any command
   whose parameters mention it is refused — including a `Runtime.evaluate` expression that would find it by text.
2. **Every synthetic mouse event is hit-tested first**, and the point is refused when `document.elementFromPoint`
   answers with the import control. The hit test is re-read immediately before the click, never reused.
3. **The run seals itself read-only** the moment the upload has been attempted. After that every `Input.*`
   command and every scripted click is refused, so the last act of the spike is a read.
4. **No row is ever ticked.** The assistant imports the ticked rows; an empty selection has nothing to import.
   Reading the rows back is what #250 asks for, and ticking them is not.

`brake.js`'s `selfTest` exercises barriers 1-3 in the panel at load time and prints the verdicts, so the
maintainer sees the brake hold before the run starts. The runbook says to stop if any case fails.

One more thing the spike deliberately refuses: `DOM.setFileInputFiles`. It is the one route that could put bytes
into the file input without exercising the mechanism Q2 is about, so the brake rejects it outright.

## Observations (实际观察)

### Run 1 — 2026-09-21, stopped at a prerequisite

- **Run window:** `2026-09-21T07:25:50.568Z` through `2026-09-21T07:31:54.850Z`.
- **Environment:** Chrome user agent `153.0.0.0` on macOS.
- **Safety brake:** all 7 of 7 guard self-tests passed before the run.
- **Debugger prerequisite:** at `07:29:15`, `chrome.debugger.attach({tabId})` succeeded and
  `Target.setAutoAttach {flatten:true}` was accepted. Acceptance establishes only that the tab debugger and
  auto-attach setup were available; it does not establish reachability of the cross-origin iframe.
- **Draft prerequisite:** at `07:29:34`, the operator opened a new Expense reimbursement form
  (费用报销单-新增).
- **Blocking condition:** at `07:30:27`, step 4 stopped before it could open the invoice assistant. The
  redacted log excerpt was:

  ```text
  「收票信息」点不到：{"count":2,"ok":false}
  ```

  Accessibility inspection found two objects named Receipt information (收票信息): a tab and a section header.
  That is consistent with the exact-text locator's duplicate count. It is a prerequisite locator failure, not a
  negative result for Q1.
- **Teardown:** at `07:31:54`, the debugger detached. The operator then used ERP Exit (退出) to abandon the
  empty unsaved draft and returned to My expense reimbursements (我的费用报销), with no save prompt.
- **Side-effect boundary:** this run did not open the invoice assistant, upload, import, save, delete, or select
  an invoice.
- **Log hygiene:** the raw local log is deliberately not copied here. This record retains only the redacted
  excerpt needed to explain the stop and omits all `href`, session, and target values.

### Answer state after Run 1

- **Q1 — reach:** **UNANSWERED.** Step 5 did not run, so no route B/C/A result, child target, or child-document
  `location.href` was observed.
- **Q2 — DataTransfer:** **UNANSWERED.** Steps 6-8 did not run, so no file input, assignment, dispatched event,
  recognition, rejection, or recognised-row observation exists.

### Run 2: both probes passed

- Run window: `2026-09-21T07:44:59.510Z` through `2026-09-21T07:54:47.068Z`; Chrome user agent
  `153.0.0.0` on macOS; all seven brake checks passed.
- Step 3 timed out at `07:47:36`: `「新增」点不到：{"count":0,"ok":false}`. The agent switched to ERP
  and clicked the visible New (新增) control, as the runbook permits. The cause of this timeout remains unverified.
- Step 4 passed with the revised Receipt information locator. The probe used its Kendo-toggle fallback
  and confirmed `tbNotFillEntry` before selecting Do not generate expense details (不生成费用明细).
- At `07:50:28`, route B succeeded with child type `iframe`. Event source keys were `["tabId"]`, with no
  `sessionId` on the event source. Route A also succeeded, with target type `other`. Route C failed with
  `{"code":-32000,"message":"Not allowed"}`. The probe selected B for subsequent commands.
- At `07:51:03`, exactly one file input was observed: hidden, enabled, `multiple=true`, zero-sized,
  `filesNow=0`, with React internals. Its accept list included PDF and image formats.
- At `07:53:21`, the probe staged `m05-caocao-invoice.pdf` (52,863 bytes, `application/pdf`). Assignment
  returned `ok=true`, `assignError=null`, one item/file, and `fired=["input","change"]`. It then became read-only.
- At `07:53:41`, readback returned one new Digital invoice (数电票) row, `processing=false`, `checked=false`,
  invoice number `26312000000099830115`, total `38.40`, tax `1.12`, date `2026-08-11` and notice Upload complete
  (上传完成). This is synthetic test data, not an invoice for reimbursement.
- At `07:54:47`, the debugger detached. The agent closed the assistant and used Exit to abandon the draft.
  ERP returned to My expense reimbursements without a save prompt. No import, invoice selection, save or delete occurred.

The panel observation below preserves the downloaded text apart from removing URL query parameters and
runtime target/session identifiers. Full raw logs remain local because they contain session-bearing URLs.

```text
运行时间：2026-09-21T07:44:59.510Z — 2026-09-21T07:54:47.068Z
浏览器：Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36
防误点自检：全部通过
问题①（chrome.debugger 能否触达 piaozone iframe）：能，经路径 B
  - 路径 B（Target.setAutoAttach + {tabId, sessionId}）：成功，location.href = https://www.piaozone.com/m4-web/fpzs/index?<REDACTED>
  - 路径 C（undefined）：失败 — {"code":-32000,"message":"Not allowed"}
  - 路径 A（chrome.debugger.getTargets + attach({targetId})）：成功，location.href = https://www.piaozone.com/m4-web/fpzs/index?<REDACTED>
  - 自动挂接看到的子目标：[{"type":"iframe","url":"https://www.piaozone.com/m4-web/fpzs/index?<REDACTED>","targetId":"<REDACTED>"}]
  - Target.* 事件 source 上的字段：["tabId"]
问题②（Runtime.evaluate 里的 DataTransfer 能否触发识别）：见下面两行的实测值，不要在这里填结论
  - 注入的文件：[{"name":"m05-caocao-invoice.pdf","size":52863,"type":"application/pdf"}]
  - 赋值结果：{"assignError":null,"assigned":[{"name":"m05-caocao-invoice.pdf","size":52863,"type":"application/pdf"}],"built":{"files":1,"items":1},"fired":["input","change"],"ok":true}
  - 回读：助手共 1 行，本次新增 1 行，当前分页 数电票
  - 分页：[{"active":true,"caption":"数电票 1","count":1,"index":0,"label":"数电票"}]
  - 行：[{"cells":["","某某出行科技(上海)有限公司","26312000000099830115","38.40","1.12","2026-08-11","",""],"checked":false,"number":"26312000000099830115"}]
  - 助手提示：["上传完成"]
上传前助手里已有的行数：0
文件控件现状：{"count":1,"inputs":[{"accept":".ofd,.xml,.zip,.pdf,.xls,.xlsx,.png,.jpg,.jpeg,.bmp,.gif,.tif,.tiff","ancestors":["SPAN.ant-upload","DIV.ant-upload.ant-upload-select.ant-upload-select-text","SPAN.inlineBlock","DIV.search.clearfix","DIV.selectInvoiceBox.upload"],"disabled":false,"display":"block","filesNow":0,"frameworkKeys":["__reactInternalInstance$a0r5d3oaxd","__reactEventHandlers$a0r5d3oaxd","_valueTracker"],"hidden":true,"multiple":true,"rect":{"height":0,"width":0}}]}
本次排练没有点过导入控件，也没有勾选过任何识别结果：探针里没有这两条代码路径，刹车自检（上方）是它的证据。
```

### Decision and limits

Both mechanisms passed for this Chrome build and one synthetic PDF. ADR-0021 now records full
`chrome.debugger` execution for browser-extension V1, including byte-based upload through `Runtime.evaluate`.
The existing route B in `extension/src/debugger-session.ts` remains unchanged, as does the isolated
`putFilesInPage` implementation. This run did not exercise real invoices, multiple-file batches, Edge,
worker restart, re-attach, automatic recovery, invoice import, detail filling, or saving.

### Reopening after an upload-only draft: UNANSWERED

After abandoning Run 2's draft, the agent opened another empty draft and selected Receipt information.
The native click on the invoice dropdown arrow did not open the menu, so the assistant itself was never
reopened. The agent exited this extra draft without saving. This is an inconclusive UI prerequisite,
not evidence that the assistant cannot reopen. Persistence of the uploaded synthetic row is also unverified;
no existing assistant data was deleted. The repeatability question in ADR-0025 remains open.
