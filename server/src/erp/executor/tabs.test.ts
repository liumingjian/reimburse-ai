// The order in which a 费用报销单 tab and its 是否保存 confirm have to be answered, driven against a fake strip
// that behaves the way the live ERP was measured to behave on 2026-09-19.
//
// What was measured on the tab left over from a real import (ten 收票行):
//   - two consecutive attempts saw no 是否保存 bar within the 10 s the script allowed, and the bar was standing,
//     unanswered, when the page was read afterwards. The close is a round trip over the whole form;
//   - a third attempt — which, like the first two, clicked the tab closer again before looking for the bar —
//     clicked 否, and the bar was STILL up and the tab STILL open afterwards;
//   - minutes later, clicking that same standing 否 and touching nothing else closed the tab in under 2 s.
// So: a second close request over an unanswered confirm is what jams it, and that is what the fake models.
import { describe, expect, it } from 'vitest';

import { CONFIRM_MS, closeFormTab, closeNewFormTabs, formIdOf, type Point, type Tab, type TabActions } from './tabs';

const FORM_ID = 'd12769c1-2a2c-40c1-90b2-17140dcf5651';
const TAB: Tab = { id: `li_${FORM_ID}FMAINTAB_c`, text: '费用报销单-新增', active: true, isNew: true, isForm: true };
// Points here are the hit-tested `Reach` every click in the executor takes (hit.ts): a point this strip hands
// out is one that has already been proved to reach the node it names.
const reach = (x: number, y: number) => ({ x, y, inView: true, onTarget: true, cover: null });
const POINTS = { link: reach(11, 11), close: reach(22, 22), no: reach(129, 182), yes: reach(79, 182) };

type FakeOptions = { confirmDelayMs: number | null; closeDelayMs?: number; blockedForMs?: number };

/** The live strip and its confirm bar, in fake time. `clicks` is every point the policy actually sent. */
class FakeStrip implements TabActions {
  readonly clicks: string[] = [];
  open = true;
  private barUp = false;
  private confirmAt: number | null = null;
  private closingAt: number | null = null;
  private jammed = false;
  private readonly started = Date.now();
  constructor(private readonly options: FakeOptions) {}

  /** The ERP's own blocking overlay over the strip while a form is still opening: the point hit-tests to it. */
  private blocked() { return Date.now() - this.started < (this.options.blockedForMs ?? 0); }

  private tick() {
    const now = Date.now();
    if (this.confirmAt !== null && now >= this.confirmAt) { this.barUp = true; this.confirmAt = null; }
    if (this.closingAt !== null && now >= this.closingAt) { this.open = false; this.barUp = false; this.closingAt = null; }
  }

  async tabs(): Promise<Tab[]> { this.tick(); return this.open ? [TAB] : []; }
  async tabPoint(id: string, part: 'link' | 'close'): Promise<Point> { this.tick(); return this.open && id === TAB.id && !this.blocked() ? POINTS[part] : null; }
  // The bar is the form's own: `<guid>-POPFLOATEMESSAGE`, so a wrong form id finds nothing.
  async declinePoint(formId: string | null): Promise<Point> { this.tick(); return this.barUp && formId === FORM_ID ? POINTS.no : null; }
  async settle(): Promise<void> { await new Promise((r) => setTimeout(r, 1)); }

  async click(point: { x: number; y: number }): Promise<void> {
    this.tick();
    const what = (Object.keys(POINTS) as Array<keyof typeof POINTS>).find((k) => POINTS[k].x === point.x && POINTS[k].y === point.y) ?? 'elsewhere';
    this.clicks.push(what);
    const close = this.options.closeDelayMs ?? 200;
    if (what === 'close') {
      // The measured jam: asking again while the form has an unanswered 是否保存 outstanding.
      if (this.barUp || this.confirmAt !== null) { this.jammed = true; return; }
      if (this.options.confirmDelayMs === null) this.closingAt = Date.now() + close;
      else this.confirmAt = Date.now() + this.options.confirmDelayMs;
    }
    if (what === 'no') {
      if (this.jammed) return; // a jammed bar keeps standing however often 否 is pressed
      this.barUp = false;
      this.closingAt = Date.now() + close;
    }
  }
}

describe('closing a 费用报销单 tab', () => {
  it('answers a 是否保存 left standing by an earlier attempt before it touches the tab again', async () => {
    // Attempt 1, with the budget the script used to have: the confirm arrives after it, so the bar is left up.
    const strip = new FakeStrip({ confirmDelayMs: 900 });
    const first = await closeFormTab(strip, TAB.id, { confirmMs: 100, closedMs: 100 });
    expect(first).toMatchObject({ closed: false, declinedSave: false });
    expect(first.note).toContain('没等到');
    expect(strip.open).toBe(true);

    // The bar arrives after the attempt has given up, and then just stands there — which is how the live tab was
    // found: 内容已经修改，是否保存？ visible, its 否 hit-testable, and nobody left to answer it.
    await new Promise((r) => setTimeout(r, 1000));
    expect(await strip.declinePoint(FORM_ID)).not.toBeNull();

    // Attempt 2 — the one that mattered live. It must answer the standing bar, and must NOT ask the tab to close
    // a second time: that is the pair that left the tab open through three attempts.
    const closesBefore = strip.clicks.filter((c) => c === 'close').length;
    const second = await closeFormTab(strip, TAB.id, { confirmMs: 2000, closedMs: 2000 });
    expect(second).toMatchObject({ closed: true, declinedSave: true, answeredStanding: true });
    expect(strip.clicks.filter((c) => c === 'close').length).toBe(closesBefore);
    expect(strip.open).toBe(false);
  });

  it('gives the confirm long enough for a form the size of a real import', async () => {
    // The same 900 ms confirm as above, against the real budget scaled down: one attempt is enough.
    const strip = new FakeStrip({ confirmDelayMs: 900 });
    const result = await closeFormTab(strip, TAB.id, { confirmMs: 3000, closedMs: 2000 });
    expect(result).toMatchObject({ closed: true, declinedSave: true, answeredStanding: false });
    expect(strip.clicks).toEqual(['link', 'close', 'no']);
    // Live, two 10 s windows in a row were not enough on the tab this script exists for.
    expect(CONFIRM_MS).toBeGreaterThanOrEqual(30_000);
  });

  it('never clicks 是, whatever the outcome', async () => {
    const jammed = new FakeStrip({ confirmDelayMs: 100 });
    await closeFormTab(jammed, TAB.id, { confirmMs: 50, closedMs: 50 });
    await new Promise((r) => setTimeout(r, 200));
    await closeFormTab(jammed, TAB.id, { confirmMs: 2000, closedMs: 300 });
    expect(jammed.clicks).not.toContain('yes');
  });

  it('closes a form with nothing to save, which raises no confirm at all', async () => {
    const strip = new FakeStrip({ confirmDelayMs: null });
    const result = await closeFormTab(strip, TAB.id, { confirmMs: 700, closedMs: 2000 });
    expect(result).toMatchObject({ closed: true, declinedSave: false });
    expect(result.note).toContain('没有要保存的内容');
  });

  it('says precisely what it saw when the ERP will not let the form go', async () => {
    // A form that keeps its bar up however often 否 is pressed — the state three live attempts ended in.
    const strip = new FakeStrip({ confirmDelayMs: 100 });
    await closeFormTab(strip, TAB.id, { confirmMs: 50, closedMs: 50 }); // times out, leaves the bar standing
    await new Promise((r) => setTimeout(r, 200));
    await strip.click(POINTS.close); // a second close request over it: the measured jam
    const result = await closeFormTab(strip, TAB.id, { confirmMs: 500, closedMs: 300 });
    expect(result.closed).toBe(false);
    // Not «closed:false» three times over: the operator is told the ERP refused the discard, and that 是 is not
    // an option this program will reach for.
    expect(result.note).toContain('「是否保存」还在');
    expect(result.note).toContain('人工处理');
  });

  it('waits out the ERP blocking overlay instead of reporting a busy tab as stuck', async () => {
    // Live 2026-09-19: a 费用报销单 - 新增 that was still opening hit-tested its closer to
    // `DIV.kd-ui-blockingExtention-item` for minutes, and the overlay was gone once the form had loaded.
    const strip = new FakeStrip({ confirmDelayMs: null, blockedForMs: 900 });
    const result = await closeFormTab(strip, TAB.id, { confirmMs: 300, closedMs: 2000, reachMs: 3000 });
    expect(result.closed).toBe(true);
    const blocked = await closeFormTab(new FakeStrip({ confirmDelayMs: null, blockedForMs: 5000 }), TAB.id, { confirmMs: 300, closedMs: 300, reachMs: 600 });
    expect(blocked).toMatchObject({ closed: false });
    expect(blocked.note).toContain('点不到');
  });

  it('attributes a confirm to the tab it belongs to, by the form id the strip encodes', () => {
    expect(formIdOf(TAB.id)).toBe(FORM_ID);
    expect(formIdOf('li_fdc33383-da2d-4419-88bf-f84240997f64FMAINTAB_c')).toBe('fdc33383-da2d-4419-88bf-f84240997f64');
    expect(formIdOf('something-else')).toBeNull();
  });
});

// 重新去报销 (ADR-0027), live 2026-09-21: the recovery reused the unsaved 新增 an import had left open, found its 收票行
// and stopped at 打开空白报销单. It now closes 新增 tabs first — and only those.
describe('closing the 新增 tabs a recovery replaces', () => {
  const tab = (key: string, text: string): Tab => ({
    id: `li_${key}FMAINTAB_c`, text, active: false, isNew: /-新增$/.test(text), isForm: /^费用报销单-/.test(text),
  });

  /** A strip of several tabs. Each 新增 raises 是否保存 on close and goes on 否; `stubborn` ones never go. */
  class Strip implements TabActions {
    readonly clicks: string[] = [];
    private readonly confirming = new Set<string>();
    constructor(public open: Tab[], private readonly stubborn: ReadonlySet<string> = new Set()) {}
    private at(id: string, part: string) { return { x: this.open.findIndex((t) => t.id === id), y: ['link', 'close', 'no'].indexOf(part), inView: true, onTarget: true, cover: null }; }
    async tabs() { return [...this.open]; }
    async tabPoint(id: string, part: 'link' | 'close') { return this.open.some((t) => t.id === id) ? this.at(id, part) : null; }
    async declinePoint(formId: string | null) {
      const id = [...this.confirming].find((candidate) => formIdOf(candidate) === formId);
      return id ? this.at(id, 'no') : null;
    }
    async settle() {}
    async click(point: { x: number; y: number }) {
      const target = this.open[point.x];
      if (!target) return;
      const part = ['link', 'close', 'no'][point.y]!;
      this.clicks.push(`${part}:${target.text}`);
      if (part === 'close') this.confirming.add(target.id);
      if (part === 'no' && !this.stubborn.has(target.id)) {
        this.confirming.delete(target.id);
        this.open = this.open.filter((t) => t.id !== target.id);
      }
    }
  }

  it('closes the 新增 with 否 and leaves 我的费用报销 and a saved bill\'s 修改 tab exactly where they were', async () => {
    const list = tab('list', '我的费用报销');
    const saved = tab('saved', '费用报销单-修改');
    const abandoned = tab('abandoned', '费用报销单-新增');
    const strip = new Strip([list, saved, abandoned]);
    const result = await closeNewFormTabs(strip, { confirmMs: 200, closedMs: 200, reachMs: 200 });
    expect(result).toEqual({ closed: ['费用报销单-新增'], stuck: [] });
    expect(strip.open.map((t) => t.text)).toEqual(['我的费用报销', '费用报销单-修改']);
    // Nothing aimed at the other two, and 是 is not a click this strip even offers.
    expect(strip.clicks.every((click) => click.endsWith('费用报销单-新增'))).toBe(true);
    expect(strip.clicks).toContain('no:费用报销单-新增');
  });

  it('reports a 新增 that would not close instead of carrying on beside it', async () => {
    const abandoned = tab('abandoned', '费用报销单-新增');
    const strip = new Strip([abandoned], new Set([abandoned.id]));
    const result = await closeNewFormTabs(strip, { confirmMs: 100, closedMs: 100, reachMs: 100 });
    expect(result.closed).toEqual([]);
    expect(result.stuck).toHaveLength(1);
    expect(result.stuck[0]).toMatch(/^费用报销单-新增（.+）$/);
    expect(strip.open).toHaveLength(1);
  });

  it('does nothing at all when no 新增 is open', async () => {
    const strip = new Strip([tab('list', '我的费用报销')]);
    expect(await closeNewFormTabs(strip, { confirmMs: 50, closedMs: 50, reachMs: 50 })).toEqual({ closed: [], stuck: [] });
    expect(strip.clicks).toEqual([]);
  });
});
