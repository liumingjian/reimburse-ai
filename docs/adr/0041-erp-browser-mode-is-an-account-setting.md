# ERP browser visibility is an account setting; the local executor remains the only user path

Status: accepted by the owner, 2026-10-30. Amends [ADR-0033](0033-headless-executor-with-hosted-erp-credentials.md).
The single executor path in [ADR-0037](0037-local-executor-is-the-only-way-to-reimburse.md) remains in force.

## Context

Employees need background reimbursement. Engineers also need to watch the browser while diagnosing ERP behaviour.
The development QA script previously selected a separate headed CDP adapter by default, so manual QA could bypass
the paired local executor and miss its behaviour.

## Decision

- Store `browserMode` per application account, separately from ERP credentials. Valid modes are `headless` and
  `headed`. New accounts and existing accounts without a setting use `headless`.
- Expose the setting on 设置页 as 无头（默认） and 有头（调试）. Saving changes only the preference. It neither starts
  an ERP action nor changes credentials, authorisation, pairing or an active browser.
- Read the setting once for each outgoing 去报销, 对账 or 试登录 request. Carry it beside the plan and credentials.
  A running job retains its selected mode; a later request uses the latest saved setting.
- Both modes use the paired 本地执行器, the same login, write checks, 暂存 and browser cleanup. The sole difference
  is whether the executor shows its dedicated browser window. Headed mode does not permit manual takeover during
  an automated job and does not switch to the development CDP adapter.
- Clearing credentials, signing out and revoking pairing preserve the preference. 完全重置 clears only the current
  account's preference and restores headless.
- Require 本地执行器 1.2.0 or newer. Older clients would ignore the requested headed mode. Requests without the
  optional wire field remain headless; explicit invalid values are rejected.
- Default development QA to `paired`. Keep `BAOX_DEV_ERP=cdp` as an explicit adapter-debugging override. An adapter
  test alone does not prove the paired user flow.

## Alternatives

Storing the preference in the credential row would make clearing or replacing a password reset browser visibility.
Adding it to the credential service would couple a display preference to secret handling. An independent account
setting keeps those lifecycles separate.
