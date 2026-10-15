import { describe, expect, it } from 'vitest';
import type { ExecutorEvent } from '@baox/erp-executor/protocol';
import { judgeDraftLookup } from './fill-state';

// What a 对账 by the ownership marker (line 2 item 5) found, judged: only one outcome is ERP 草稿已交接, only an
// unanswered lookup offers 对账 again, and every other is 转人工.
const MARK = 'baox-k3m9q2x7v1';
const EARLIER = 'baox-0a1b2c3d4e';
type Drafts = Extract<ExecutorEvent, { type: 'draft_lookup' }>['drafts'];
const draft = (patch: Partial<Drafts[number]> = {}): Drafts[number] => ({ mark: MARK, id: '119946', billNo: null, status: 'Z', ...patch });
const judge = (drafts: Drafts, problems: string[] | null = [], failure: string | null = null) =>
  judgeDraftLookup([{ type: 'draft_lookup', drafts, problems, failure }], MARK);

describe('judging a 对账 by the ownership marker', () => {
  it.each<[string, ReturnType<typeof judge>, string, string, string]>([
    ['the one draft, equal', judge([draft()]), 'drafted', '未保存·就绪待保存', '原地等待'],
    ['no answer', judge([], null, '按归属标记查暂存单没有成功'), 'unread', '未知', '原地等待'],
    ['no draft', judge([], null), 'none', '未知', '转人工'],
    ['two under the mark', judge([draft(), draft({ id: '119947' })], null), 'several', '不自洽', '转人工'],
    ['one under an earlier job\'s mark only', judge([draft({ mark: EARLIER })], null), 'several', '不自洽', '转人工'],
    ['one with a 单据编号', judge([draft({ billNo: 'FYBX001' })], null), 'saved', '已保存', '转人工'],
    ['one no longer 暂存', judge([draft({ status: 'A' })], null), 'saved', '已保存', '转人工'],
    ['one not compared', judge([draft()], null), 'unproved', '未知', '转人工'],
    ['one that differs', judge([draft()], ['事由与写入的不一致']), 'mismatch', '不自洽', '转人工'],
  ])('%s', (_name, judged, outcome, bucket, action) => {
    expect(judged).toMatchObject({ draft: { outcome }, verdict: { bucket, action } });
    expect(judged!.verdict.reasons.join('')).not.toMatch(/ERP|重试|[–—]/);
  });

  it('keeps the draft\'s 内码 and its 单据编号, and is null when the run sent no lookup', () => {
    expect(judge([draft()])).toMatchObject({ draft: { draftId: '119946', found: 1 }, billNo: null });
    expect(judge([draft({ billNo: 'FYBX001' })], null)).toMatchObject({ billNo: 'FYBX001' });
    expect(judgeDraftLookup([], MARK)).toBeNull();
  });
});
