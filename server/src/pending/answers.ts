import {
  ALLOCATION_ERRORS,
  PENDING_ANSWER_ERRORS,
  PENDING_CHOICE_KEY,
  fieldAnswer,
  isAllocationAnswer,
  normalizePendingAnswer,
  validatePendingAnswer,
  type PendingAnswer,
  type PendingItem,
} from '@baox/contract';
import { conservingLegs } from '../allocation';

// Answers to 待确认项 (pending items), generic over the item kinds `form | choice | allocation | given_up`. The same
// judgement runs when an answer is submitted and when a re-derived item meets its stored answer: an answer that no
// longer fits (a choice no longer offered, a segment count that changed) leaves the item open again (ADR-0014).
// Whoever derives an item (the inventory view, #184's allocation module) gets answering for free: it only has to
// derive the item with a stable id and, for a form, may attach a `check` over the answer.

export type Refusal = { code: string; message: string };
export type Verdict = { ok: true; answer: PendingAnswer } | ({ ok: false } & Refusal);

// A check beyond the per-field formats, e.g. the kind's amount check over manual-fill values. A sentence, or null.
export type AnswerCheck = (answer: PendingAnswer) => string | null;

export type Answerable = { item: PendingItem; check?: AnswerCheck };

// Latest stored answer per key (item id or edit address).
export type StoredAnswers = ReadonlyMap<string, PendingAnswer>;

export const EXCLUDE_CHOICE = 'exclude';

const toCents = (amount: string): number => Math.round(Number(amount) * 100);
const yuan = (cents: number): string => `${cents < 0 ? '-' : ''}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;

export function judgeAnswer(item: PendingItem, answer: PendingAnswer, check?: AnswerCheck): Verdict {
  if (item.kind === 'given_up') return { ok: false, code: 'item_not_answerable', message: PENDING_ANSWER_ERRORS.notAnswerable };
  if (item.kind === 'allocation' ? !isAllocationAnswer(answer) : isAllocationAnswer(answer)) {
    return { ok: false, code: 'invalid_answer', message: item.kind === 'allocation' ? ALLOCATION_ERRORS.missing : PENDING_ANSWER_ERRORS.choice };
  }
  const normalized = normalizePendingAnswer(item, answer);
  const first = Object.values(validatePendingAnswer(item, normalized))[0];
  if (first) return { ok: false, code: 'invalid_answer', message: first };
  // 逐段分摊 (per-leg allocation): the legs must add up to the invoice total to the cent. Nothing is averaged,
  // apportioned or pushed onto a leg (kernel submitAllocation).
  // The rule is #184's `conservingLegs`, the same one `allocate` applies when it adopts the stored amounts.
  if (item.kind === 'allocation' && item.allocation && isAllocationAnswer(normalized) && 'amounts' in normalized) {
    const sum = normalized.amounts.reduce((total, amount) => total + toCents(amount), 0);
    if (!conservingLegs(normalized.amounts, toCents(item.allocation.total))) return { ok: false, code: 'allocation_not_conserved', message: ALLOCATION_ERRORS.notConserved(yuan(sum), item.allocation.total) };
  }
  const failed = check?.(normalized);
  if (failed) return { ok: false, code: 'check_failed', message: failed };
  return { ok: true, answer: normalized };
}

// The item as its stored answer leaves it: resolved with the (normalised) answer when it still fits, open otherwise.
export function settle(item: PendingItem, answers: StoredAnswers, check?: AnswerCheck): PendingItem {
  const stored = answers.get(item.itemId);
  if (!stored) return item;
  const verdict = judgeAnswer(item, stored, check);
  return verdict.ok ? { ...item, status: 'resolved', answer: verdict.answer } : item;
}

// The choice key of a resolved choice item, else undefined.
export function chosen(item: PendingItem): string | undefined {
  return item.kind === 'choice' && item.status === 'resolved' ? fieldAnswer(item.answer)[PENDING_CHOICE_KEY] : undefined;
}

// 这张票我认不出 (give up) on an allocation item leaves a blocking given_up item in its place
// (kernel allocate.mjs givenUpOpenItems): `allocation.<materialId>[.<leg>]` → `given_up.<materialId>[.<leg>]`.
// It takes no answer; the way out is excluding the invoice (with its linked materials) or a better itinerary.
export function givenUpOf(item: PendingItem): PendingItem | null {
  if (item.kind !== 'allocation' || item.status !== 'resolved' || !item.answer || !isAllocationAnswer(item.answer) || !('giveUp' in item.answer)) return null;
  const rest = item.itemId.includes('.') ? item.itemId.slice(item.itemId.indexOf('.') + 1) : item.itemId;
  return {
    itemId: `given_up.${rest}`,
    materialId: item.materialId,
    title: `${item.title}：已选「这张票我认不出」`,
    why: item.allocation?.giveUpNote ?? PENDING_ANSWER_ERRORS.notAnswerable,
    kind: 'given_up',
    resolver: '要你处理',
    fields: [],
    choices: [],
    allocation: null,
    status: 'open',
    answer: null,
  };
}
