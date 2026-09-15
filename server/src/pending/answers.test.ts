import type { PendingItem } from '@baox/contract';
import { describe, expect, it } from 'vitest';
import { givenUpOf, judgeAnswer, settle } from './answers';

// Answering is generic over item kinds. #184 derives the allocation items (逐段分摊, per-leg allocation) in its own
// module; this synthetic one has the shape it raises (`allocation.<materialId>.<leg>`), so the answer path is pinned
// before that slice lands. Kernel origin: allocate.mjs receiveAllocationAnswers / givenUpOpenItems.

const allocation: PendingItem = {
  itemId: 'allocation.m03.legs',
  materialId: 'm03',
  title: '「高德打车_发票.pdf」逐段分摊',
  why: '行程单各段金额加起来和票面价税合计对不上。',
  kind: 'allocation',
  resolver: '要你处理',
  fields: [],
  choices: [],
  allocation: {
    segments: [
      { index: 1, date: '2026-08-10', route: '虹桥枢纽 → 漕河泾', suggested: '26.69' },
      { index: 2, date: '2026-08-10', route: '漕河泾 → 虹桥枢纽', suggested: null },
    ],
    total: '69.19',
    giveUpNote: '选「认不出」后这张发票不能形成明细：请排除它和它的行程单，或追加列了逐段金额的行程单后重新盘点。',
  },
  status: 'open',
  answer: null,
};

describe('the allocation answer', () => {
  it('accepts legs that conserve to the invoice total to the cent', () => {
    expect(judgeAnswer(allocation, { amounts: ['26.69', ' 42.50 '] })).toEqual({ ok: true, answer: { amounts: ['26.69', '42.50'] } });
  });

  it('refuses legs off by one cent, without averaging or pushing the difference onto a leg', () => {
    const verdict = judgeAnswer(allocation, { amounts: ['26.69', '42.49'] });
    expect(verdict).toMatchObject({ ok: false, code: 'allocation_not_conserved' });
    expect(verdict.ok ? '' : verdict.message).toContain('各段加起来是 69.18 元');
  });

  it('refuses a wrong number of legs and a form-shaped answer', () => {
    expect(judgeAnswer(allocation, { amounts: ['69.19'] })).toMatchObject({ ok: false, code: 'invalid_answer' });
    expect(judgeAnswer(allocation, { choice: 'exclude' })).toMatchObject({ ok: false, code: 'invalid_answer' });
  });

  it('a stored answer that no longer fits the re-derived legs leaves the item open', () => {
    const answers = new Map([[allocation.itemId, { amounts: ['26.69', '42.50'] }]]);
    expect(settle(allocation, answers).status).toBe('resolved');
    const threeLegs = { ...allocation, allocation: { ...allocation.allocation!, segments: [...allocation.allocation!.segments, { index: 3, date: '2026-08-11', route: 'A → B', suggested: null }] } };
    expect(settle(threeLegs, answers)).toMatchObject({ status: 'open', answer: null });
  });

  it('giving up resolves the allocation and leaves a blocking given_up item that takes no answer', () => {
    const resolved = settle(allocation, new Map([[allocation.itemId, { giveUp: true as const }]]));
    expect(resolved).toMatchObject({ status: 'resolved', answer: { giveUp: true } });
    const givenUp = givenUpOf(resolved);
    expect(givenUp).toMatchObject({ itemId: 'given_up.m03.legs', materialId: 'm03', kind: 'given_up', status: 'open', why: allocation.allocation?.giveUpNote });
    expect(givenUp && judgeAnswer(givenUp, { choice: 'exclude' })).toMatchObject({ ok: false, code: 'item_not_answerable' });
    expect(givenUpOf(allocation)).toBeNull();
  });
});
