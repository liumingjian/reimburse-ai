import { Select, SelectItem } from '@carbon/react';
import { PAYMENT_COPY, PAYMENT_STAY_FIELD, type Material, type TaskSnapshot } from '@baox/contract';
import { ActionError } from '../shell/ActionError';
import { useAction } from '../shell/useAction';

// 改归属 (ADR-0032): which 住宿 invoice a 支付截图 counts for. The server places it at every inventory; picking a stay here
// is the field edit `edit.<materialId>.stay`, which beats that placement, and 「不属于住宿（移除）」 excludes the material.
// Whether either is still accepted is the server's call.

const NONE = '';
const REMOVE = 'remove';

export function PaymentStay({ material, snapshot }: { material: Material; snapshot: TaskSnapshot }) {
  const taskId = snapshot.task.taskId;
  const { busy, error, run } = useAction(taskId);
  const payment = material.payment;
  if (!payment) return null;
  const onChange = (value: string) => {
    if (value === REMOVE) void run((adapter) => adapter.excludeMaterial(taskId, material.materialId, snapshot.step.stepToken));
    else if (value !== NONE) void run((adapter) => adapter.answerPendingItem(taskId, `edit.${material.materialId}.${PAYMENT_STAY_FIELD}`, { value }, snapshot.step.stepToken));
  };
  return (
    <div className="app-payment-stay">
      <Select
        id={`payment-stay-${material.materialId}`}
        size="sm"
        labelText={`${PAYMENT_COPY.reassign}：${material.fileName}`}
        hideLabel
        value={payment.invoiceId ?? NONE}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
      >
        {payment.invoiceId === null ? <SelectItem value={NONE} text={PAYMENT_COPY.unassignedNote} disabled /> : null}
        {payment.options.map((option) => (
          <SelectItem key={option.invoiceId} value={option.invoiceId} text={PAYMENT_COPY.assignTo(option.label)} />
        ))}
        <SelectItem value={REMOVE} text={PAYMENT_COPY.remove} />
      </Select>
      <ActionError message={error} />
    </div>
  );
}
