import type { ReactNode } from 'react';
import { Column, Grid } from '@carbon/react';

// Field grid (字段网格, DESIGN.md「版式统一」): label-01 label above the value, fields in equal columns on Carbon's
// CSS grid, so every row lines up. For up to about six overview fields; many fields read row by row go in a
// DetailList. Replaces 「A · B · C」 strings and 「来源：…」 colon text (DESIGN.md「标题与版式」).
export type Field = { readonly label: string; readonly value: ReactNode };

// Columns per row on large screens (Carbon's 16 columns split evenly only into these); medium screens get two,
// small screens one.
export type FieldColumns = 2 | 4;

export function FieldGroup({ fields, label, columns = 4 }: { fields: readonly Field[]; label?: string; columns?: FieldColumns }) {
  return (
    <Grid as="dl" narrow fullWidth className="app-fields" {...(label ? { 'aria-label': label } : {})}>
      {fields.map((field) => (
        <Column key={field.label} as="div" sm={4} md={4} lg={16 / columns} className="app-field">
          <dt className="app-field-key">{field.label}</dt>
          <dd className="app-field-value">{field.value}</dd>
        </Column>
      ))}
    </Grid>
  );
}
