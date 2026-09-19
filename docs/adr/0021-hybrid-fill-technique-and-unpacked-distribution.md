# The extension fills through a hybrid of content script and chrome.debugger, and ships unpacked

How the extension actually drives the 金蝶 K3Cloud (Kingdee K3Cloud) page, which browsers that limits us to, how it reaches employees' machines, and what the distribution channel costs. These are one decision because the technique forces the `debugger` permission and the channel determines what that permission costs. Decided in [#225](https://github.com/liumingjian/reimburse-ai/issues/225).

## Decisions

- **File upload goes through the content script.** Build `File` objects from bytes the server sends, assemble a `DataTransfer`, assign `input.files`. No local path is involved.
- **The detail grid goes through `chrome.debugger`**, using `Input.dispatchKeyEvent` to produce genuine trusted events.
- **Chrome and Edge only.** Written into scope, not left implicit.
- **Distribution is load-unpacked in developer mode.** Employees use personal machines; Chrome is not under enterprise policy.
- **The debugger banner is permanent and must be designed around.** No policy is available to silence it. The product tells the user the banner is expected, and treats its *Cancel* button as a control loss (ADR-0020).
- **The extension reports its version on pairing and on every connect; the server enforces a minimum and refuses to connect below it**, with upgrade instructions.

## Considered Options

- **A debugger-free extension.** Rejected on measured evidence: Kendo controls ignore programmatic assignment — writing `value` and dispatching `input`/`change` leaves the control's internal state stale — and a synthesized Meta+A select-all demonstrably failed, leaving concatenation artefacts (`客户支持客户支持`, `0.0018.25`). Non-`isTrusted` events are not reliable on the detail grid.
- **Everything through `chrome.debugger`.** Rejected: uploads would need `DOM.setFileInputFiles`, which accepts local paths only. With the originals on the server, the extension has no path to give it. The `DataTransfer` route has already been demonstrated working on this exact page.
- **Firefox and Safari support.** Rejected: `chrome.debugger` is Chromium-only with no equivalent, and K3Cloud is in practice only seriously tested on Chromium. Supporting Firefox would be a second executor, not an adaptation.
- **Chrome Web Store, unlisted.** A reasonable default that needs no IT involvement, but it was not chosen: with personal, unmanaged machines there is no IT to involve either way, and store review adds a gate for a permission (`debugger`) that attracts scrutiny.
- **Enterprise force-install.** Not available: the machines are not managed, which also removes any policy that could silence the debugger banner.
- **Best-effort backwards compatibility with old extensions.** Rejected. ADR-0016's fill protocol is coarse — the server hands down one whole plan. An old extension receiving a new plan shape does not fail cleanly; worst case it executes half of it, leaving fields written and invoices imported. That lands in the most expensive 对账 breakpoint, 未知 (unknown). Refusing to connect costs "no reimbursement today, go update"; allowing it costs an irreversible ERP write of undecidable outcome. Maintaining a fill path per historical version is also not feasible when we cannot know which version a user is running.

## Consequences

- The extension manifest requests `debugger`, and the permission is unavoidable for the product to work.
- There is no auto-update; version negotiation is load-bearing rather than a nicety, and a server upgrade can strand users until they replace their unpacked directory.
- Upgrade instructions are a user-facing deliverable, not documentation trivia.
- The `DataTransfer` route is verified by 排练 (rehearsal), never by a live save-run (see [#230](https://github.com/liumingjian/reimburse-ai/issues/230)).
