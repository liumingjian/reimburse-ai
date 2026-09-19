# A reconnect restores the channel, not the page

ADR-0016 persists `attempt_started` before the first mutation, and treats any loss after it as **ERP 写入结果未知 (ERP write outcome unknown)** → 对账 (reconciliation), never a replay. That was affordable while "loss" meant a server crash. With the executor in a remote browser, losing the connection mid-write becomes an ordinary event, and the rule needs a shape that survives it without weakening. Decided in [#224](https://github.com/liumingjian/reimburse-ai/issues/224).

## Decisions

- **A reconnection window.** Within a bounded window the extension may reconnect and resume the event stream by `jobId`. This decouples two things that used to be one: *the event stream was interrupted* (recoverable) from *the ERP write outcome is unknown* (not recoverable).
- **The disciplines are untouched.** `attempt_started` is still persisted before the first mutation. The server still owns judgement; the executor still only observes. Nothing is ever replayed.
- **A reconnect restores the channel, not the page.** After reconnecting, the extension must re-observe before doing anything: the same bill, the same ERP identity, the 发票助手 (invoice assistant) in a recognisable state. Anything uncertain goes to one of the six 对账 breakpoints.
- **The 发票助手 is one-shot.** Once closed it cannot be reopened, so a restored event stream carries no information about whether filling can continue. This is why re-observation is mandatory rather than advisory.
- **A `chrome.debugger` detach is the same event as a disconnect.** If `attempt_started` exists, go to 对账. If it does not, abort in place and tell the user plainly that **no ERP write happened** and the job can simply be run again.

## Considered Options

- **Apply the existing rule verbatim: any disconnect means unknown.** Rejected as the default. The semantics are clean, but it turns 对账 from an exceptional path into a frequent one — a closed laptop lid would cost a manual reconciliation.
- **Let the extension finish the remaining steps on its own and report back.** Rejected outright. It voids `server owns judgement, executor only observes`, which is the foundation the no-replay rule stands on.
- **Re-attach the debugger and continue optimistically.** Rejected: re-attaching restores a channel to a page nobody observed during the gap, when the user may have clicked, closed or navigated. Continuing would be vouching for it.
- **Stop and ask the user whether to continue.** Rejected: better than continuing silently, but it moves the judgement to the party least able to know what state the page is in.

## Consequences

- The ERP job gains an explicit re-observation step on resume, with its own outcome feeding the existing 对账 classification.
- The "Chrome is being debugged" banner's *Cancel* button is a first-class, expected event with a defined disposition, not an error.
- `转人工` and 对账 remain the only two dispositions; nothing here adds a third.
