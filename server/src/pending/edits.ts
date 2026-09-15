import { PENDING_ANSWER_ERRORS, fieldAnswer, validatePendingAnswer, type EditClass, type PendingAnswer } from '@baox/contract';
import type { SlotFormat } from '../parse/kinds';
import type { Verdict } from './answers';

// Field edits by edit class (ADR-0017), submitted through `answer-pending` with the item id `edit.<materialId>.<field>`
// and the answer `{ value }`. They are stored like answers (keyed `(edit, materialId, field)`) and re-applied on every
// derivation while they still pass.
//   fact_locked       refused: a face fact from a PDF text layer or QR; exclude or replace the material instead.
//   fact_correctable  a `user` value that must pass the field format and the kind's checks; nothing back-calculated.
//   presentation      a 呈现值 (presentation value) over the resolved one; lists, print and ERP text show it, checks don't.
//   choice            only a value the company rules allow.

export const EDIT_PREFIX = 'edit.';
export const editAddress = (materialId: string, field: string): string => `${EDIT_PREFIX}${materialId}.${field}`;

export const PRESENTATION_MAX_LENGTH = 100;

export const EDIT_COPY = {
  factLocked: (label: string) => `「${label}」是票面事实（从 PDF 文本层或二维码读出），不能修改。有异议请排除这份材料，或在上传页换成正确的原件后重新盘点。`,
  notAllowed: (label: string, allowed: readonly string[]) => `「${label}」只能选公司规则允许的值：${allowed.join('、')}。`,
  tooLong: `呈现文字不能超过 ${PRESENTATION_MAX_LENGTH} 个字。`,
  notFound: '这份材料没有这个可修改的字段。',
} as const;

export type Editable = {
  address: string;
  materialId: string;
  field: string;
  label: string;
  editClass: EditClass;
  format: SlotFormat;
  // `choice`: the allowed values.
  allowed: readonly string[] | null;
  // `fact_correctable`: the kind's checks over the material's values with this one in place.
  check?: (value: string) => string | null;
};

export function judgeEdit(target: Editable, answer: PendingAnswer): Verdict {
  if (target.editClass === 'fact_locked') return { ok: false, code: 'fact_locked', message: EDIT_COPY.factLocked(target.label) };
  const value = (fieldAnswer(answer)['value'] ?? '').trim();
  if (!value) return { ok: false, code: 'invalid_answer', message: PENDING_ANSWER_ERRORS.required };
  if (target.editClass === 'choice') {
    const allowed = target.allowed ?? [];
    return allowed.includes(value) ? { ok: true, answer: { value } } : { ok: false, code: 'choice_not_allowed', message: EDIT_COPY.notAllowed(target.label, allowed) };
  }
  if (target.editClass === 'presentation') {
    return value.length > PRESENTATION_MAX_LENGTH ? { ok: false, code: 'invalid_answer', message: EDIT_COPY.tooLong } : { ok: true, answer: { value } };
  }
  const format = Object.values(validatePendingAnswer({ kind: 'form', choices: [], fields: [{ key: 'value', label: target.label, placeholder: '', required: true, format: target.format }] }, { value }))[0];
  if (format) return { ok: false, code: 'invalid_answer', message: format };
  const failed = target.check?.(value);
  if (failed) return { ok: false, code: 'check_failed', message: failed };
  return { ok: true, answer: { value } };
}

// The value a stored edit still contributes, or null when it no longer passes.
export function editedValue(target: Editable, stored: PendingAnswer | undefined): string | null {
  if (!stored) return null;
  const verdict = judgeEdit(target, stored);
  return verdict.ok ? (fieldAnswer(verdict.answer)['value'] ?? null) : null;
}
