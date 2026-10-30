# ERP expense details use gross amounts and zero tax

**Status: accepted (2026-10-30).** Requested by the owner. Supersedes the expense-detail money mapping in the
earlier ERP save contract and verification notes. Their receipt and invoice evidence remains valid.

## Decision

- For every ERP expense-detail row, write the candidate line's gross total to 费用金额 and `0.00` to 税额.
  This applies to every supported invoice kind, including rail tickets and split transport lines.
- ERP renders a committed zero detail tax as an empty cell (maintainer QA, 2026-10-30). Treat an explicitly
  readable empty detail-tax cell as zero during write verification and reconciliation. Missing columns, failed
  reads, nonzero tax and empty values in other amount columns remain errors. Receipt tax retains its original
  evidence and validation rules.
- Preserve the original invoice net amount and tax amount. Preserve ERP receipt net/tax/gross amounts and their
  identity and conservation checks. This is an ERP detail-entry rule, not a correction to invoice facts.
- Use one amount projection for writing, pre-draft verification, reconciliation and the expected values displayed
  in the readback table. Each split line uses its own confirmed gross total.
- Keep the ERP-computed claimed-amount check. Compare the saved draft with the verified detail values and the
  unchanged receipts. Do not loosen correctness checks to accommodate the new mapping.

## Alternatives

Overwriting invoice net/tax fields with gross/zero would lose evidence and make valid nonzero-tax receipts fail
validation. Changing only the final keystrokes would make readback disagree with the intended form. The separate
ERP detail projection preserves both the source facts and the requested entry rule.
