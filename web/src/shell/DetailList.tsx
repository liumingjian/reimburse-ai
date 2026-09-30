import type { ReactNode } from 'react';
import { StructuredListBody, StructuredListCell, StructuredListRow, StructuredListWrapper } from '@carbon/react';
import type { Field } from './FieldGroup';

// Detail list (详情列表, DESIGN.md「版式统一」): label left, value right, one row per field, on Carbon's condensed
// flush StructuredList. For many fields read row by row (a material's recognised fields). A panel uses either this or
// a FieldGroup, never both.
export function DetailList({ fields, label, children }: { fields: readonly Field[]; label: string; children?: ReactNode }) {
  return (
    <StructuredListWrapper className="app-detail-list" isCondensed isFlush aria-label={label}>
      <StructuredListBody>
        {fields.map((field) => (
          <StructuredListRow key={field.label}>
            <StructuredListCell className="app-detail-key" noWrap>
              {field.label}
            </StructuredListCell>
            <StructuredListCell className="app-detail-value">{field.value}</StructuredListCell>
          </StructuredListRow>
        ))}
        {children}
      </StructuredListBody>
    </StructuredListWrapper>
  );
}
