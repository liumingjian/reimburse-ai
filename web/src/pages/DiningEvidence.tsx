import { useRef, useState } from 'react';
import { Button, Select, SelectItem } from '@carbon/react';
import { UPLOAD_ACCEPT_ATTRIBUTE, type DiningAssignment, type PendingItem } from '@baox/contract';

export function DiningInvoiceSelect({ assignment, value, onChange, disabled, id, blankLabel, error }: {
  assignment: DiningAssignment; value: string; onChange: (value: string) => void; disabled: boolean; id: string; blankLabel: string; error?: string | undefined;
}) {
  const selection = assignment.selection;
  const stale = selection.kind === 'selected_stale' && !assignment.options.some((option) => option.invoiceId === selection.invoiceId);
  return (
    <Select id={id} labelText="关联餐饮发票" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} invalid={!!error} invalidText={error}>
      <SelectItem value="" text={blankLabel} />
      {stale && assignment.selection.kind === 'selected_stale' ? <SelectItem value={assignment.selection.invoiceId} text="原选择已不可用" disabled /> : null}
      {assignment.options.map((option) => <SelectItem key={option.invoiceId} value={option.invoiceId} text={option.label} />)}
    </Select>
  );
}

export function DiningEvidence({ item, disabled, onUpload, onAssign }: {
  item: PendingItem; disabled: boolean; onUpload: (files: readonly File[]) => Promise<void>; onAssign: (address: string, value: string) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const dining = item.dining;
  const assignment = dining?.kind === 'receipt' ? dining.assignment : null;
  const [value, setValue] = useState(assignment?.selection.kind === 'selected_valid' || assignment?.selection.kind === 'selected_stale' ? assignment.selection.invoiceId : '');
  if (!dining) return null;
  const uploadLabel = dining.supplement === 'receipt' ? '补传餐饮小票' : '补传餐饮发票';
  return (
    <div className="app-form">
      {assignment ? <form className="app-form" aria-label="餐饮发票关联设置" onSubmit={(event) => { event.preventDefault(); void onAssign(assignment.address, value || 'auto'); }}>
        <DiningInvoiceSelect id={`dining-${item.itemId}`} assignment={assignment} value={value} onChange={setValue} disabled={disabled} blankLabel="重新按金额配对" />
        <p className="app-caption">发票选择不会修改小票实付金额。两份原件的金额必须精确到分一致。</p>
        <Button type="submit" size="md" disabled={disabled}>保存关联</Button>
      </form> : null}
      {item.status === 'open' && dining.supplement ? <>
        <input ref={input} type="file" multiple accept={UPLOAD_ACCEPT_ATTRIBUTE} aria-label={uploadLabel} hidden disabled={disabled} onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length) void onUpload(files);
        }} />
        <Button kind="secondary" size="md" disabled={disabled} onClick={() => input.current?.click()}>{uploadLabel}</Button>
      </> : null}
    </div>
  );
}
