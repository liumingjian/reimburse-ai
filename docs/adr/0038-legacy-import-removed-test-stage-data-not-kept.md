# The legacy import is removed; test-stage data is not carried forward

**Status: accepted (2026-10-18).** Decided with the owner in the same grill as
[ADR-0037](0037-local-executor-is-the-only-way-to-reimburse.md). It supersedes the legacy-import half of
[ADR-0015](0015-sqlite-facts-and-legacy-import.md) (its SQLite facts half stays) and the **Legacy import** decision of
[ADR-0018](0018-local-app-accounts-and-admin-role.md).

baox is still in its test stage. Until the owner announces a real rollout to employees, no change keeps compatibility
with already-deployed servers, components installed on employee PCs, or historical task data. So the one-time import
of the old Skill-era baox (`~/.baox`, `BAOX_HOME`) at first-admin creation is deleted with everything that exists only
for it: its tables and the task's origin, the 设置页's 旧数据导入 section, and the legacy ERP results, so ERP 单据已交接
is gone for good. The rest of the Skill era goes too: the provenance comments pointing into the deleted kernel, the
guard test against its directories coming back, and the superseded design and research documents. ADR files stay as
the record of what was decided.

## Consequences

- The legacy claims kept invoices the old baox had already pushed into ERP from being claimed again, in any account.
  Without them, only ERP's own 「重复报销，禁止导入」 at 「发票导入单据」
  ([ADR-0025](0025-invoice-consumption-begins-at-the-import-click.md)) catches such an invoice, late in 去报销 after the
  employee has done the preparation. Accepted: there are few such invoices, and ERP still prevents the double
  reimbursement.
- Revisit "no compatibility" when baox is rolled out to employees for real.
