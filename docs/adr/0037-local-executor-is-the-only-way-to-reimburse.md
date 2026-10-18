# The 本地执行器 is the only way to 去报销; the 浏览器扩展 is gone

**Status: accepted (2026-10-18).** Decided with the owner after the manual QA of
[#412](https://github.com/liumingjian/reimburse-ai/issues/412). It accepts
[ADR-0033](0033-headless-executor-with-hosted-erp-credentials.md), whose "until then the browser extension remains the
shipped path" it replaces. It supersedes [ADR-0019](0019-per-account-erp-control-and-extension-pairing.md)'s extension
parts (the extension itself, its download and the page bridge), [ADR-0021](0021-hybrid-fill-technique-and-unpacked-distribution.md),
and [ADR-0028](0028-baox-fills-the-form-the-employee-saves-it.md)'s attended hand-over, in which baox stops at a filled,
unsaved form and the employee clicks 保存. ADR-0019's one-time 配对码 and per-account ERP control stay, now between an
应用账号 and its 本地执行器.

Since 2026-10-16 an account could 去报销 two ways (ADR-0033's amendment): the 浏览器扩展, attended, ending at a filled
unsaved form after 「我已登录，继续」; or the 本地执行器, unattended, signing in with the hosted ERP 凭据 and ending at 暂存.
Two ways meant two step lists, two endings, two login flows, a 设置页 choice, an extension e2e suite and a deploy step
that packages the extension, while the extension path was the one that stopped most often for 转人工. We keep one.

## Decisions

- **One way.** An 应用账号 can 去报销 only with a paired 本地执行器. Without one, 去报销 is refused, and the refusal points
  to the 设置页 to install it. Nothing falls back to an attended route.
- **One ending.** Every 去报销 ends at 暂存: ERP 草稿已交接 (the draft half of
  [ADR-0029](0029-baox-drafts-the-bill-and-may-delete-its-own-drafts.md)). Nothing reaches ERP 单据已交接 any more. The
  development CDP executor, e2e, the scripted fake executors and the scenario tests also sign in with hosted ERP 凭据
  and 暂存, so what the tests prove is the production path. 「我已登录，继续」 goes with the attended route.
- **Deleted, not hidden.** The extension package, its download and packaging, the 设置页's extension section and
  tutorial, the page bridge, and the per-route step lists with the route recorded on each ERP job. What the 本地执行器
  shares with the extension (the channel client, the job link of
  [ADR-0020](0020-reconnection-restores-the-channel-not-the-page.md), fetching originals, pairing) moves to a package
  of its own, and the contract's `EXTENSION_*` names are renamed by what they do. The pairing table becomes `pairing`,
  with no holder.
- **No compatibility (test stage).** baox is still in its test stage, so nothing is carried forward: a migration
  deletes extension pairings without notice, an extension still installed somewhere simply fails to connect, and no
  historical route is kept for old jobs. See also [ADR-0038](0038-legacy-import-removed-test-stage-data-not-kept.md).
- **Rollout.** The removal may merge before the 本地执行器 has passed on real PCs. Deploying it to 222 waits for the
  real-machine checks of [#430](https://github.com/liumingjian/reimburse-ai/issues/430), Windows above all.

## Considered Options

- **Keep the extension as a fallback** for PCs that cannot install the 本地执行器 (locked-down rights, antivirus).
  Rejected: such an employee enters the bill by hand from baox's 明细 and 打印单, and one maintained path is worth more
  than a second one few would use. When the install fails, the 设置页 says why.
- **Keep ERP 单据已交接 as a development and test ending.** Rejected: tests that end where production never does
  prove nothing about production.

## Consequences

- An employee whose PC refuses the install has no automated 去报销.
- 去报销 needs the account's ERP 凭据 saved on the 设置页 before the first run, in development too.
