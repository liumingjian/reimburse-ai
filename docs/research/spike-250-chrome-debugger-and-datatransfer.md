# Spike #250 — can `chrome.debugger` reach the piaozone iframe, and does a `DataTransfer` built in `Runtime.evaluate` trigger recognition

**Status: UNANSWERED.** The instrument exists; it has not been run. Every result section below says so
explicitly, and none of them has been filled in with what we expect to happen. Ticket
[#250](https://github.com/liumingjian/reimburse-ai/issues/250), spec
[#246](https://github.com/liumingjian/reimburse-ai/issues/246).

## Why this is a document about an unrun experiment

The spike is built by an agent and run by the maintainer. The extension has to take over a browser that is
already logged into the live ERP, on the maintainer's own machine, with the maintainer's own account. No agent
can do that, and an agent that wrote down an outcome it did not watch would be inventing evidence for the one
decision — ADR-0021's fill technique — that the spec deliberately refuses to make on anything but measurement.

So this file is committed empty of answers on purpose. It is the sheet the observations get written onto,
and the runbook (`spike/piaozone-debugger-probe/RUNBOOK.zh-CN.md`) ends by telling the maintainer to paste them
into the "Observations" section below, replacing the word UNANSWERED. Until that happens, the two questions are
open and everything downstream of them is provisional.

## The two questions

### Q1. Can `chrome.debugger` reach the 发票无忧助手 (invoice assistant) cross-origin iframe?

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

**A rejection counts as a pass for the mechanism.** ADR-0025 already fixed this: the synthetic
`fixtures/generated/m05-caocao-invoice.pdf` carries a fabricated 发票号码 and seller, so the assistant is
expected to refuse it — and a refusal still proves the bytes reached the input and the control fired, which is
all the `DataTransfer` route has to demonstrate. It also keeps real invoices away from a third party.

## What was built

`spike/piaozone-debugger-probe/` — an unpacked MV3 extension, deliberately outside the pnpm workspace and
deliberately throwaway. Plain JavaScript, no build step, no dependencies, no tests: it is an instrument, not a
package, and the thing it measures is the live ERP, which no test in this repo can stand in for.

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

**UNANSWERED — not run yet.**

Nothing has been observed. This section is to be replaced by the panel's "复制观察结果" output, verbatim,
plus the run log. Do not fill it from the sections above.

- Chrome/Edge build the run happened on: *unanswered*
- Brake self-test verdicts: *unanswered*
- **Q1 — reach:** *unanswered.* Per-route outcome (A / B / C), the child targets seen, the fields present on
  `Target.*` event sources, and the `location.href` read inside the child: all *unanswered*.
- **Q2 — DataTransfer:** *unanswered.* What the input held after assignment, whether the assignment threw,
  which events fired, and what the assistant did next: all *unanswered*.
- Recognised rows read back (count, 票种 panes, 发票号码 per row, any rejection notice): *unanswered*
- Whether the assistant reopens after an upload that was never imported: *unanswered* (see below).

## What the answers decide — and what is deliberately not written yet

**ADR-0021 is not amended by this document, and must not be until the spike has passed.** The spec is explicit:
the amendment from the content-script/debugger hybrid to all-`chrome.debugger` is written *after* the spike
passes, not before. `docs/design/browser-extension-v1.md` records the intended amendment as intent; this file is
the evidence it waits on, and the evidence is not in yet.

- **Both pass** → ADR-0021 is amended, in its own commit, citing this document's Observations section.
- **Q2 fails** → stop and report. Option B of ADR-0021 (the content-script half of the hybrid) relies on the
  same `DataTransfer` mechanism and would fail with it, so the design round reopens rather than falling back.
- **Q1 fails, Q2 passes** → the hybrid survives as ADR-0021 already has it, and the extension needs a content
  script for whatever `chrome.debugger` cannot reach. Nothing to amend.

## An open question this run can settle for free

ADR-0025 leaves one thing unsettled about repeatability: the corpus records both that the assistant cannot be
reopened in the same page instance after an import (`docs/research/erp-expense-flow/verification-ledger.md:90`,
V-45) and that it can (`docs/research/erp-expense-flow/save-contract.md:621`). Both records describe reopening
*after an import*. The rehearsal's own shape — upload, never import, abandon the bill, reopen — has never been
observed by anyone.

It costs nothing to find out, because it consumes nothing. The runbook therefore asks the maintainer to note,
if they run the rehearsal twice, whether the assistant loaded the second time. Until then "infinitely
repeatable" is the expectation, not a verified property.
