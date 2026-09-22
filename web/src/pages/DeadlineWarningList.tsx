import { PROJECT_DEADLINE_WARNING_COPY, type ProjectDeadlineWarning } from '@baox/contract';

export function DeadlineWarningList({ warnings }: { warnings: readonly ProjectDeadlineWarning[] }) {
  return (
    <ul className="app-reselect" aria-label="截止日期提醒明细">
      {warnings.map((warning) => (
        <li key={`${warning.lineId}-${warning.projectNumber}-${warning.kind}`}>
          {warning.kind === 'after_deadline'
            ? PROJECT_DEADLINE_WARNING_COPY.afterDeadline(warning.lineNo, warning.projectNumber, warning.deadlineOn)
            : PROJECT_DEADLINE_WARNING_COPY.stayCrossesDeadline(warning.lineNo, warning.projectNumber, warning.deadlineOn)}
        </li>
      ))}
    </ul>
  );
}
