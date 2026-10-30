# Project serials, project numbers, and ERP official names are distinct

**Status: accepted and implemented (2026-10-30).** Decided with the owner during the project import design.
Amends ADR-0039's project-book name replacement rule.

The supplied ERP Excel export has three separate columns: 项目序号, 项目号, and 项目名称. The existing application calls
the ERP matching identifier 项目号 and its other project-book field 项目名称. Those labels obscure which values to import.

## Decision

- Call the matching identifier 项目序号. It remains the key for uniqueness and exact ERP matching.
- Store the export's descriptive 项目号 as the project book's 项目号. The import does not read the 项目名称 column.
- Keep the ERP official name separate. Use it for ERP execution and readback without overwriting the project book's
  项目号. Do not infer that the export's 项目号 or 项目名称 is the ERP query's `FName` from the header alone.
- Use these terms consistently in project books, manual entry and editing, and task project selection.
- Preserve the personal and public project books' existing maintenance permissions.

## Consequences

Simply relabeling the current fields would leave ADR-0039's name replacement behavior in place. A later ERP check
could then erase the imported project number. Separate values preserve the employee's project designation and
the ERP name required for readback. Preserve existing project-book name values as project numbers until the employee
edits them or confirms an import update. Preserve existing task confirmation records without rewriting their values.

Import workflow decisions and unresolved questions are recorded in
[Project book batch import](../design/project-book-import.md).
