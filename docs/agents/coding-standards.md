# Coding standards

The rules a change is reviewed against. The `/code-review` Standards axis reads this file; cite a rule by its heading.

## Every QA-bug fix ships a regression test

A QA bug is one the maintainer reported from manual QA (手动 QA) on a running build. Its fix includes a test that goes
_red_ on the bug without the fix and green with it, at one of the four levels below. Pick the level by the bug class; a
bug that spans two classes gets the test at the level that owns the rule the fix changed.

A fix with no such test is a hard violation. So is a test at a level that cannot see the bug (a recognition misread
tested only through the scenario builder, an ERP page bug tested only against a scripted executor).

| Bug class | Level | Where the test goes |
|---|---|---|
| A task in the wrong stage or step, stuck, a button or action offered or refused wrongly, a write admitted or refused wrongly | taskPolicy table | a row in `server/src/task-policy.test.ts` |
| Wrong behaviour of a task action across the server: what an action stores, returns or leaves behind, given a task at some stage (including a scripted ERP outcome) | Scenario builder | a server test starting from `scenario(server).at(<stage>, …)` |
| An invoice or other reimbursement material (报销材料) read wrong: a field missing or wrong, the wrong layout, the wrong outcome | Recognition snapshot case | `server/src/parse/snapshots/<case>.doc.json` + `<case>.expected.json` |
| The ERP executor wrong on an ERP page: a selector, a page flow, a field written or read back wrong | Recorded-ERP executor test | an `erp-executor/src/*.test.ts` test against `createFakeErp` |

### taskPolicy table

`taskPolicy(facts, erp)` (`server/src/task-policy.ts`) is the one owner of stage, step, blockers, `allowedActions` and
`admit`. Reproduce the bug as hand-built `TaskFacts` in the matching `it.each` table: the row names the situation and
the expected stage/step, allowed actions or admission result. No server, database or browser.

### Scenario builder

`scenarioServer()` and `scenario(server).at(stage, { materials, erp, projects, stayTrio, … })`
(`server/src/test/scenario.ts`; its header lists the ladder and options) put a task at a stage through public HTTP
actions, with preset parse outcomes and a scripted ERP executor. Assert through the returned scene: `snapshot()`,
`accept`, `refused`, `run`. Stages the ladder cannot reach (`catalog`, `preparation`, `voided`) start from the nearest
reachable one plus `run(<action>)`.

### Recognition snapshot case

Capture the document the material produced, redacted, as a case in `server/src/parse/snapshots/`, and write its
expectation by hand; its `about` names the issue. `server/src/parse/snapshots.test.ts` runs every case with no pdfjs
and no OCR. The capture command, the redaction rules and how to write the expectation are in
`docs/agents/private-corpus.md`.

### Recorded-ERP executor test

Drive the executor step against the fake ERP (`erp-executor/src/testing/fake-erp.ts`). When the bug is on a page a
recording covers, use `createFakeErp({ recording: '<name>' })` so the test runs on the live page's DOM
(`erp-executor/src/recorded-erp.test.ts`). When no recording covers it, record one with a flow in
`erp-executor/src/recording/flows.ts` and `pnpm --filter @baox/erp-executor probe <flow> --record <name>`; this needs
the maintainer's live ERP session, so ask for it. Until then, a hand-written fake behaviour carries an `@unverified:`
marker and `erp-executor/src/unverified.test.ts` counts it. A fix that adds a marker raises `UNVERIFIED_CEILING` in
the same change and says why in its commit message.
