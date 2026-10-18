# The extension fills through chrome.debugger and ships unpacked

**Status (2026-10-18): superseded by [ADR-0037](0037-local-executor-is-the-only-way-to-reimburse.md); the extension is gone. The version gate lives on for the 本地执行器 (ADR-0035).**

**Status: amended for browser-extension V1 on 2026-09-21 after live spike #250 passed.**
The original content-script/debugger hybrid below is superseded for V1.
[Measured results](../research/spike-250-chrome-debugger-and-datatransfer.md#run-2-both-probes-passed)
show route B reaching the cross-origin invoice assistant and a byte-built `DataTransfer` triggering recognition.
One synthetic PDF was tested on Chrome/macOS, with manual draft-opening assistance; this is not an end-to-end acceptance claim.

How the extension actually drives the 金蝶 K3Cloud (Kingdee K3Cloud) page, which browsers that limits us to, how it reaches employees' machines, and what the distribution channel costs. These are one decision because the technique forces the `debugger` permission and the channel determines what that permission costs. Decided in [#225](https://github.com/liumingjian/reimburse-ai/issues/225).

## Decisions

- **File upload goes through `chrome.debugger` and `Runtime.evaluate`.** Build `File` objects from bytes the server sends, assemble a `DataTransfer`, assign `input.files`, and dispatch `input` and `change`. No local path or upload content script is required. Reach the assistant through `Target.setAutoAttach {flatten:true}` and `{tabId, sessionId}` (route B).
- **The detail grid goes through `chrome.debugger`**, using `Input.dispatchKeyEvent` to produce genuine trusted events.
- **Chrome and Edge only.** Written into scope, not left implicit.
- **Distribution is load-unpacked in developer mode.** Employees use personal machines; Chrome is not under enterprise policy.
- **The debugger banner is permanent and must be designed around.** No policy is available to silence it. The product tells the user the banner is expected, and treats its *Cancel* button as a control loss (ADR-0020).
- **The extension reports its version on pairing and on every connect; the server enforces a minimum and refuses to connect below it**, with upgrade instructions.

## Considered Options

- **A debugger-free extension.** Rejected on measured evidence: Kendo controls ignore programmatic assignment — writing `value` and dispatching `input`/`change` leaves the control's internal state stale — and a synthesized Meta+A select-all demonstrably failed, leaving concatenation artefacts (`客户支持客户支持`, `0.0018.25`). Non-`isTrusted` events are not reliable on the detail grid.
- **Everything through `chrome.debugger`.** Originally rejected because `DOM.setFileInputFiles` requires local paths. Selected for V1 after spike #250 showed that `Runtime.evaluate` can build a `DataTransfer` from bytes and trigger recognition. The earlier rejection incorrectly assumed that debugger uploads required local paths.
- **Content-script/debugger hybrid.** Previously selected; superseded for V1 because the measured debugger route handles both upload and trusted input without a second transport.
- **Firefox and Safari support.** Rejected: `chrome.debugger` is Chromium-only with no equivalent, and K3Cloud is in practice only seriously tested on Chromium. Supporting Firefox would be a second executor, not an adaptation.
- **Chrome Web Store, unlisted.** A reasonable default that needs no IT involvement, but it was not chosen: with personal, unmanaged machines there is no IT to involve either way, and store review adds a gate for a permission (`debugger`) that attracts scrutiny. *Re-examined 2026-09-29 together with Edge Add-ons (hidden listing), the only store reachable from mainland China without a proxy; both rejected again: baox is for internal company use only, and a store listing would put an internal tool in a public catalogue.*
- **Self-hosted CRX.** Rejected 2026-09-29: it installs nowhere on these machines. Since Chrome 75 a CRX3 without the Web Store's publisher proof fails with `CRX_REQUIRED_PROOF_MISSING`; on Windows and macOS off-store installs work only through enterprise policy, and Chrome and Edge ignore off-store force-install policy on machines not joined to a domain or MDM. A zip plus load-unpacked is the only off-store route that works.
- **Enterprise force-install.** Not available: the machines are not managed, which also removes any policy that could silence the debugger banner.
- **Best-effort backwards compatibility with old extensions.** Rejected. ADR-0016's fill protocol is coarse — the server hands down one whole plan. An old extension receiving a new plan shape does not fail cleanly; worst case it executes half of it, leaving fields written and invoices imported. That lands in the most expensive 对账 breakpoint, 未知 (unknown). Refusing to connect costs "no reimbursement today, go update"; allowing it costs an irreversible ERP write of undecidable outcome. Maintaining a fill path per historical version is also not feasible when we cannot know which version a user is running.

## Consequences

- The extension manifest requests `debugger`, and the permission is unavoidable for the product to work.
- There is no auto-update; version negotiation is load-bearing rather than a nicety, and a server upgrade can strand users until they replace their unpacked directory.
- An upgrade overwrites the same unpacked directory and clicks reload. That keeps the extension ID and `chrome.storage.local`, so the pairing survives and upgrade instructions never ask the user to pair again. A new directory is a new extension with no pairing; one-click pairing (ADR-0019) restores it.
- Upgrade instructions are a user-facing deliverable, not documentation trivia.
- The `DataTransfer` route is verified by 排练 (rehearsal), never by a live save-run (see [#230](https://github.com/liumingjian/reimburse-ai/issues/230)).
