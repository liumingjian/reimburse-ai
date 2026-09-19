# 收票占用 is not terminal, and 「删除发票」 comes off the never-click list

The corpus treated an imported invoice as spent for good. That framing drove the "一票一次干净机会"
rule, the three preconditions guarding the live sample, and — most expensively — ADR-0024's decision to
route the `未保存·已导入未写明细` breakpoint to 转人工 as a terminal state with no recovery.

A user instruction on 2026-09-19 ("直接解禁删除发票，该做的实验最好提前做，把问题调查清楚再决策和行动")
sent us to look for the deletion experiment. The investigation found the answer was already in the corpus,
and it is not the one the framing assumed.

Decided in a grilling round on 2026-09-19. No issue was opened: a round ends with a consensus summary, and
only a user-invoked `/to-spec` turns that into a spec.

## The evidence already on file

`docs/research/erp-expense-flow/save-contract.md:621`, from the 2026-09-11 end-to-end run that pinned ERP
behaviour over eighteen attempts:

> **重开助手可以**：同一页面实例里导入真票之后放弃单据、换新单再开助手，照常加载并能再次导入。

and `:618`, describing what the re-import produced:

> 摘要形如「全部执行成功：4」，逐票写「已存在对应的收票单…已进行覆盖」。

Invoices that had already been imported into a bill, which was then abandoned unsaved, were imported again
into a fresh bill. The ERP overwrote the existing 收票单 and reported every one of the four as successful.
**No deletion. No unbind.** That is precisely the shape of the `未保存·已导入未写明细` breakpoint.

## The three states are not one state

Reading the corpus with that distinction, the contradictions dissolve. 收票占用 behaves differently
depending on what the invoice is bound to:

| The invoice is bound to | Re-import | Evidence |
| --- | --- | --- |
| A bill we abandoned unsaved | **Succeeds, by overwrite** | `save-contract.md:618,621` (2026-09-11, 18 rounds) |
| A 历史费用报销单 | **Refused** — `重复报销，禁止导入`, 收票表 stays at 0 rows; the ERP offers 申请解绑 | `reference-material-verification.md:25,81`; `save-contract.md:437-441` |
| A saved draft | **Unknown** | nothing on file |

The earlier reading collapsed rows one and two into "an imported invoice is spent", took the refusal as the
general case, and generalised from the wrong row.

## Decisions

- **收票占用 is not terminal for invoices bound to a bill we abandoned unsaved.** Re-import overwrites.
  `CONTEXT.md`'s 收票占用 entry is corrected accordingly.
- **ADR-0024's `未保存·已导入未写明细` disposition must be revisited.** It was set to 转人工 as a terminal
  state on the premise that the invoice was gone. The premise is false for the case that breakpoint
  describes: the bill was, by definition, not saved. Whether the recovery should be automatic is a separate
  question — it means re-running an import, which ADR-0016's replay prohibition exists to prevent — but
  "there is no way back" is no longer a reason.
- **「删除发票」 comes off the never-click list, for human use only.** It acts on a 收票 row this session
  just imported, not on a pre-existing external record, so it does not collide with the rule it was filed
  under. 「申请解绑」 stays forbidden — it goes through an approval flow and acts on records that are not
  ours. 提交, 审核, 下推, 付款 and deleting a 单据 are unchanged.
- **Unbanned is not verified.** Whether deleting a 收票 row returns the invoice to the 发票无忧 pool has
  **never been observed**: the verification ledger records no deletion of any kind, and every live round
  ends with "本次没有提交、审核、付款、解绑或删除". The automation path must not call it until it is.
  Note also that the release would have to cross a system boundary — the 收票 row is ERP-side, the pool is
  the third-party `piaozone.com` — and 申请解绑 sits exactly on that boundary.
- **The remaining experiment is the saved-draft cell, and it costs nothing.** Draft `FYBX20260911000011`
  already exists with four already-spent invoices. Deleting it by hand and re-checking those four settles
  the row that is still blank, without consuming anything new. This supersedes any plan to spend the
  曹操出行 sample on a deletion test.
- **A read-only toolbar probe comes first.** No code anywhere in the repo clicks a 删除 control on the
  receipt grid, and `steps.ts` knows only `tbReceiveInv`, `tbNotFillEntry` and `tbNewList`. Before any
  deletion is attempted, enumerate what the 收票信息 toolbar actually exposes on a fresh 新增单 — that
  reads the DOM, imports nothing, saves nothing and consumes nothing.

## Consequences

The "non-renewable sample" framing, already downgraded by ADR-0025 (consumption starts at the import click,
not at upload), loses most of what remained. Upload and recognition are free; import is reversible by
overwrite for the abandoned-bill case; only the historical-bill case is a hard stop, and that one was never
ours to spend.

What does not change: baox still never deletes a 单据, never requests an unbind, and never replays an import
of its own accord. Those rules stand on ADR-0016's replay discipline, which is about not acting twice on the
user's behalf — an argument that never depended on the invoice being irrecoverable.
