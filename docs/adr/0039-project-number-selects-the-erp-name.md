# Project numbers select the official ERP project name

**Status: accepted (2026-10-30).** Decided with the owner. Amends the name-matching part of ADR-0008 and the
project-book definitions in the glossary.

**Amended by [ADR-0042](0042-project-serial-and-project-number-are-distinct.md)**: the matching identifier is now
called 项目序号. The project book's 项目号 is separate from the ERP official name and must not be overwritten by it.
ADR-0042 is implemented.

Employees remember project numbers but often enter abbreviated project names. Requiring the local name to match
the full ERP name blocks reimbursement without changing which project the employee intended to select.

## Decision

- Match projects by number. Require exactly one ERP record, an official nonempty name, audited status and enabled
  status. Missing, ambiguous, unaudited and disabled projects still block invoice import.
- Adopt the ERP name for the current task's execution plan and displayed project. Name differences do not require
  the employee to repeat confirmation. Preserve the chosen project number and the original confirmation evidence.
- Update only the source book entry selected by this task: the employee's personal entry or the public entry.
  Do not update another employee's personal entry merely because it has the same number.
- Treat this as an ERP-backed name correction. Preserve deadlines, availability and book ownership. Ordinary
  members do not gain manual maintenance rights over public projects.
- Keep exact code/name validation for expense items. This decision does not permit fuzzy project-number matching.

## Alternatives

Keeping strict names preserves an unnecessary manual step. Rewriting the employee's original confirmed selection
would erase what they confirmed and change its digest. Instead, record the ERP observation and apply its official
name to this task's execution and presentation while retaining that evidence.
