# Before 暂存, baox re-runs 去报销 on a fresh form by itself

**Status: proposed (2026-10-11), together with ADR-0033.** This amends ADR-0016, under which an action after an attempt
is never replayed but reconciled, and ADR-0024, under which 重新去报销 happens only when the user clicks it. Both
amendments apply only before the 暂存 attempt. Decided with the owner in the 2026-10-11 stability review.

The most common failure is a run that stops on a transient exception and waits for a person: a slow page, a stray
ERP dialog, or a lost session. Before 暂存, everything a run has written lives in an unsaved 新增 form with no 单据编号.
- Discarding that form leaves nothing in ERP to clean up.
- Re-importing the same invoices into a fresh form overwrites their receipt record (ADR-0026).
- The one case that blocks is an invoice already bound to a *saved* bill (V-63).

So a run that fails there can safely start over, and making a person click 重新去报销 adds a wait without adding any
safety.

## Decisions

- **When it happens.** A run that fails after its import or fill attempt, but before its 暂存 attempt has started,
  becomes an **自动重新去报销**: the form is discarded and the run starts again on a fresh 新增 form.
- **Precondition, every time.**
  - A read-only WebAPI query must show that no saved bill of this ERP account holds any of the task's invoices.
  - It must also show no draft carrying the task's ownership marker.
  - If either check fails or cannot be answered, there is no re-run, only 对账.
- **Limit.** At most two automatic re-runs per 去报销, each recorded with its cause. When they are used up, the
  disposition is 原地等待, with 重新去报销 left to the user as today.
- **After the 暂存 attempt has started**, nothing is re-run. The result is reconciled through WebAPI by the ownership
  marker:
  - exactly one matching draft whose model agrees with the plan → **ERP 草稿已交接**;
  - anything else → 转人工.
- **Naming.** ADR-0024's rule stands: this is never labelled 重试 in the UI. It is 自动重新去报销, a disposition baox
  takes, and the page shows it as such, for example 「已自动换一张新单重新填报（第 1 次）」.

## Considered Options

- **Keep every post-attempt failure a 对账 the user resolves.** Rejected. It is the current behaviour and the most
  common complaint, and before 暂存 it buys no safety.
- **Resume in place (per-row checkpoints).** Rejected for v1. Resuming relies on the half-filled form's DOM state
  surviving the failure, while a fresh form needs nothing from the failed one.
