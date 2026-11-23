import { type PendingField, type PendingItem } from '@baox/contract';
import { EXCLUDE } from './answers';

// Missing reference details describe the expense, independently of facts printed on its invoice.
export function missingReference(item: PendingItem, fields: PendingField[]): PendingItem {
  return {
    ...item,
    choices: [{ key: 'manual_fill', label: '手工填写' }, { key: 'confirm_none', label: '确认没有账单' }, { ...EXCLUDE, label: '忽略发票' }],
    expenseDetails: fields,
  };
}
