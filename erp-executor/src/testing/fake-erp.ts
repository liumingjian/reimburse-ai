// The fake ERP: a stateful fake CDP session over hand-written DOM fixtures (./fixtures), after the kernel's
// 50931a3:kernel/test/fake-session.mjs, or over pages recorded from the live ERP (./recordings, option `recording`).
// Every hand-written page assumption carries an @unverified marker; unverified.test.ts lists and counts them. Every executor expression really runs against a jsdom document; clicks and keys
// arrive as CDP `Input.*` events at viewport coordinates and are turned into the behaviour the research recorded
// (docs/research/erp-expense-flow): edit-on-click cells, select-all + typing + Enter/Tab commit, F7 code -> name,
// the invoice-type dropdown, linked recalculation, the piaozone assistant as a child target, save -> 修改 mode.
//
// Invoices reach the assistant's file input as local paths through `DOM.setFileInputFiles` (`invoice-files.ts`),
// recognised by the bytes' sha256.
//
// Layout: jsdom has none, so every visible element gets a unique 8x8 box on a 10px grid in DOCUMENT coordinates, in
// the order it is first measured. Hidden (display:none / visibility:hidden / [hidden]) elements measure 0x0.
// `data-below-fold` puts a box at an explicit document y instead, so a test can place a control past the bottom of
// the viewport. Rects are document y minus `scrollTop`, `scrollIntoView` centres the box, and a click outside the
// viewport hits nothing — which is what the real browser does, and what the invoice assistant broke on.
//
// `assumeReceiptLink` is an UNVERIFIED assumption, off by default: research says that in 不生成费用明细 mode ERP
// leaves the detail row's 收票单号 empty, while the strict read-back requires it. With the flag on, committing 税额
// links the row to the unique receipt with the same net and tax, so the save path can be exercised end to end.

// The server compiles this file from outside the package, and its tsconfig `include` does not reach the ambient
// jsdom declaration next door, so name it here.
/// <reference path="./jsdom.d.ts" />
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import type { CdpListener, CdpSession } from '../cdp';
import type { ChromiumPage } from '../page';
import { CLICK_MARK } from '../recording/capture';
import { fillIdentity, loadRecording, loginInfoOf, type RecordedPage } from './recordings';

/** A hand-written fixture's text, placeholders and all. */
export const fixture = (name: 'erp-main.html' | 'erp-login.html' | 'piaozone-assistant.html') =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** What `data-covered-by` names when ERP's idle prompt is the thing in the way. */
const IDLE_COVER = '#idle-window .k-window-message';

/** The same, for the assistant's 温馨提示 announcement. */
const ASSISTANT_NOTICE = '#assistant-notice button';

export type FakeInvoice = {
  bytes: Uint8Array; invoiceNumber: string; receiptNumber: string; seller: string; issueDate: string;
  net: string; tax: string; gross: string; category: string;
  /**
   * ERP's verbatim refusal for this invoice, or undefined for an invoice it accepts. `重复报销，禁止导入` is the one
   * the recovery path cannot fix: the invoice is bound to a 历史费用报销单 (a past reimbursement bill), not to the
   * unsaved one we abandoned, so nothing is imported and ERP says why in the 提示 window.
   */
  importRefusal?: string;
};

/**
 * The 收票单 (receipt records) ERP already holds, keyed by 收票单, with the row values it holds for each. ADR-0026:
 * a 收票单 outlives the bill that created it, and it outlives the page instance too, so a recovery run over a second
 * `createFakeErp` can be given the ledger the first one left behind. Sharing it is what makes re-import a re-import.
 */
export type FakeReceiptLedger = Map<string, string[]>;
export type FakeMasterData = { code: string; name: string; documentStatus?: string; forbidStatus?: string };
export type FakeErpOptions = {
  origin?: string;
  loggedIn?: boolean;
  /**
   * The ERP entry page loads logged out with an empty body: no login form, no console, until it is loaded again.
   * Live 2026-10-20 2 of 21 sign-ins met it (scripts loaded, body empty for 90 s); loading the entry page again brought
   * the form in 2-30 s.
   * @unverified: the entry page stays blank until it is loaded again [transient]
   */
  entryPageBlank?: boolean;
  /**
   * The main menu card opens on a click and stays empty — no 员工服务, no row at all — until the page is loaded
   * again. Live 2026-10-21 (1 of 10 runs) the card stayed open and empty for the 45 s a run clicked it every 5 s,
   * where 6 sign-ins measured that day filled it 0.9-4.8 s after the click, and a second click left it as it was.
   * @unverified: the main menu card can stay empty until the page is loaded again [transient]
   */
  menuEmptyUntilReload?: boolean;
  /**
   * Serve a recording (./recordings/<name>, see recordings.ts) instead of the hand-written fixtures: its login page
   * while logged out, and its pages in order while logged in, moving on when a click lands where the live click
   * did; a page's recorded child frame (the 发票无忧助手) is the child target. Keys are ignored. None of the
   * hand-written behaviour below applies to a recorded page; the build is the recorded one.
   */
  recording?: string;
  account?: { displayName: string; account: string; tenant: string };
  erpBuild?: string;
  formId?: string;
  invoices: FakeInvoice[];
  projects: FakeMasterData[];
  expenseItems: FakeMasterData[];
  /** @unverified: ERP links a detail row to its 收票单 once 税额 is committed (research says it leaves 收票单号 empty) [import] */
  assumeReceiptLink?: boolean;
  /**
   * How long Kendo needs after the last keystroke before its own model holds the typed value, counted in CDP
   * COMMANDS rather than milliseconds so the discrimination is deterministic. The scale is small and exact: a
   * commit pressed straight after the last character is always 2 commands behind it (the character's own keyUp
   * and the commit key's rawKeyDown), while waiting for the editor to hold its value costs two reads more. So
   * 3 is the window that tells the two apart, and 1 or 2 tells them apart from nothing. A commit that arrives inside
   * the window commits what was there BEFORE — measured live 2026-09-20 on 税额, whose Enter closes the whole
   * edit row, so the row shut with the cell empty and there was no second chance. 费用金额 survives the same
   * race only because its Enter leaves the row open. 0 (the default) is an ERP that takes every commit, which
   * is what every other test wants.
   * @unverified: Kendo's model trails the last keystroke, so a commit inside the window commits the old value [typing]
   */
  editorSettleTicks?: number;
  /**
   * Keep the tax editor focused after Enter while ERP has already recalculated the row.
   * @unverified: the 税额 editor keeps focus after Enter while ERP has already recalculated the row [typing]
   */
  taxEditorRemainsOpen?: boolean;
  /**
   * A column whose editor swallows the FIRST run of typing whole, and takes keys only once the cell has been
   * clicked into a second time.
   *
   * Measured live 2026-09-20 on 项目, a 选择类 (原文 kdbosf7) column, on a freshly added 费用明细行: the cell reports
   * a bound, focused INPUT, `111705` typed into it leaves the editor EMPTY, a second click and a second typing
   * lands it, and the ERP resolves the code to the project name within a second. The ERP re-renders the control as
   * it initialises its data source, so the input that was bound a moment ago is no longer the one on the page.
   * Unset (the default) is an ERP whose editors take keys the first time, which is what every other test wants.
   * @unverified: a selection-type (选择类) F7 column swallows the first typing while the control re-renders [typing]
   */
  firstTypingLostOn?: string;
  /**
   * The 发票类型 dropdown needs the cell clicked TWICE before its list is up, and toggles on every click after.
   *
   * Measured live 2026-09-20 on a freshly added 费用明细行: the first click put the cell into edit with
   * `aria-expanded="false"` and no list, the second opened a list of six candidates, the third shut it again.
   * A single click therefore found no candidates at all and the run stopped over a list that was never open.
   * False (the default) is an ERP whose dropdown opens on the first click, which is what every other test wants.
   * @unverified: the 发票类型 dropdown opens on the second click and toggles after [transient]
   */
  dropdownNeedsSecondClick?: boolean;
  today?: string;
  billNo?: string;
  /** The 收票单 ERP already holds. Defaults to an empty ledger: an ERP that has never seen these invoices. */
  receiptLedger?: FakeReceiptLedger;
  /**
   * Pick from computer (电脑端选取) does nothing, so the assistant never leaves its entry menu and no upload is possible.
   * @unverified: the assistant's 电脑端选取 can do nothing and leave it on its entry menu [transient]
   */
  assistantStuckOnEntryMenu?: boolean;
  /**
   * The 不生成费用明细 menu item opens past the bottom of the viewport, where a real mouse event reaches nothing.
   * Live on 2026-09-19 the 收票信息 anchor had not finished scrolling, so the item landed at y=941 in a viewport
   * 908 high; the click was lost and the run died on INVOICE_ASSISTANT_NOT_FOUND 90s later.
   * @unverified: the 不生成费用明细 item can open below the viewport [transient]
   */
  notFillEntryBelowFold?: boolean;
  /**
   * The 不生成费用明细 item is measured correctly and the mouse event lands on its NEIGHBOUR 合并生成费用明细
   * instead — the shape V-53 proved possible on this page, where a mis-delivered click is silent. ERP then imports
   * in merge mode and writes the 费用明细 rows itself, which is D2's observed shape.
   * @unverified: a click aimed at 不生成费用明细 can land on 合并生成费用明细 [transient]
   */
  notFillEntryHitsNeighbour?: boolean;
  /**
   * The first N clicks on 不生成费用明细 close the 选择发票 menu and open nothing. Live 2026-10-21 (1 of 10 runs) the
   * click passed its hit test, the menu shut, and no 发票无忧助手 window came in the 90 s after it.
   * @unverified: a click on 不生成费用明细 can shut the menu and open no assistant [transient]
   */
  notFillEntryClicksLost?: number;
  /**
   * The assistant's window shows at once, and its piaozone iframe attaches as a CDP target this many ms (wall clock)
   * later: a slow assistant, which a second click on 不生成费用明细 must not open twice.
   * @unverified: the assistant's window can show before its iframe attaches [transient]
   */
  assistantAttachDelayMs?: number;
  /**
   * The first N times the assistant opens, its window shows and stays blank: the piaozone page never loads, so no
   * iframe target ever attaches. Live 2026-10-21 (1 of 10 runs) the window titled 发票无忧助手 stood empty for the
   * rest of the 90 s.
   * @unverified: the assistant's window can open blank and stay so until it is opened again [transient]
   */
  assistantBlankOpens?: number;
  /**
   * A blank assistant window (`assistantBlankOpens`) does not close on its ×. Live 2026-10-21 one took the click, its
   * × left pressed, and stayed up with its overlay over the 选择发票 button.
   * @unverified: a blank assistant window can stay up when its × is clicked [transient]
   */
  assistantBlankWontClose?: boolean;
  /**
   * Clicking an invoice kind (票种) tab does nothing: the pane never changes, so rows in the other 票种 stay out of reach.
   * @unverified: a click on the assistant's 票种 tab can leave the pane unchanged [upload]
   */
  assistantPaneSwitchDead?: boolean;
  /**
   * Invoice numbers (发票号码) whose checkbox refuses to toggle — a click that lands and still leaves the row unticked.
   * @unverified: an assistant row's checkbox can take a click and stay unticked [upload]
   */
  assistantDeadTickNumbers?: string[];
  /**
   * The 发票号码 whose tick point is painted over: `document.elementFromPoint` there answers the overlay `<img>`,
   * exactly as it did live on 2026-09-19 for the row sitting at the bottom edge of the 800x530 iframe viewport.
   * @unverified: an overlay <img> paints over the tick point of the row at the assistant iframe's bottom edge [unseen]
   */
  assistantCoveredTickNumbers?: string[];
  /**
   * Recognition of every upload batch after the first lands this many assistant evaluations later, and lands in
   * its own 票种 pane. The first batch's rows stay on screen throughout, so `rows.length > 0` is true the whole
   * time and cannot say whether the second batch has been recognised.
   * @unverified: the assistant recognises every batch after the first later, in its own 票种 pane [upload]
   */
  assistantRecognitionTicks?: number;
  /**
   * How many ERP-page evaluations after 新增 Kendo takes to move `k-state-active` onto the new form's tab panel.
   * Until then the only active panel is the console's own, which answers with its own form id — the live shape
   * behind `compatibility_mismatch` on a build that matched (2026-09-19).
   * @unverified: Kendo moves k-state-active onto the new form panel a few reads after 新增 [transient]
   */
  formPanelActiveTicks?: number;
  /**
   * How many ERP-page evaluations after 发票导入单据 the 处理结果 report needs to finish painting. Until then the
   * window is on screen carrying nothing but its title; above 2 it also paints its grid a row at a time as it goes.
   * The live shape of 2026-09-19: at T+90s the window held the word 处理结果 and nothing else, and minutes later
   * held the complete ten-row all-success report. Default 2: on screen empty, complete one read later.
   * @unverified: 处理结果 opens empty and paints its report later, row by row [import]
   */
  importReportTicks?: number;
  /**
   * The window opens and its report never arrives at all: the hang the budget's stall clock has to catch.
   * @unverified: the import result window (处理结果) can open and never paint its report [import]
   */
  importReportStalled?: boolean;
  /**
   * 发票导入单据 does everything it should — binds the invoices, mints their 收票单, fills the 收票信息 grid — and
   * opens NO window at all. Measured live 2026-09-21 with one invoice: 收票单 SPD202609160141 on the bill, not a
   * single `.k-window` on screen, and a judge that only ever looked at windows waited out its whole budget and
   * told the employee 结果不确定 about an import that had worked.
   * @unverified: 发票导入单据 can succeed with no window at all [import]
   */
  importReportMissing?: boolean;
  /**
   * 处理结果 answers 发票导入单据 in full and then refuses to close: its 退出 does nothing, the window keeps
   * floating over the form, and the form's own 事由 control answers `elementFromPoint` with the report's text.
   *
   * The live shape of V-54, 2026-09-19. A 去报销 imported ten invoices cleanly, judged them cleanly, passed the
   * `after_import` read-back, started 填费用明细 for the first time ever and died 4.1 s later on
   * `header_write_failed`: the 处理结果 window had survived the import's 退出 and floated at z-index 10005 over
   * the form (rect 257,168 768x529), `elementFromPoint(371, 334)` — the centre of 事由, whose locator was
   * perfectly correct — answered a SPAN「接收发票」 inside the report, and `activeElement` was that cell. A fully
   * successful irreversible import was reported to the employee as 结果不确定.
   * @unverified: 处理结果 can survive its 退出 and float over 事由 [import]
   */
  importReportStaysOpen?: boolean;
  /**
   * New (新增) is clicked and no form opens — the navigation that reports success while achieving nothing.
   * @unverified: a click on 新增 can land and open no form [transient]
   */
  newFormClickDead?: boolean;
  /**
   * The first N clicks on 新增, or on the 我的费用报销 shortcut, land and do nothing; the next one works. Measured live
   * 2026-10-12 (S8, headless, right after login): the 我的费用报销 list stood open with one visible 新增, and 45 s
   * after its click no form had opened; on another run the main menu stayed shut after its click.
   */
  newFormDeadClicks?: number;
  openListDeadClicks?: number;
  /**
   * The console has no 我的费用报销 shortcut, so the way in is 菜单 -> 员工服务 -> 人人报销 -> 我的费用报销 (live
   * 2026-10-19). `selected` is the second-level node the menu reopens on, which ERP remembers per user: `LOG`
   * (定制开发 › 日志管理) is the one the failing live runs met, where a click on 员工服务 only expands its row.
   */
  menuPath?: { selected: 'ERX' | 'LOG' };
  /**
   * ERP's loading overlay shows for the first N page ticks and takes every click made while it shows. Live
   * 2026-10-19 it flashed for 2-4 s after sign-in, appearing between the hit test and the mouse-down.
   */
  consoleBlockerTicks?: number;
  /** 暂存 is pressed and nothing lands: the tab stays 新增. */
  draftCommandDead?: boolean;
  /** 暂存 lands the draft but the tab stays 新增, so the fill cannot tell it landed: what 对账 by the marker is for. */
  draftTabStays?: boolean;
  /** Another 暂存 draft already carries this 事由, mark and all, so a search by the mark finds two. */
  draftMarkTaken?: boolean;
  /** What ERP stores as 事由 when it is not what was typed (a cut, say), to prove the read-back of the model. */
  draftStoresCausa?: string;
  /** 费用报销单 that already hold an invoice, by invoice number: its 单据编号, or '' for a 暂存 draft (V-63). */
  heldInvoices?: Record<string, string>;
  /** 暂存 drafts already in ERP before the run, by 事由. */
  draftsBefore?: string[];
  /** ExecuteBillQuery refuses a query by 发票号码. */
  occupancyQueryFails?: boolean;
  /**
   * Raise ERP's own idle-timeout prompt (金蝶提示「系统闲置时间过长」) before the run starts, covering the element
   * this selector names — the state an unattended run inherits when the session was left sitting. Measured live
   * 2026-09-20: the prompt's overlay covered the header strip, so every click under it was refused and the run
   * died at 打开空白报销单. Answering 不退出 is what uncovers it; answering 继续退出 signs the session out, and
   * the fake really does sign out, so a test cannot pass by clicking the wrong one.
   * @unverified: ERP's idle prompt (金蝶提示) and its overlay cover the header strip until 不退出 [transient]
   */
  idlePromptCovers?: string;
  /**
   * Put the assistant's 温馨提示 announcement BACK once the uploads have been recognised, covering the rows the
   * run is about to tick. Measured live 2026-09-20: the modal («本次更新后，功能增强…知道了») was up at ROW
   * SELECTION, not only on a first visit, and the run died with the checkbox unreachable — so the one dismissal
   * that used to sit before the uploads could not have helped. `ant-modal-wrap` at z-index 9999 covered the whole
   * (0,0)-(800,530) viewport live; here it covers what a run must click, which is the same thing for a hit test.
   * @unverified: the assistant's 温馨提示 comes back over the rows after the uploads are recognised [upload]
   */
  noticeReturnsAfterUpload?: boolean;
  /**
   * How many ERP-page evaluations after 新增 the form's own blocking overlay stays over the top bar, so every
   * 区域锚点 (section anchor) answers `elementFromPoint` with that overlay instead of itself.
   *
   * Measured live 2026-09-19 on a freshly opened 费用报销单-新增: `openInvoiceAssistant`'s first act, clicking the
   * 收票信息 anchor at (312, 145), hit-tested to an anonymous DIV and the run stopped before writing anything.
   * A form that is still opening is BUSY, not stuck, so this is outwaited rather than refused — the same overlay
   * `tabs.ts` already outwaits on the tab strip.
   * @unverified: the form's blocking overlay covers the section anchors while it opens [transient]
   */
  sectionOverlayTicks?: number;
  /**
   * How many ERP-page evaluations an anonymous DIV sits over the 发票类型 (invoice type) cell of every detail row.
   *
   * Measured live 2026-09-20: a 去报销 that had written 项目 and 费用项目 into row 1 stopped on
   * 「发票类型」的落点（x=629 y=843）上盖着DIV — and a read of that very point a minute later answered the cell
   * itself (`SPAN.kd-grid-cellspan「普通发票」`, 569,826 120x34). The cover was momentary; `selectOption` read the
   * point once and refused.
   * @unverified: an anonymous DIV sits over the 发票类型 cell for a few reads [transient]
   */
  invoiceTypeCoverTicks?: number;
  /**
   * How many ERP-page evaluations after 新增行 the new 费用明细行 takes to appear in the grid.
   *
   * Measured live 2026-09-20: a 去报销 wrote detail row 1 in full, read it back off the real form, clicked
   * 新增行 and stopped on `add_row_not_observed` — while the row WAS on the form a moment later. The click was
   * never lost; the read was too early. ERP adds the row through its own re-render, and `addDetailRow` returned
   * `{ok:true}` the instant the click was dispatched.
   * @unverified: ERP paints a new 费用明细行 a few reads after 新增行 [unseen]
   */
  newRowAppearsAfterTicks?: number;
  /**
   * The first N 新增行 clicks go to ERP's loading overlay and are gone: no row ever comes of them. Live 2026-10-19 the
   * overlay came back ~0.3 s after each 新增行 or cell commit, between the hit test and the mouse-down, and took 1 of 13
   * 新增行 clicks (and all 3 clicks made into it on purpose); the next click added the row in 0.5 s.
   * @unverified: the loading overlay takes a 新增行 click and ERP never adds that row [transient]
   */
  newRowClicksLost?: number;
  /**
   * The first N commits of a lookup cell (项目, 费用项目) leave it empty: the Enter came before ERP had resolved the
   * typed code, and ERP dropped it. Live 2026-10-20 3 of 10 first fills (runs 7, 8, 10) read 「」 or 「select」 back
   * on a slow ERP, and the same field written again on the re-run's form took.
   * @unverified: a lookup committed before ERP resolved the code ends empty [transient]
   */
  lookupCommitsLost?: number;
  /**
   * The first committed lookup cell (项目, 费用项目) shows 「」 under the loading overlay for N ms of wall-clock time
   * (ERP's server call, not page reads), then its name; later lookups resolve at once.
   * Live 2026-10-20 20 lookup writes resolved in 0.25-6.2 s (median 0.55 s), the slow ones behind one long
   * DynamicFormService.Call with `.kd-ui-blockingExtention-item` up the whole time; 「」 always turned into the name.
   * @unverified: a lookup resolves after the commit, under the loading overlay [transient]
   */
  lookupResolveMs?: number;
  /**
   * For N page ticks after 新增行 the new row's cells are under a cover. Live 2026-10-20 run 9 stopped on
   * 「「项目」的落点…上盖着DIV」 right after 新增行, while ERP was still re-rendering the grid.
   * @unverified: a cover sits over a freshly added 费用明细行 for a moment [transient]
   */
  newRowCoverTicks?: number;
  /**
   * How many ERP-page evaluations a committed row keeps its `k-grid-edit-row` class — the grid still reporting
   * the row as being edited for a render or two after the value has been taken. `leaveEdit` reads that state
   * once, and `draft-flow.ts` turns `stillEditing: true` into `leave_edit_failed`.
   * @unverified: a committed row keeps k-grid-edit-row for a few reads [transient]
   */
  editRowLingersTicks?: number;
  /**
   * Money writes that land in the CELL and never reach ERP's model: `{ row, column }`, 0-based row, 费用金额 or
   * 税额. The cell shows the typed value and reads back as written; ERP goes on computing 申请报销金额 from the
   * value it kept, which this fake models as 0.00 — so a dropped 税额 leaves 申请报销金额 = 费用金额 and a
   * dropped 费用金额 leaves 申请报销金额 = 税额.
   *
   * That is the live shape of 2026-09-20, where a fill wrote eleven 费用明细行, every cell read back the value
   * typed into it, and three rows still carried a 申请报销金额 that was not 费用金额 + 税额: row 1 ¥32.18 + ¥0.32
   * -> ¥32.18, row 2 ¥15.56 + ¥0.47 -> ¥0.47, row 11 ¥1,677.36 + ¥100.64 -> ¥1,677.36. The form total was
   * 116.52 short and nothing in the fill noticed, because `writeCell` compares the cell it typed into. The
   * MECHANISM is not modelled here (it has not been measured: the ERP host was unreachable for this round) —
   * only the outcome ERP was observed to produce, so the fake stops being kinder than the live page.
   * @unverified: a money write can land in the cell and never reach ERP's model [typing]
   */
  moneyWritesNotTaken?: Array<{ row: number; column: '费用金额' | '税额' }>;
  /**
   * How many ERP-page evaluations a money write takes to reach ERP's MODEL, and — the point of the option — what
   * happens to a second money write issued into the same row before the first one has arrived: it is dropped.
   * The cell shows it and reads back as written; ERP's model never takes it, so 申请报销金额 goes on being
   * computed without it.
   *
   * Measured 2026-09-20 by `server/scripts/probe-money.ts` (ledger V-59), 16 trials on an unsaved 新增 bill:
   * writing the two money cells back to back is correct in 2 of 12 trials, while a 3s gap between them is 4/4,
   * and the failure is always that the SECOND cell reads back EMPTY. Sampling the row frame by frame gives the
   * mechanism: after 费用金额 the row still carries stale values at t=11ms and has caught up by t=266ms; after
   * 税额 the cell reads ¥100.64 at t=2ms while 申请报销金额 is still the net alone, and only by t=258ms does it
   * become net+tax. ERP's model trails the cell by roughly 260ms, and a write issued inside that window is lost.
   *
   * This is the CAUSE of the shape `moneyWritesNotTaken` injects by hand. That option stays: it states an outcome
   * directly, which is the right tool for a test about the witness. This one reproduces how the outcome arises,
   * so a fill that paces itself against ERP's own computed column passes and one that types straight through
   * does not — the fake stops being kinder than the live page.
   * @unverified: ERP's model trails a money cell by ~260ms and drops a second write inside that window [typing]
   */
  moneyModelLagTicks?: number;
  /**
   * How many ERP-page evaluations the freshly opened 发票类型 dropdown's own items sit under a cover — the list
   * painted, its items measurable, and `document.elementFromPoint` at the wanted item still answering the thing
   * on top of it.
   *
   * Measured live 2026-09-20: a 去报销 wrote five 费用明细行 in full, opened 发票类型 on the sixth and stopped on
   * 「发票类型」候选项「普通发票」的落点（x=629 y=697）上盖着DIV. The cell's own point is polled since the last
   * round; the ITEM's was read exactly once, out of the same probe that had just waited for the list to appear.
   * @unverified: the open 发票类型 list's items sit under a cover for a few reads [transient]
   */
  optionItemCoverTicks?: number;
};
export type FakeMutation = { kind: 'import' | 'cell' | 'option' | 'header' | 'addRow' | 'save' | 'draft'; detail: string };

const SLOT = 10;
const COLS = 100;
const BOX = 8;
const ORIGIN = 4;
const ZERO = { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
const READONLY_COLUMNS = new Set(['收票单号', '申请报销金额', '申请付款金额']);
// The live 发票类型 list, all six of it, as `selectOption` read it open on 2026-09-20 (V-72). baox writes three
// of them; the other three are here so that picking the wrong neighbour is a mistake the fake can reproduce.
// recordings/detail-row shows the same six in the same order (recorded-erp.test.ts).
const INVOICE_TYPES = ['普通发票', '增值税发票', '机票', '火车票', '其他运输票', '其他'];
// 13 of the live grid's 21 columns (recordings/detail-row), in the fake's own order: columns align by label, never by
// position, and recorded-erp.test.ts checks every one of these is a live column.
const DETAIL_COLUMNS = ['收票单号', '项目', '费用项目', '发票类型', '开始日期', '结束日期', '住宿/出差地', '出发地', '目的地', '费用金额', '税额', '申请报销金额', '申请付款金额'];
// The live grid's header is recorded (8 of its 15 columns are here; live says 销售方名称 for 销方名称, which nothing
// reads and the kernel goldens pin), its filled rows are not.
// @unverified: 收票信息 rows as the fake fills them after 发票导入单据 [import]
const RECEIPT_COLUMNS = ['收票单', '发票号码', '销方名称', '开票日期', '不含税金额', '税额', '价税合计', '发票类别'];
// The recognised-row grid of the 发票助手, as probe-grid.ts measured it live on 2026-09-19.
// @unverified: the assistant's recognised-row grid columns [upload]
const ASSISTANT_COLUMNS = ['', '销方名称', '发票号码', '价税合计', '税额', '开票日期', '发票信息', '操作'];
// Rows are laid out down a page taller than the viewport, so the later ones are out of reach until something
// scrolls them in — live, rows 0-4 of 10 were inside the 530-high iframe viewport and rows 6-9 were not.
// @unverified: the assistant rows' layout: 250px apart, later rows past the 530px iframe viewport [upload]
const ASSISTANT_ROW_TOP = 300;
const ASSISTANT_ROW_STEP = 250;

const cents = (text: string | null | undefined) => {
  const s = String(text ?? '').replace(/[¥￥,\s]/g, '');
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
};
const money = (value: number) => `¥${(value / 100).toFixed(2)}`;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/**
 * A recorded element whose live box had no area: rendered, but nothing to see or hit. Recorded pages keep the live
 * visibility this way (and `display:none` / `visibility:hidden` as their only style); their positions stay the
 * fake's own grid, because jsdom has no layout to place the live boxes in and overlapping boxes would break the
 * one-element-per-point hit test.
 */
const recordedEmpty = (el: any) => {
  const box = el.getAttribute?.('data-rec-box');
  if (!box) return false;
  const [, , width, height] = String(box).split(',').map(Number);
  return !width || !height;
};

// @unverified: hand-written pages sit on a fake 10px grid, not on live boxes (recorded pages keep live visibility only) [fake]
/** One jsdom document with fake layout, visible-only innerText, and CDP-style evaluation. */
class FakeDocument {
  readonly window: any;
  readonly document: any;
  private readonly slots: any[] = [];
  private readonly slotOf = new WeakMap<object, number>();
  private scrollTop = 0;
  selectAllOn: any = null;

  constructor(html: string, url: string) {
    const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
    this.window = dom.window;
    this.document = this.window.document;
    const self = this;
    const proto = this.window.HTMLElement.prototype;
    proto.getBoundingClientRect = function (this: any) {
      if (!this.isConnected || self.hidden(this) || recordedEmpty(this)) return { ...ZERO };
      const { x, docY, height } = self.layout(this);
      const y = docY - self.scrollTop;
      return { x, y, left: x, top: y, width: BOX, height, right: x + BOX, bottom: y + height };
    };
    Object.defineProperty(proto, 'innerText', { configurable: true, get(this: any) { return self.visibleText(this); } });
    // jsdom has no hit testing, so the fake answers `elementFromPoint` with its own layout — the same answer a
    // click at that point gets, which is the whole point of asking.
    this.document.elementFromPoint = (x: number, y: number) => self.elementAt(x, y);
    proto.scrollIntoView = function (this: any) {
      if (!this.isConnected || self.hidden(this)) return;
      const { docY, height } = self.layout(this);
      self.scrollTop = Math.max(0, Math.round(docY + height / 2 - self.window.innerHeight / 2));
    };
  }

  ready(): Promise<void> {
    if (this.document.readyState === 'complete') return Promise.resolve();
    return new Promise((resolve) => this.window.addEventListener('load', () => resolve()));
  }

  hidden(el: any): boolean {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hidden) return true;
      if (n.style?.display === 'none' || n.style?.visibility === 'hidden') return true;
    }
    return false;
  }

  visibleText(node: any): string {
    if (node.nodeType === 3) return node.nodeValue ?? '';
    if (node.nodeType !== 1 || this.hidden(node) || node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return '';
    let out = '';
    for (const child of node.childNodes) out += this.visibleText(child);
    return out;
  }

  /** This element's box in document coordinates: its grid slot, or the explicit y `data-below-fold` gives it. */
  layout(el: any): { x: number; docY: number; height: number } {
    let slot = this.slotOf.get(el);
    if (slot === undefined) {
      slot = this.slots.length;
      this.slots.push(el);
      this.slotOf.set(el, slot);
    }
    const below = el.getAttribute?.('data-below-fold');
    // `data-zero-height` models an inline element whose only child is a block box: laid out, hit-testable, but
    // measuring 0 high. The 发票助手's 电脑端选取 anchor is one (76x0 live, 2026-09-19).
    return {
      x: ORIGIN + (slot % COLS) * SLOT,
      docY: below === null || below === undefined ? ORIGIN + Math.floor(slot / COLS) * SLOT : Number(below),
      height: el.hasAttribute?.('data-zero-height') ? 0 : BOX,
    };
  }

  /**
   * The element whose box centre is (x, y), as the executor computes centres — and `null` for a point outside the
   * viewport, where a real `Input.dispatchMouseEvent` reaches nothing and `document.elementFromPoint` returns null.
   */
  elementAt(x: number, y: number): any {
    if (y < 0 || y >= this.window.innerHeight || x < 0 || x >= this.window.innerWidth) return null;
    const col = (x - ORIGIN - BOX / 2) / SLOT;
    const row = (y + this.scrollTop - ORIGIN - BOX / 2) / SLOT;
    if (Number.isInteger(col) && Number.isInteger(row) && col >= 0 && col < COLS) {
      const el = this.slots[row * COLS + col];
      if (el && el.isConnected && !this.hidden(el) && el.getAttribute?.('data-below-fold') === null) return this.covering(el);
    }
    // A `data-below-fold` box is off the slot grid, so it is found by measuring the few that exist.
    for (const el of this.slots) {
      if (!el.isConnected || this.hidden(el) || el.getAttribute?.('data-below-fold') === null) continue;
      const b = el.getBoundingClientRect();
      if (Math.round(b.x + b.width / 2) === x && Math.round(b.y + b.height / 2) === y) return this.covering(el);
    }
    return null;
  }

  /** `data-covered-by` names an element painted over this one: what is at the point is the cover, not the target. */
  covering(el: any): any {
    const selector = el.getAttribute?.('data-covered-by');
    return selector ? this.document.querySelector(selector) ?? el : el;
  }

  async evaluate(expression: string) {
    try {
      let value = this.window.eval(expression);
      if (value && typeof value.then === 'function') value = await value;
      return { result: { value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) } };
    } catch (error: any) {
      return { exceptionDetails: { exception: { description: String(error?.stack ?? error) } } };
    }
  }
}

export type FakeErp = Awaited<ReturnType<typeof createFakeErp>>;

/**
 * The ERP page the fake renders, placeholders filled: the main console when logged in, the login page otherwise.
 */
function erpFixtureHtml(loggedIn: boolean, values: { uuid: string; displayName: string; erpBuild: string; formId: string; today: string }) {
  return fixture(loggedIn ? 'erp-main.html' : 'erp-login.html')
    .replaceAll('{{UUID}}', values.uuid).replaceAll('{{DISPLAY_NAME}}', escapeHtml(values.displayName))
    .replaceAll('{{BUILD}}', values.erpBuild).replaceAll('{{FORM_ID}}', values.formId).replaceAll('{{TODAY}}', values.today);
}

/**
 * Kingdee's ExecuteBillQuery answered from the fake's master data: the JSON body ERP returns for a request body the
 * catalog check sends. Shared with the real-browser harness, which serves it at the same path.
 */
// @unverified: ExecuteBillQuery request and answer shape for 项目 / 费用项目 lookups [fake]
export function answerBillQuery(requestBody: string, data: { projects: FakeMasterData[]; expenseItems: FakeMasterData[] }): unknown {
  const payload = JSON.parse(JSON.parse(requestBody).parameters[0]);
  const source = payload.FormId === 'BD_Expense' ? data.expenseItems : payload.FormId === 'BJYC_ProJect' ? data.projects : null;
  const codes = [...String(payload.FilterString).matchAll(/'([^']*)'/g)].map((m) => m[1]);
  return source === null
    ? [[{ Result: { ResponseStatus: { Errors: [{ Message: `未知业务对象 ${payload.FormId}` }] } } }]]
    : source.filter((row) => codes.includes(row.code)).map((row) => [row.code, row.name, row.documentStatus ?? 'C', row.forbidStatus ?? 'A']);
}

export async function createFakeErp(options: FakeErpOptions) {
  const origin = options.origin ?? 'http://erp.antute.com.cn';
  const url = `${origin}/k3cloud/html5/index.aspx`;
  const account = options.account ?? { displayName: '刘明建', account: 'luo.liu', tenant: 'tenant-a' };
  const erpBuild = options.erpBuild ?? '8.2.830.9';
  const formId = options.formId ?? 'ER_ExpReimbursement';
  const today = options.today ?? '2026/9/15';
  const billNo = options.billNo ?? 'FYBX2026090001';
  const invoicesBySha = new Map(options.invoices.map((invoice) => [sha256(invoice.bytes), invoice]));
  const receiptLedger: FakeReceiptLedger = options.receiptLedger ?? new Map();

  let lastTypedAt = 0;
  // Cells that have been opened for editing at least once, for `firstTypingLostOn`.
  const editedOnce = new Set<any>();
  // Dropdown cells that have been clicked once already, for `dropdownNeedsSecondClick`.
  const openedDropdownOnce = new Set<any>();
  const mutations: FakeMutation[] = [];
  const commands: Array<{ method: string; params: Record<string, any>; sessionId: string | null }> = [];
  const listeners = new Map<string, Set<CdpListener>>();
  const hooks: { onMutation?: (mutation: FakeMutation) => void } = {};
  let loggedIn = options.loggedIn ?? true;
  let targetAlive = true;
  let autoAttach = false;
  let formUuid = 'a1b2c3d4e5f6';
  const recorded = options.recording ? loadRecording(options.recording) : null;
  let recordedStep = 0;
  let child: { doc: FakeDocument; sessionId: string; targetId: string } | null = null;
  let main: FakeDocument = await render();
  // `before` is the cell's value when the editor opened: a datepicker keeps it when it cannot parse what it holds.
  // `swallow`: this editing session's keys go nowhere, because the ERP is still re-rendering the control
  // (`firstTypingLostOn`). Cleared by a second click into the same cell.
  let editor: { td: any; tr: any; input: any; column: string; before: string; swallow?: boolean } | null = null;
  let activePane: string | null = null;
  let uploadBatches = 0;
  let assistantTicks = 0;
  let mainTicks = 0;
  let formPanelActiveAt: number | null = null;
  let blockerUntil: number | null = null;
  let optionCoverUntil: number | null = null;
  let pendingNewRow: number | null = null;
  let optionItemCoverUntil: number | null = null;
  const lingeringEditRows: Array<{ tr: any; due: number }> = [];
  let pendingReport: { start: number; due: number; summary: string; rows: readonly string[] } | null = null;
  const pendingRecognition: Array<{ due: number; files: Uint8Array[] }> = [];
  let dropdown: { td: any; tr: any; list: any; span: any } | null = null;
  /**
   * Which 选择发票 menu item the clicks actually landed on. 合并生成费用明细 / 不合并生成费用明细 make ERP write
   * the 费用明细 rows itself, so a run that reaches the import in either of them has already gone wrong; the fake
   * records the mode rather than simulating those rows, and the tests assert no wrong mode is ever reached.
   */
  let importMode: string | null = null;

  function mutate(kind: FakeMutation['kind'], detail: string) {
    const mutation = { kind, detail };
    mutations.push(mutation);
    hooks.onMutation?.(mutation);
  }

  /** The recorded page on screen: the login page while logged out, else the flow's page `recordedStep`. */
  function recordedPage(): RecordedPage | null {
    return recorded ? (loggedIn ? recorded.manifest.pages[recordedStep]! : recorded.manifest.loggedOut) : null;
  }

  async function renderRecorded(page: RecordedPage) {
    const doc = new FakeDocument(fillIdentity(recorded!.html(page), account), url);
    (doc.window as unknown as { KDResVer: string | undefined }).KDResVer = page.resVer ?? undefined;
    const loginInfo = loginInfoOf(page, account);
    if (loginInfo) doc.window.localStorage.setItem('k3cloudloginInfo', loginInfo);
    await doc.ready();
    await showRecordedChild(page);
    return doc;
  }

  /**
   * The recorded page's child frame (the 发票无忧助手) as the fake's child target: announced when it first appears,
   * kept under the same session when the next page still has it (live, the iframe navigates in place), and
   * detached when a page no longer has it.
   */
  async function showRecordedChild(page: RecordedPage) {
    if (!page.child) {
      if (child) {
        const { sessionId } = child;
        child = null;
        emitEvent('Target.detachedFromTarget', { sessionId });
      }
      return;
    }
    const doc = new FakeDocument(fillIdentity(recorded!.html(page.child), account), page.child.url);
    await doc.ready();
    const appearing = !child;
    child = { doc, sessionId: child?.sessionId ?? 'piaozone-session-1', targetId: child?.targetId ?? 'piaozone-1' };
    if (appearing && autoAttach) announceChild();
  }

  /** `Target.attachedToTarget` for the child, after the command that caused it has returned (as CDP does). */
  function announceChild() {
    if (!child) return;
    const { sessionId, targetId, doc } = child;
    setTimeout(() => {
      emitEvent('Target.attachedToTarget', { sessionId, targetInfo: { targetId, type: 'iframe', url: 'about:blank' } });
      emitEvent('Target.targetInfoChanged', { targetInfo: { targetId, type: 'iframe', url: doc.window.location.href } });
    }, 0);
  }

  /**
   * A click on a recorded page, on the page itself or in its child frame: the next page when it lands where the
   * live click did, nothing otherwise. Where it landed live is the marked element, anything inside it, or a wrapper
   * that shows nothing else (the cell around a cell's text, the arrow around its icon): the executor aims at the
   * control, live hit-testing answered its innermost element.
   */
  async function replayClick(doc: FakeDocument, el: any) {
    const page = recordedPage();
    const inChild = page?.click?.frame === 'child';
    if (!loggedIn || !page?.click || inChild !== (doc !== main)) return;
    const mark = doc.document.querySelector(`[${CLICK_MARK}]`);
    const wrapper = el.contains(mark) && String(el.textContent).trim() === String(mark?.textContent).trim();
    if (!mark || !(mark === el || mark.contains(el) || wrapper)) return;
    recordedStep += 1;
    main = await render();
  }

  async function render() {
    const page = recordedPage();
    if (page) return renderRecorded(page);
    const html = !loggedIn && options.entryPageBlank
      ? '<!doctype html><html><head><title>金蝶云星空</title></head><body></body></html>'
      : erpFixtureHtml(loggedIn, { uuid: formUuid, displayName: account.displayName, erpBuild, formId, today });
    const doc = new FakeDocument(html, url);
    // K3Cloud states its front-end resource version nowhere in the DOM, only on this global, which is where the
    // compatibility fingerprint reads it. jsdom runs no inline script, so the fake sets it directly.
    // `?ver=<build>` and {user, acc} are what the recordings show logged in (recorded-erp.test.ts).
    (doc.window as unknown as { KDResVer: string }).KDResVer = `?ver=${erpBuild}`;
    // localStorage keeps the last account even on the login page (probe.mjs fact 4). The recorder's login page comes
    // from a browser context with no history, so it cannot show this.
    // @unverified: k3cloudloginInfo survives logout onto the login page [unseen]
    doc.window.localStorage.setItem('k3cloudloginInfo', JSON.stringify({ user: account.account, acc: account.tenant }));
    doc.window.fetch = async (input: string, init: { body: string }) => {
      const payload = String(input).includes('ExecuteBillQuery') ? JSON.parse(JSON.parse(init.body).parameters[0]) : null;
      const body = String(input).includes('DynamicFormService.View') ? answerView(init.body)
        : payload?.FormId === formId ? answerDraftQuery(payload) : answerBillQuery(init.body, options);
      return { status: 200, text: async () => JSON.stringify(body) };
    };
    await doc.ready();
    // Already up when the run starts: nobody was at the machine to answer it.
    if (loggedIn && options.idlePromptCovers) {
      const prompt: any = doc.document.querySelector('#idle-window');
      if (prompt) prompt.style.display = '';
      doc.document.querySelector(options.idlePromptCovers)?.setAttribute('data-covered-by', IDLE_COVER);
    }
    if (options.notFillEntryBelowFold) doc.document.querySelector('a[id$="tbNotFillEntry"]')?.setAttribute('data-below-fold', '1240');
    if (options.notFillEntryHitsNeighbour) doc.document.querySelector('a[id$="tbNotFillEntry"]')?.setAttribute('data-covered-by', 'a[id$="tbMergeFillEntry"]');
    if (loggedIn && options.menuPath) {
      (doc.document.querySelector('.kd-mainconsole-shortcuts') as any).style.display = 'none';
      selectMenuNode(doc.document, options.menuPath.selected);
      const parent: any = doc.document.querySelector(`[data-action="menu-child"][data-node="${options.menuPath.selected}"]`)?.closest('li[id^="parentli_"]');
      if (parent) toggleMenuRow(parent);
    }
    if (loggedIn && options.consoleBlockerTicks) (doc.document.querySelector('#console-blocker') as any).style.display = '';
    return doc;
  }

  const q = (selector: string) => main.document.querySelector(selector);
  const grid = (name: 'detail' | 'receipts') => main.document.querySelector(`.kd-grid-panel[data-grid="${name}"]`);
  const dataRows = (name: 'detail' | 'receipts') => [...grid(name).querySelectorAll('tbody tr')].filter((tr: any) => !tr.classList.contains('k-footer-template'));
  const columnsOf = (name: 'detail' | 'receipts') => (name === 'detail' ? DETAIL_COLUMNS : RECEIPT_COLUMNS);
  const cellOf = (tr: any, name: 'detail' | 'receipts', column: string) => tr.children[columnsOf(name).indexOf(column)];
  const textOf = (tr: any, name: 'detail' | 'receipts', column: string) => String(cellOf(tr, name, column)?.textContent ?? '').trim();
  const setText = (tr: any, name: 'detail' | 'receipts', column: string, text: string) => {
    const td = cellOf(tr, name, column);
    const inner = td.querySelector('span, a');
    if (inner) inner.textContent = text; else td.textContent = text;
  };
  const show = (el: any, on: boolean) => { if (el) el.style.display = on ? '' : 'none'; };
  // The main menu (`menuPath`): a first-level row expands or collapses on a click; a second-level node becomes the
  // selection, and the right panel shows its groups. Declarations, not `show`, because the first render calls them.
  function showMenuPart(el: any, on: boolean) { if (el) el.style.display = on ? '' : 'none'; }
  function toggleMenuRow(li: any) {
    const open = !li.classList.contains('kd-nav-menutreenewstyle-expand');
    li.classList.toggle('kd-nav-menutreenewstyle-expand', open);
    showMenuPart(li.querySelector('ul.kd-tabsnewsyle-list'), open);
  }
  function selectMenuNode(doc: any, node: string) {
    for (const panel of doc.querySelectorAll('#system-menu .menu-right')) showMenuPart(panel, panel.getAttribute('data-node') === node);
  }
  let swallowedClicks = 0;
  const blockerShown = () => !!options.consoleBlockerTicks && mainTicks < options.consoleBlockerTicks;
  const visible = (el: any) => !!el && !main.hidden(el);

/**
 * What a Kendo datepicker makes of a string, measured live on the 开始日期 editor 2026-09-20: it parses the
 * FRONT of the value and ignores whatever follows. `2026/9/202026/9/1` became 2026/9/20 and
 * `2026/9/22026/9/3` became 2026/9/22 — a wrong date that looks perfectly plausible. Both formats the ERP
 * accepts normalise to `YYYY/M/D`: `2026-09-07` read back 2026/9/7 and `2026/09/08` read back 2026/9/8.
 * No leading date at all: the control keeps the value it had (not measured on an EMPTY commit, which this
 * fake therefore treats the same way).
 */
const DATE_COLUMNS = new Set(['开始日期', '结束日期']);
const setCaret = (el: any, at: number) => { try { el.setSelectionRange(at, at); } catch { /* not a text input */ } };
const caretOf = (el: any) => (typeof el.selectionStart === 'number' ? el.selectionStart : String(el.value).length);
const kendoDate = (raw: string) => {
  const m = /^\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(String(raw));
  return m ? `${m[1]}/${Number(m[2])}/${Number(m[3])}` : null;
};

  function display(column: string, raw: string) {
    switch (column) {
      case '项目': return options.projects.find((p) => p.code === raw)?.name ?? '';
      case '费用项目': return options.expenseItems.find((p) => p.code === raw)?.name ?? '';
      case '费用金额':
      case '税额': return cents(raw) === null ? '' : money(cents(raw)!);
      default: return raw;
    }
  }

  // What ERP kept for a cell whose write never reached its model: the cell shows the typed value, the model does
  // not have it. Keyed by the <td>, so it follows the row it belongs to.
  const notTaken = new Map<any, string>();
  // Money writes ERP has taken into the cell but not yet into its model, keyed by the row: one row settles one
  // write at a time, which is exactly why the second write inside the window has nowhere to land.
  const pendingMoney = new Map<any, { td: any; due: number }>();
  const MONEY_COLUMNS = new Set(['费用金额', '税额']);
  const modelOf = (tr: any, column: string) => {
    const td = cellOf(tr, 'detail', column);
    return notTaken.has(td) ? notTaken.get(td)! : textOf(tr, 'detail', column);
  };

  // @unverified: 申请报销金额 = 费用金额 + 税额, recalculated when either is committed [typing]
  function recalc(tr: any) {
    const net = cents(modelOf(tr, '费用金额'));
    const tax = cents(modelOf(tr, '税额')) ?? 0;
    const total = net === null ? '' : money(net + tax);
    setText(tr, 'detail', '申请报销金额', total);
    setText(tr, 'detail', '申请付款金额', total);
  }

  function updateTotals() {
    const footer = (name: 'detail' | 'receipts') => grid(name).querySelector('tr.k-footer-template');
    const detailSum = dataRows('detail').map((tr) => cents(textOf(tr, 'detail', '申请报销金额')));
    setText(footer('detail'), 'detail', '申请报销金额', detailSum.some((v) => v !== null) ? money(detailSum.reduce<number>((a, v) => a + (v ?? 0), 0)) : '');
    const receiptSum = dataRows('receipts').map((tr) => cents(textOf(tr, 'receipts', '价税合计')) ?? 0);
    setText(footer('receipts'), 'receipts', '价税合计', receiptSum.length ? (receiptSum.reduce((a, v) => a + v, 0) / 100).toFixed(2) : '');
  }

  function linkReceipt(tr: any) {
    if (!options.assumeReceiptLink || textOf(tr, 'detail', '收票单号')) return;
    const net = cents(modelOf(tr, '费用金额'));
    const tax = cents(modelOf(tr, '税额'));
    const linked = new Set(dataRows('detail').map((row) => textOf(row, 'detail', '收票单号')).filter(Boolean));
    const hits = dataRows('receipts').filter((row) => cents(textOf(row, 'receipts', '不含税金额')) === net
      && cents(textOf(row, 'receipts', '税额')) === tax && !linked.has(textOf(row, 'receipts', '收票单')));
    if (hits.length === 1) setText(tr, 'detail', '收票单号', textOf(hits[0], 'receipts', '收票单'));
  }

  // @unverified: cell editing: select-all + typing + Enter/Tab commit, F7 code resolved to its name on commit [typing]
  function commitEditor() {
    if (!editor) return;
    const { td, tr, input, column, before } = editor;
    editor = null;
    // The commit reads Kendo's model, not the DOM input. Inside the settle window the model still holds `before`.
    const settle = options.editorSettleTicks ?? 0;
    if (settle > 0 && mainTicks - lastTypedAt < settle) input.value = before;
    if ((column === '项目' || column === '费用项目') && lostLookupCommits < (options.lookupCommitsLost ?? 0)) {
      lostLookupCommits += 1;
      input.value = '';
    }
    // A date column is not read as text: the datepicker parses what it holds, and what it cannot parse it
    // refuses, keeping its previous value — which is how a typed date silently became today's.
    const text = DATE_COLUMNS.has(column)
      ? kendoDate(String(input.value)) ?? before
      : display(column, String(input.value).trim());
    td.textContent = text;
    // Written again while ERP is still resolving it: the edit and ERP's own work race, and the cell ends empty.
    const resolving = pendingLookups.findIndex((pending) => pending.td === td);
    if (resolving >= 0) {
      pendingLookups.splice(resolving, 1);
      td.textContent = '';
    } else if ((column === '项目' || column === '费用项目') && options.lookupResolveMs && text !== '' && !slowLookupDone) {
      slowLookupDone = true;
      td.textContent = '';
      show(q('#form-blocker'), true);
      pendingLookups.push({ td, text, due: Date.now() + options.lookupResolveMs });
    }
    // A write ERP does not take: the cell keeps the typed value, ERP's model keeps 0.00 (`moneyWritesNotTaken`).
    const rowIndex = dataRows('detail').indexOf(tr);
    if ((options.moneyWritesNotTaken ?? []).some((drop) => drop.row === rowIndex && drop.column === column)) notTaken.set(td, '0.00');
    else notTaken.delete(td);
    // The model lag (V-59). During the window the model keeps what it had; a second money write arriving inside
    // another one's window is not queued behind it — it is dropped, and the model keeps what it had for good.
    const lag = options.moneyModelLagTicks ?? 0;
    if (lag > 0 && MONEY_COLUMNS.has(column)) {
      const held = notTaken.has(td) ? notTaken.get(td)! : before;
      const inFlight = pendingMoney.get(tr);
      notTaken.set(td, held);
      if (!inFlight || mainTicks >= inFlight.due) pendingMoney.set(tr, { td, due: mainTicks + lag });
    }
    leaveEditClass(tr);
    mutate('cell', `${column}=${text}`);
    // Linked recalculation: a new 费用金额 clears 税额 (kernel erpform settleGrid note).
    if (column === '费用金额') { setText(tr, 'detail', '税额', ''); notTaken.delete(cellOf(tr, 'detail', '税额')); }
    recalc(tr);
    if (column === '税额') linkReceipt(tr);
    updateTotals();
  }

  function closeDropdown() {
    if (!dropdown) return;
    dropdown.list.remove();
    leaveEditClass(dropdown.tr);
    dropdown.span.blur();
    dropdown = null;
  }

  function editCell(td: any) {
    // Live, the cover was over the NEXT cell to be written, right after the previous one committed.
    if (options.invoiceTypeCoverTicks) optionCoverUntil = mainTicks + options.invoiceTypeCoverTicks;
    const tr = td.parentElement;
    const column = DETAIL_COLUMNS[[...tr.children].indexOf(td)]!;
    if (READONLY_COLUMNS.has(column)) return;
    commitEditor();
    closeDropdown();
    tr.classList.add('k-grid-edit-row');
    if (column === '发票类型') {
      const span = td.querySelector('span') ?? td.appendChild(main.document.createElement('span'));
      span.setAttribute('tabindex', '0');
      span.focus();
      // The first click only puts the cell into edit; the list waits for the next one.
      // Nothing is registered as an editor here: live, the first click only opens the row for editing, and it is
      // the LIST that the second click brings. Registering the span would make the commit write through it.
      if (options.dropdownNeedsSecondClick && !openedDropdownOnce.has(td)) { openedDropdownOnce.add(td); return; }
      const list = main.document.createElement('ul');
      list.className = 'k-list';
      for (const option of INVOICE_TYPES) {
        const li = main.document.createElement('li');
        li.setAttribute('role', 'option');
        li.textContent = option;
        list.appendChild(li);
      }
      main.document.body.appendChild(list);
      if (options.optionItemCoverTicks) optionItemCoverUntil = mainTicks + options.optionItemCoverTicks;
      dropdown = { td, tr, list, span };
      syncOptionItemCover();
      return;
    }
    const current = String(td.textContent).trim().replace(/^[¥￥]/, '');
    td.textContent = '';
    const input = main.document.createElement('input');
    // A date column's editor is a Kendo datepicker, and select-all does nothing to it (see `key`). Everything
    // else in this grid is a plain input that select-all works on.
    if (DATE_COLUMNS.has(column)) input.setAttribute('data-role', 'datepicker');
    input.value = current;
    td.appendChild(input);
    input.focus();
    // The caret lands where the CLICK landed, not at the end of the value: traced live on 结束日期, a click at the
    // centre of the cell put it at offset 8 of `2026/9/20`, so Backspace alone stranded the last character.
    setCaret(input, Math.max(0, current.length - 1));
    // Only the first editing session on a given cell swallows: a second click gets a control that works.
    const swallow = column === options.firstTypingLostOn && !editedOnce.has(td);
    editedOnce.add(td);
    editor = { td, tr, input, column, before: current, swallow };
  }

  function pickOption(text: string) {
    if (!dropdown) return;
    const { tr, span } = dropdown;
    const before = span.textContent;
    span.textContent = text;
    closeDropdown();
    mutate('option', `发票类型=${text}`);
    // Changing the invoice type clears an entered tax (save-contract order note).
    if (before !== text) { setText(tr, 'detail', '税额', ''); recalc(tr); }
    updateTotals();
  }

  /** Append one blank 费用明细行 above the footer, and log the click that asked for it. */
  function insertDetailRow() {
    const tbody = grid('detail').querySelector('tbody');
    const added = defaultRow();
    tbody.insertBefore(added, tbody.querySelector('tr.k-footer-template'));
    if (options.newRowCoverTicks) {
      for (const td of added.querySelectorAll('td')) td.setAttribute('data-covered-by', '#form-blocker');
      newRowCover = { tr: added, until: mainTicks + options.newRowCoverTicks };
    }
    mutate('addRow', String(dataRows('detail').length));
  }

  /** A lookup ERP has resolved by now (`lookupResolveMs`): its name shows and the overlay lifts. */
  function flushLookups() {
    for (const pending of [...pendingLookups]) {
      if (Date.now() < pending.due) continue;
      pending.td.textContent = pending.text;
      pendingLookups.splice(pendingLookups.indexOf(pending), 1);
    }
    if (options.lookupResolveMs && pendingLookups.length === 0 && blockerUntil === null) show(q('#form-blocker'), false);
  }

  /** The cover over a freshly added row lifting, `newRowCoverTicks` reads after 新增行. */
  function uncoverNewRow() {
    if (!newRowCover || mainTicks < newRowCover.until) return;
    for (const td of newRowCover.tr.querySelectorAll('td')) td.removeAttribute('data-covered-by');
    newRowCover = null;
  }

  /** Drop the edit class, or let it linger for a few reads when the test asks for the lingering shape. */
  function leaveEditClass(tr: any) {
    const delay = options.editRowLingersTicks ?? 0;
    if (delay > 0) lingeringEditRows.push({ tr, due: mainTicks + delay });
    else tr.classList.remove('k-grid-edit-row');
  }

  /** Rows the grid still paints as being edited, after the value was taken. */
  function flushEditClass() {
    for (const pending of [...lingeringEditRows]) {
      if (Date.now() < pending.due) continue;
      pending.tr.classList.remove('k-grid-edit-row');
      lingeringEditRows.splice(lingeringEditRows.indexOf(pending), 1);
    }
  }

  /** Money writes whose window has elapsed: the model takes the value the cell has been showing all along. */
  function flushMoneyModel() {
    let flushed = false;
    for (const [tr, pending] of [...pendingMoney]) {
      if (Date.now() < pending.due) continue;
      pendingMoney.delete(tr);
      notTaken.delete(pending.td);
      recalc(tr);
      // 收票 linking reads ERP's MODEL, not the cells, so it cannot happen at commit time while the value is
      // still in flight — it happens when the model takes the value, which is here.
      linkReceipt(tr);
      flushed = true;
    }
    // Only when something actually arrived: `updateTotals` reaches into the detail grid, and this runs on every
    // page evaluation — including the ones before any 费用报销单 is open, where that grid does not exist yet.
    if (flushed) updateTotals();
  }

  /** A 新增行 whose row ERP has not painted yet. */
  function flushNewRow() {
    if (pendingNewRow === null || mainTicks < pendingNewRow) return;
    pendingNewRow = null;
    insertDetailRow();
  }

  function defaultRow() {
    const tr = main.document.createElement('tr');
    tr.className = 'k-master-row';
    tr.innerHTML = DETAIL_COLUMNS.map((column) => (column === '收票单号' ? '<td><a class="disabled"></a></td>'
      : column === '发票类型' ? '<td><span class="k-input">普通发票</span></td>'
        : column === '开始日期' || column === '结束日期' ? `<td>${today}</td>` : '<td></td>')).join('');
    return tr;
  }

  function message(text: string) {
    const win = q('#message-window');
    win.querySelector('.k-window-message').textContent = text;
    show(win, true);
  }

  /**
   * ERP's 处理结果 window: its answer to 发票导入单据 — a summary line over a grid of 序号 / 关键字 / 状态 / 问题描述,
   * one row per invoice. 退出 closes it.
   *
   * The summary has two wordings, both measured live, and the fake writes whichever the outcome calls for. With
   * failures: 「执行成功：10；执行失败：2」. With none: 「全部执行成功：10」 — which names no 执行失败 at all. The fake
   * used to format both halves always, so the all-success wording never reached the judge and a live import of 10
   * of 10 was read as «still loading» until the budget ran out.
   *
   * It opens empty and fills in a moment later — live 2026-09-19 a read on first sight of the window returned the
   * text 「处理结果」 alone, with no summary in it yet.
   */
  function result(summary: string, rows: readonly string[]) {
    const win = q('#result-window');
    win.querySelector('.k-window-message').textContent = '';
    show(win, true);
    // No 遮罩 (modal backdrop) live: the window floats over the form and takes every click aimed at what is
    // under it, silently. 事由 is the first control the fill touches, so that is the one this covers.
    if (options.importReportStaysOpen) {
      q(`[id$="-FCAUSA-EDITOR"]`).setAttribute('data-covered-by', '#result-window .k-window-message');
    }
    if (options.importReportStalled) return;
    const ticks = Math.max(1, options.importReportTicks ?? 2);
    pendingReport = { start: mainTicks, due: mainTicks + ticks, summary, rows };
    paintReport();
  }

  /**
   * The report as much of it as has been painted by now. The toolbar words and the grid header are part of what a
   * reader of this window actually sees, and the header carries 序号 / 关键字 / 状态 with no 序号 of its own — the
   * fake keeps them so a judge cannot pass by counting a header row as an invoice. The summary lands last, which
   * is why a half-painted grid of nothing but 成功 may not be read as a verdict.
   */
  function paintReport() {
    if (!pendingReport) return;
    const { start, due, summary, rows } = pendingReport;
    const done = mainTicks >= due;
    // A report that takes its time paints its grid a row at a time; the default two-tick one is empty, then whole.
    const progress = (mainTicks - start) / (due - start);
    const painted = done ? rows : (options.importReportTicks ?? 0) > 2 ? rows.slice(0, Math.floor(rows.length * progress)) : [];
    // Live, the window is on screen with NOTHING in it — no toolbar, no header, no summary — until it starts
    // painting its grid, so nothing here appears before the first row does.
    const text = painted.length === 0 && !done ? '' : [
      '打开 引出全部记录 引出失败记录 （您可以单击字段链接定位到所在位置）',
      ...(done ? [summary] : []),
      '设置 序号 设置 关键字 设置 状态 设置 问题描述',
      ...painted.map((row, index) => `${index + 1} ${row}`),
    ].join(' ');
    q('#result-window .k-window-message').textContent = text;
    if (done) pendingReport = null;
  }

  function emitEvent(method: string, params: Record<string, unknown>) {
    for (const listener of listeners.get(method) ?? []) listener(params, null);
  }

  async function openAssistant() {
    show(q('#assistant-window'), true);
    assistantOpens += 1;
    if (assistantOpens <= (options.assistantBlankOpens ?? 0)) return;
    const doc = new FakeDocument(fixture('piaozone-assistant.html'), 'https://www.piaozone.com/pwy-assistant/index.html');
    await doc.ready();
    child = { doc, sessionId: 'piaozone-session-1', targetId: 'piaozone-1' };
    activePane = null;
    uploadBatches = 0;
    assistantTicks = 0;
    pendingRecognition.length = 0;
    if (autoAttach) {
      const { sessionId, targetId } = child;
      setTimeout(() => {
        emitEvent('Target.attachedToTarget', { sessionId, targetInfo: { targetId, type: 'iframe', url: 'about:blank' } });
        emitEvent('Target.targetInfoChanged', { targetInfo: { targetId, type: 'iframe', url: doc.window.location.href } });
      }, options.assistantAttachDelayMs ?? 0);
    }
  }

  // @unverified: 发票导入单据: 收票单 minted per invoice, 收票信息 rows filled, 重复报销 refusals in 提示 [import]
  function importInvoices() {
    if (!child) return;
    const rows = [...child.doc.document.querySelectorAll('tbody tr')].filter((tr: any) => tr.querySelector('input.ant-checkbox-input')?.checked);
    const selected = (rows as any[]).map((row) => invoicesBySha.get(row.getAttribute('data-sha256'))!);
    // A refusal is per invoice, not per import: measured live 2026-09-19, two invoices already bound to a SAVED
    // 费用报销单 were refused by name while the other ten bound in the same click (「执行成功：10；执行失败：2」).
    // ERP's own words come back in the 处理结果 window, one line per invoice (ADR-0027 judges on that list).
    const refused = selected.filter((invoice) => invoice.importRefusal);
    const accepted = selected.filter((invoice) => !invoice.importRefusal);
    const tbody = grid('receipts').querySelector('tbody');
    const footer = tbody.querySelector('tr.k-footer-template');
    const rowFor = (receiptNumber: string) => dataRows('receipts').find((tr: any) => textOf(tr, 'receipts', '收票单') === receiptNumber);
    const appendRow = (values: readonly string[]) => {
      const tr = main.document.createElement('tr');
      tr.className = 'k-master-row';
      tr.innerHTML = values.map((value) => `<td>${escapeHtml(value)}</td>`).join('');
      tbody.insertBefore(tr, footer);
      return tr;
    };
    const imported: string[] = [];
    const report: string[] = [];
    for (const invoice of accepted) {
      const masked = `${invoice.invoiceNumber.slice(0, 4)}************${invoice.invoiceNumber.slice(-4)}`;
      const values = [invoice.receiptNumber, masked, invoice.seller, invoice.issueDate, invoice.net, invoice.tax, invoice.gross, invoice.category];
      // A 收票单 ERP already holds is re-bound to the bill being imported into, rather than minted a second time:
      // that is what「已存在对应的收票单，已进行覆盖」means, and it is why an import that was never saved can be
      // replayed onto a fresh 新增单 (ADR-0026). The fake shows a bound 收票单 as a row of the 收票信息 grid, so
      // re-binding puts the record's row back on this bill; the overwrite rule below then rewrites it.
      const bound = receiptLedger.get(invoice.receiptNumber);
      if (bound && !rowFor(invoice.receiptNumber)) appendRow(bound);
      // ERP identifies a receipt row (收票行) by its receipt number (收票单): importing an invoice the bill already
      // holds rewrites that row in place instead of adding a second one (ADR-0026). Because the identity that
      // decides this is the one the row keeps, a rewrite cannot strand a detail row's 收票单号 link.
      const held = rowFor(invoice.receiptNumber);
      if (held) {
        RECEIPT_COLUMNS.forEach((column, index) => setText(held, 'receipts', column, values[index]!));
      } else {
        appendRow(values);
      }
      // Minting a 收票单 and overwriting one ERP already holds read differently in the report, and the difference
      // is how ADR-0026's overwrite shows up on screen.
      report.push(`接收发票 成功 号码为【${invoice.invoiceNumber}】的发票${bound
        ? `已存在对应的收票单【${invoice.receiptNumber}】，已进行覆盖！`
        : `接收成功，生成收票单【${invoice.receiptNumber}】`}`);
      receiptLedger.set(invoice.receiptNumber, values);
      imported.push(invoice.receiptNumber);
    }
    for (const invoice of refused) report.push(`接收发票 失败 号码为【${invoice.invoiceNumber}】的发票${invoice.importRefusal}`);
    updateTotals();
    show(q('#assistant-window'), false);
    if (!options.importReportMissing) {
      result(refused.length === 0
        ? `全部执行成功：${accepted.length}`
        : `执行成功：${accepted.length}；执行失败：${refused.length}`, report);
    }
    const closing = child;
    mutate('import', imported.join(','));
    // The iframe target goes away after this click completes, and NOTHING replaces it: the whole answer to the
    // click is on the ERP page. Its own mouseReleased still reaches it.
    setTimeout(() => {
      if (child === closing) child = null;
      emitEvent('Target.detachedFromTarget', { sessionId: closing.sessionId });
    }, 0);
  }

  // @unverified: 保存 turns the form to 费用报销单-修改 and refuses an empty 事由 with 事由不能为空，保存失败 [save]
  function save() {
    commitEditor();
    closeDropdown();
    const purpose = String(q(`[id$="-FCAUSA-EDITOR"]`).value).trim();
    if (!purpose) { message('事由不能为空，保存失败'); return; }
    q('.form-tab').textContent = '费用报销单-修改';
    q(`[id$="-FBILLNO-EDITOR"]`).value = billNo;
    mutate('save', billNo);
  }

  // 暂存 drafts this ERP holds: what WebAPI View returns by 内码, and what ExecuteBillQuery finds by 事由.
  // @unverified: 暂存 turns the tab to 费用报销单-修改, leaves 单据编号 empty and lands a draft with status Z (S5 live) [unseen]
  // @unverified: View by 内码 answers Result.Result with DocumentStatus, BillNo, FCausa and the RecInvInfo / ER_ExpenseReimbEntry rows; a query by FCausa finds the draft [unseen]
  const drafts: Array<{ id: string; causa: string; receipts: string[][]; details: string[][] }> = [];
  let nextDraftId = 119946;
  // A model row as the page shows it, its cells as plain values; a page date (2026/9/4) is stored the way the model
  // holds dates (2026-09-04T00:00:00).
  const gridModel = (grid: string) => [...main.document.querySelectorAll(`.kd-grid-panel[data-grid="${grid}"] tbody tr:not(.k-footer-template)`)]
    .map((tr: any) => [...tr.querySelectorAll('td')].map((td: any) => String(td.textContent ?? '').trim())
      .map((cell) => { const d = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(cell); return d ? `${d[1]}-${d[2]!.padStart(2, '0')}-${d[3]!.padStart(2, '0')}T00:00:00` : cell; }))
    .filter((cells) => cells.some((cell) => cell !== '' && cell !== '普通发票'));
  function saveDraft() {
    commitEditor();
    closeDropdown();
    show(q('#save-group'), false);
    if (options.draftCommandDead) return;
    const typed = String(q(`[id$="-FCAUSA-EDITOR"]`).value).trim();
    const id = String(nextDraftId++);
    drafts.push({ id, causa: options.draftStoresCausa ?? typed, receipts: gridModel('receipts'), details: gridModel('detail') });
    if (options.draftMarkTaken) drafts.push({ id: String(nextDraftId++), causa: typed, receipts: [], details: [] });
    // Spaced, as live 2026-10-13 read it after 暂存.
    if (!options.draftTabStays) q('.form-tab').textContent = '费用报销单 - 修改';
    mutate('draft', id);
  }
  for (const causa of options.draftsBefore ?? []) drafts.push({ id: String(nextDraftId++), causa, receipts: [], details: [] });
  // @unverified: ExecuteBillQuery on 费用报销单 filtered by FRecInv.FIVNUMBER answers one row per bill holding the number (S12 live, an audited bill; a 暂存 draft only through FRecInv.FBillNo) [unseen]
  function answerOccupancy(filter: string): unknown {
    if (options.occupancyQueryFails) return [[{ Result: { ResponseStatus: { IsSuccess: false, Errors: [{ Message: '元数据中标识为FRecInv的字段上的引用字段FIVNUMBER不存在' }] } } }]];
    const asked = [...filter.matchAll(/FRecInv\.FIVNUMBER = '(\d+)'/g)].map((m) => m[1]!);
    return asked.filter((no) => no in (options.heldInvoices ?? {})).map((no) => [options.heldInvoices![no] || ' ', options.heldInvoices![no] ? 'C' : 'Z', no]);
  }
  function answerDraftQuery(payload: { FilterString?: string }): unknown {
    if (String(payload.FilterString ?? '').includes('FRecInv.FIVNUMBER')) return answerOccupancy(String(payload.FilterString));
    const like = /FCausa like '%([^%']*)%'/.exec(String(payload.FilterString ?? ''));
    return drafts.filter((d) => like && d.causa.includes(like[1]!)).map((d) => [d.id, ' ', 'Z', d.causa]);
  }
  function answerView(requestBody: string): unknown {
    const id = JSON.parse(JSON.parse(requestBody).parameters[1]).Id;
    const draft = drafts.find((d) => d.id === String(id));
    if (!draft) return { Result: { ResponseStatus: { IsSuccess: false, Errors: [{ Message: '单据不存在' }] }, Result: null } };
    return { Result: { ResponseStatus: null, Result: { Id: Number(draft.id), BillNo: ' ', DocumentStatus: 'Z', FCausa: draft.causa, RecInvInfo: draft.receipts, ER_ExpenseReimbEntry: draft.details } } };
  }

  let deadNewFormClicks = 0;
  let lostNewRowClicks = 0;
  let pageLoads = 0;
  let fillEntryClicks = 0;
  let assistantOpens = 0;
  let lostLookupCommits = 0;
  let newRowCover: { tr: any; until: number } | null = null;
  const pendingLookups: Array<{ td: any; text: string; due: number }> = [];
  let slowLookupDone = false;
  let deadOpenListClicks = 0;
  async function clickMain(el: any) {
    const assistant = q('#assistant-window');
    if (visible(assistant) && !assistant.contains(el)) return; // the modal assistant swallows clicks
    // The loading overlay is up by the mouse-down even when the hit test before it found the target.
    if (blockerShown()) { swallowedClicks += 1; return; }
    if (dropdown) {
      const li = el.closest('ul.k-list li');
      if (li) return pickOption(String(li.textContent).trim());
      closeDropdown();
    }
    if (editor && editor.td.contains(el)) {
      // A second click into a cell whose control the ERP was still re-rendering hands over one that works:
      // measured live 2026-09-20 on 项目, where the click-and-type after a swallowed run landed the code.
      editor.swallow = false;
      editor.input.focus();
      return;
    }
    const action = el.closest('[data-action]')?.getAttribute('data-action');
    const td = el.closest('.kd-grid-panel[data-grid="detail"] td');
    if (td && !td.parentElement.classList.contains('k-footer-template')) return editCell(td);
    commitEditor();
    switch (action) {
      case 'system-menu':
        show(q('#system-menu .kd-site-accordion'), !(options.menuEmptyUntilReload && pageLoads === 0));
        return show(q('#system-menu'), true);
      case 'menu-parent': return toggleMenuRow(el.closest('li'));
      case 'menu-child': return selectMenuNode(main.document, el.getAttribute('data-node'));
      case 'open-list':
        if (deadOpenListClicks < (options.openListDeadClicks ?? 0)) { deadOpenListClicks += 1; return undefined; }
        show(q('#system-menu'), false);
        return show(q('#expense-list'), true);
      // @unverified: clicking 新增 reveals the form in the same document, where live adds a tab panel (recordings/new-form) [fake]
      case 'new-form':
        if (options.newFormClickDead) return undefined;
        if (deadNewFormClicks < (options.newFormDeadClicks ?? 0)) { deadNewFormClicks += 1; return undefined; }
        show(q('#expense-list'), false);
        show(q('#expense-form'), true);
        if (options.sectionOverlayTicks) {
          blockerUntil = mainTicks + options.sectionOverlayTicks;
          show(q('#form-blocker'), true);
          for (const anchor of main.document.querySelectorAll('[data-action="section"]')) anchor.setAttribute('data-covered-by', '#form-blocker');
        }
        formPanelActiveAt = mainTicks + (options.formPanelActiveTicks ?? 0);
        return syncFormPanel();
      case 'section': return undefined;
      // 不退出: ERP keeps the session, the prompt and its overlay go, and what they covered is reachable again.
      case 'stay-signed-in': {
        for (const covered of main.document.querySelectorAll(`[data-covered-by="${IDLE_COVER}"]`)) covered.removeAttribute('data-covered-by');
        return show(q('#idle-window'), false);
      }
      // 继续退出 really signs out. The prompt's two buttons sit side by side and read almost the same; a run that
      // answers with this one has lost the session it was given, and nothing after it can work.
      // @unverified: 继续退出 on the idle prompt signs the session out [transient]
      case 'sign-out': {
        show(q('#idle-window'), false);
        show(q('.kd-mainconsole-shortcuts'), false);
        show(q('#expense-list'), false);
        return undefined;
      }
      case 'split-arrow':
        for (const item of main.document.querySelectorAll('a.kdmenuitem[data-mode]')) show(item, true);
        return undefined;
      case 'fill-entry': {
        fillEntryClicks += 1;
        for (const item of main.document.querySelectorAll('a.kdmenuitem[data-mode]')) show(item, false);
        if (fillEntryClicks <= (options.notFillEntryClicksLost ?? 0)) return undefined;
        importMode = el.closest('[data-mode]').getAttribute('data-mode');
        return openAssistant();
      }
      case 'new-row': {
        if (lostNewRowClicks < (options.newRowClicksLost ?? 0)) { lostNewRowClicks += 1; swallowedClicks += 1; return undefined; }
        // ERP paints the new row in its own re-render, which is not the click's own turn of the event loop.
        const delay = options.newRowAppearsAfterTicks ?? 0;
        if (delay > 0) { pendingNewRow = mainTicks + delay; return undefined; }
        return insertDetailRow();
      }
      case 'save': return save();
      case 'save-temp': return saveDraft();
      case 'close-window': {
        const win = el.closest('.k-window');
        // A 处理结果 whose 退出 does nothing: the click lands, the window stays, and everything under it is
        // unreachable from then on.
        if (options.importReportStaysOpen && win.id === 'result-window') return undefined;
        if (options.assistantBlankWontClose && win.id === 'assistant-window' && !child) return undefined;
        return show(win, false);
      }
      default:
        if (el.matches('input') && String(el.id).endsWith('-EDITOR') && !el.readOnly) el.focus();
        return undefined;
    }
  }

  function clickAssistant(el: any) {
    if (!child) return;
    // The 票种 tab strip. Switching hides one pane and shows another; it touches no checkbox, which is why a tick
    // survives a switch (measured live 2026-09-19: 4/10 ticked, switch away, switch back, still 4/10).
    const tab = el.closest?.('.ant-tabs-tab');
    if (tab) {
      if (!options.assistantPaneSwitchDead) showPane(String(tab.getAttribute('data-pane')));
      return;
    }
    if (el.matches('input.ant-checkbox-input')) {
      if (el.closest('thead')) return; // the header 全选 is on the never-click list; the fake refuses it too
      const number = assistantKeyOf(el.closest('tr'));
      if ((options.assistantDeadTickNumbers ?? []).includes(number)) return;
      el.checked = !el.checked;
      return;
    }
    const doc = child.doc.document;
    const action = el.closest('[data-action]')?.getAttribute('data-action');
    // 电脑端选取 leaves the entry menu for the upload view; that is where the file input and the grid live.
    if (action === 'computer-picker' && !options.assistantStuckOnEntryMenu) {
      show(doc.querySelector('.fpzsHome'), false);
      show(doc.querySelector('#assistant-upload'), true);
    }
    if (action === 'notice-ok') {
      for (const covered of doc.querySelectorAll(`[data-covered-by="${ASSISTANT_NOTICE}"]`)) covered.removeAttribute('data-covered-by');
      show(doc.querySelector('#assistant-notice'), false);
    }
    // 发票导入单据 imports in the mode already chosen on the ERP's split-button menu. It asks nothing further:
    // measured live 2026-09-19, no 是否生成费用明细 dialog exists on this path, in the iframe or anywhere else.
    if (action === 'import') importInvoices();
  }

  function key(doc: FakeDocument, params: Record<string, any>) {
    const active = doc.document.activeElement;
    if (params.type === 'rawKeyDown' && Array.isArray(params.commands) && params.commands.includes('selectAll')) {
      // Measured live 2026-09-20 on the 开始日期 editor: select-all leaves the caret where it was
      // (`selectionStart == selectionEnd == 9`) however it is dispatched — `rawKeyDown` or `keyDown`, with the
      // `selectAll` command or a bare Meta+A. The next keystroke then APPENDS. Only this control ignores it:
      // the 费用金额 editor opens with its value already selected, and the 事由 cell went 2..2 -> 0..2.
      if (!(active && active.getAttribute && active.getAttribute('data-role') === 'datepicker')) doc.selectAllOn = active;
      return;
    }
    if (params.type === 'keyDown' && typeof params.text === 'string') {
      if (active && /^(INPUT|TEXTAREA)$/.test(active.tagName)) {
        lastTypedAt = mainTicks;
        // The control the ERP is still re-rendering is not the one on the page; the character goes nowhere.
        if (editor && editor.input === active && editor.swallow) return;
        if (doc.selectAllOn === active) { active.value = params.text; doc.selectAllOn = null; }
        else {
          const at = caretOf(active);
          active.value = String(active.value).slice(0, at) + params.text + String(active.value).slice(at);
        }
        setCaret(active, caretOf(active));
      }
      return;
    }
    if (params.type !== 'rawKeyDown' || doc !== main) return;
    // Backspace is the only clearing this datepicker answers to: live, 14 of them emptied it and the typed date
    // then committed faithfully on both Enter and Tab.
    if (params.key === 'Backspace' || params.key === 'Delete') {
      if (active && /^(INPUT|TEXTAREA)$/.test(active.tagName)) {
        const value = String(active.value);
        const at = caretOf(active);
        if (doc.selectAllOn === active) { active.value = ''; doc.selectAllOn = null; setCaret(active, 0); }
        else if (params.key === 'Backspace') {
          // Only what is left of the caret, which is the whole defect.
          if (at > 0) { active.value = value.slice(0, at - 1) + value.slice(at); setCaret(active, at - 1); }
        } else if (at < value.length) { active.value = value.slice(0, at) + value.slice(at + 1); setCaret(active, at); }
      }
      return;
    }
    if (params.key === 'Enter' || params.key === 'Tab') {
      if (editor && active === editor.input) {
        const keepOpen = options.taxEditorRemainsOpen && params.key === 'Enter' && editor.column === '税额';
        const td = editor.td;
        commitEditor();
        if (keepOpen) editCell(td);
        return;
      }
      if (active && String(active.id).endsWith('-EDITOR')) { active.blur(); mutate('header', `${String(active.id).split('-').slice(-2, -1)[0]}=${active.value}`); }
      return;
    }
    if (params.key === 'Escape') closeDropdown();
  }

  const assistantKeyOf = (tr: any) =>
    String(tr?.children?.[ASSISTANT_COLUMNS.indexOf('发票号码')]?.textContent ?? '').trim();

  /** The `<tbody>` of one 票种 pane, and its tab, created on first sight of that 票种. */
  function paneOf(label: string) {
    const doc = child!.doc.document;
    const existing = doc.querySelector(`tbody[data-pane="${label}"]`);
    if (existing) return existing;
    const tbody = doc.createElement('tbody');
    tbody.setAttribute('data-pane', label);
    doc.querySelector('.ant-table').appendChild(tbody);
    const tab = doc.createElement('div');
    tab.className = 'ant-tabs-tab';
    tab.setAttribute('data-pane', label);
    doc.querySelector('#assistant-tabs').appendChild(tab);
    // The first 票种 to arrive is the one the grid opens on; later ones start hidden.
    showPane(doc.querySelectorAll('tbody[data-pane]').length === 1 ? label : activePane);
    return tbody;
  }

  function showPane(label: string | null) {
    activePane = label;
    const doc = child!.doc.document;
    for (const tbody of doc.querySelectorAll('tbody[data-pane]')) show(tbody, tbody.getAttribute('data-pane') === label);
    for (const tab of doc.querySelectorAll('.ant-tabs-tab')) {
      tab.className = tab.getAttribute('data-pane') === label ? 'ant-tabs-tab-active ant-tabs-tab' : ' ant-tabs-tab';
    }
  }

  /** Tab captions (`<票种> <count>`) and the 已选取N张发票 footer, which counts UPLOADS and never ticks. */
  function refreshAssistant() {
    const doc = child!.doc.document;
    let uploaded = 0;
    for (const tbody of doc.querySelectorAll('tbody[data-pane]')) {
      const label = tbody.getAttribute('data-pane');
      const count = tbody.querySelectorAll('tr').length;
      uploaded += count;
      doc.querySelector(`.ant-tabs-tab[data-pane="${label}"]`).textContent = `${label} ${count}`;
    }
    doc.querySelector('#assistant-selected').textContent = `已选取${uploaded}张发票 所有已选发票已选0份附件`;
  }

  // @unverified: the assistant recognises an upload by its bytes and groups rows into one pane per 票种 [upload]
  function recognise(files: Uint8Array[]) {
    if (!child) return;
    const doc = child.doc.document;
    for (const bytes of files) {
      const hash = sha256(bytes);
      const invoice = invoicesBySha.get(hash);
      if (!invoice || doc.querySelector(`tr[data-sha256="${hash}"]`)) continue; // unknown files are not recognised; duplicates dedupe by number
      // 票种 is what the grid groups by, so the fake groups by the invoice's own 发票类别.
      const tbody = paneOf(invoice.category);
      const tr = doc.createElement('tr');
      tr.setAttribute('data-sha256', hash);
      tr.innerHTML = ASSISTANT_COLUMNS.map((column) => {
        switch (column) {
          case '': return '<td><input type="checkbox" class="ant-checkbox-input"></td>';
          case '销方名称': return `<td>${escapeHtml(invoice.seller)}</td>`;
          case '发票号码': return `<td>${escapeHtml(invoice.invoiceNumber)}</td>`;
          case '价税合计': return `<td>${escapeHtml(invoice.gross)}</td>`;
          case '税额': return `<td>${escapeHtml(invoice.tax)}</td>`;
          case '开票日期': return `<td>${escapeHtml(invoice.issueDate)}</td>`;
          default: return '<td></td>';
        }
      }).join('');
      tbody.appendChild(tr);
      // Each row sits one row-height further down a page taller than the viewport: the later ones are unreachable
      // until something scrolls them in.
      const input = tr.querySelector('input.ant-checkbox-input');
      input.setAttribute('data-below-fold', String(ASSISTANT_ROW_TOP + (tbody.querySelectorAll('tr').length - 1) * ASSISTANT_ROW_STEP));
      if ((options.assistantCoveredTickNumbers ?? []).includes(invoice.invoiceNumber)) input.setAttribute('data-covered-by', '#assistant-overlay');
    }
    refreshAssistant();
  }

  /** The momentary cover over 发票类型: on for the first few reads of each row, then gone. */
  function syncOptionCover() {
    if (!options.invoiceTypeCoverTicks) return;
    const covered = optionCoverUntil !== null && mainTicks < optionCoverUntil;
    for (const tr of dataRows('detail')) {
      const td = cellOf(tr, 'detail', '发票类型');
      if (covered) td.setAttribute('data-covered-by', '#form-blocker');
      else td.removeAttribute('data-covered-by');
    }
  }

  /** The cover over the dropdown's own items: on for the first few reads of a freshly opened list, then gone. */
  function syncOptionItemCover() {
    if (!options.optionItemCoverTicks || !dropdown) return;
    const covered = optionItemCoverUntil !== null && mainTicks < optionItemCoverUntil;
    for (const li of dropdown.list.querySelectorAll('li')) {
      if (covered) li.setAttribute('data-covered-by', '#form-blocker');
      else li.removeAttribute('data-covered-by');
    }
  }

  /** The form's blocking overlay coming down once it has finished opening, a few reads after 新增. */
  function clearBlocker() {
    if (blockerUntil === null || mainTicks < blockerUntil) return;
    show(q('#form-blocker'), false);
    for (const anchor of main.document.querySelectorAll('[data-action="section"]')) anchor.removeAttribute('data-covered-by');
    blockerUntil = null;
  }

  /** Kendo moving `k-state-active` from the console's tab panel onto the newly opened form's, a few reads late. */
  function syncFormPanel() {
    if (formPanelActiveAt === null || mainTicks < formPanelActiveAt) return;
    q('#console-panel').classList.remove('k-state-active');
    q('#form-panel').classList.add('k-state-active');
    formPanelActiveAt = null;
  }

  /** Recognition that has not landed yet, because `assistantRecognitionTicks` holds this batch back. */
  function flushRecognition() {
    while (pendingRecognition.length && pendingRecognition[0]!.due <= assistantTicks) recognise(pendingRecognition.shift()!.files);
  }

  /** The announcement, back over the grid it covers live once the rows it hides are actually there. */
  function raiseAssistantNotice() {
    if (!child) return;
    const doc = child.doc.document;
    const notice: any = doc.querySelector('#assistant-notice');
    if (!notice) return;
    notice.style.display = '';
    // The checkboxes are what the live modal covered, and what the run must reach next.
    for (const box of doc.querySelectorAll('input.ant-checkbox-input')) box.setAttribute('data-covered-by', ASSISTANT_NOTICE);
  }

  /** One upload batch reaching the assistant. */
  function setFiles(files: Uint8Array[]) {
    if (!child) return;
    const delay = options.assistantRecognitionTicks ?? 0;
    if (delay > 0 && uploadBatches > 0) pendingRecognition.push({ due: assistantTicks + delay, files });
    else recognise(files);
    uploadBatches += 1;
    if (options.noticeReturnsAfterUpload) raiseAssistantNotice();
  }

  const session: CdpSession = {
    async send(method, params = {}, { sessionId = null } = {}) {
      commands.push({ method, params, sessionId });
      if (sessionId && (!child || sessionId !== child.sessionId)) throw new Error(`No session with given id: ${sessionId}`);
      if (!sessionId && !targetAlive) throw new Error('CDP 连接已关闭');
      const doc = sessionId ? child!.doc : main;
      if (sessionId) { assistantTicks += 1; flushRecognition(); }
      else { mainTicks += 1; if (!blockerShown()) show(q('#console-blocker'), false); syncFormPanel(); clearBlocker(); syncOptionCover(); paintReport(); flushNewRow(); uncoverNewRow(); flushLookups(); flushMoneyModel(); flushEditClass(); syncOptionItemCover(); }
      switch (method) {
        case 'Runtime.evaluate': return doc.evaluate(String(params.expression));
        case 'Input.dispatchMouseEvent':
          // Kendo opens the 保存 split button's group on mouse-over of its arrow.
          if (params.type === 'mouseMoved' && doc === main && !recorded) {
            if (doc.elementAt(Number(params.x), Number(params.y))?.closest('[data-action="save-arrow"]')) show(q('#save-group'), true);
          }
          if (params.type === 'mousePressed') {
            const el = doc.elementAt(Number(params.x), Number(params.y));
            if (el) { if (recorded) await replayClick(doc, el); else if (doc === main) await clickMain(el); else clickAssistant(el); }
          }
          return {};
        case 'Input.dispatchKeyEvent': if (!recorded) key(doc, params); return {};
        case 'Target.setAutoAttach':
          // Children that are already there are announced too, as Chromium does.
          if (!autoAttach && recorded) announceChild();
          autoAttach = true;
          return {};
        case 'DOM.getDocument': return { root: { nodeId: 1 } };
        case 'DOM.querySelector': return { nodeId: doc.document.querySelector(params.selector) ? 2 : 0 };
        case 'DOM.setFileInputFiles': setFiles((params.files as string[]).map((path) => readFileSync(path))); return {};
        // Loading the entry page again ends the session: live 2026-10-21 it came back to the login form.
        // @unverified: loading the entry page again signs the session out [transient]
        case 'Page.navigate':
          if (doc === main && !recorded) { pageLoads += 1; loggedIn = false; main = await render(); }
          return { frameId: 'main' };
        case 'Page.captureScreenshot': return { data: Buffer.from(`fake-screenshot ${JSON.stringify(params.clip ?? null)}`).toString('base64') };
        default: return {};
      }
    },
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method)!.add(listener);
      return () => listeners.get(method)?.delete(listener);
    },
    close() {},
  };

  const page: ChromiumPage = {
    transport: 'default', automation: 'cdp', browserFamily: 'chromium', tabId: 'erp-page-1', index: null,
    url, title: '金蝶云星空', active: false, origin, pageId: 'erp-page-1', cdpPort: 9333,
    cdpTargetId: 'erp-page-1', cdpUrl: 'ws://127.0.0.1:9333/devtools/page/erp-page-1',
  };

  return {
    session, mutations, commands, hooks,
    get document() { return main.document; },
    /** The name of the recorded page on screen, when serving a recording. */
    get recordedPage() { return recordedPage()?.name ?? null; },
    /** Which 选择发票 menu item the clicks actually landed on, null until one of them is clicked. */
    get importMode() { return importMode; },
    /** Clicks on a 选择发票 menu item, landed or lost (`notFillEntryClicksLost`). */
    get fillEntryClicks() { return fillEntryClicks; },
    /** Times the assistant's window was opened, blank ones included (`assistantBlankOpens`). */
    get assistantOpens() { return assistantOpens; },
    /** Times the page was loaded again (`Page.navigate`). */
    get pageLoads() { return pageLoads; },
    /** Clicks the loading overlay took (`consoleBlockerTicks`, `newRowClicksLost`). */
    get swallowedClicks() { return swallowedClicks; },
    /** The 发票助手's own document while it is open — its 票种 panes, their rows and their ticks. */
    get assistantDocument() { return child?.doc.document ?? null; },
    browser: {
      listPages: async () => (targetAlive ? [page] : []),
      attach: async (candidate: ChromiumPage) => ({ ...candidate, automation: 'cdp' as const, session }),
    },
    /** The user logs in on the same page (same URL, new DOM). */
    async login() { loggedIn = true; main = await render(); },
    /**
     * The employee clicks 保存 (save) themselves. baox never does (ADR-0028), so this is the only way a fake ERP
     * reaches 已保存 — exactly as it happens in production, by a human at the keyboard.
     */
    employeeSaves() { save(); },
    /** Drift: ERP re-renders the form under a new form-instance UUID. */
    replaceFormInstance() {
      const next = 'f0e1d2c3b4a5';
      for (const el of main.document.querySelectorAll(`[id^="${formUuid}-"]`)) el.id = el.id.replace(formUuid, next);
      formUuid = next;
    },
    /** Drift: the CDP target goes away. */
    closeTarget() { targetAlive = false; },
  };
}
