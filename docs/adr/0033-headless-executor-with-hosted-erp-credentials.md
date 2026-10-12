# 去报销 runs in a headless browser on the server, logged in with hosted ERP credentials, and ends at a 暂存 draft

**Status: proposed (2026-10-11).** Accepted once the spike in
[erp-headless-v1.md](../design/erp-headless-v1.md#验证计划) passes. Until then the browser extension (ADR-0019, ADR-0021)
remains the shipped path. On acceptance this ADR supersedes, for the default path, ADR-0019's "the ERP session never
leaves the user's machine" and ERP authorisation by the employee's own login, and ADR-0028's "baox never clicks 保存".
It implements the 暂存 half of ADR-0029, not its delete gateway.

**Amended 2026-10-12 (owner): the executor runs on the employee's own PC, not on the server.** `10.250.0.222` only
hosts the server and never drives ERP. Whether the browser on the PC is headless, a dedicated headed one, or the
extension in the employee's own Chrome is chosen by measurement: whichever is more stable and faster. The browser keeps
a persistent profile, so Kingdee's console scripts stay cached (the spike found that a cold cache over a slow link
trips RequireJS's 30 s limit; see the design's S2 result). Until this ADR is rewritten after that comparison, read
"the server" and "the host" below as "the employee's PC" for where the browser runs; the capacity section (host
memory, two concurrent jobs, a queue) no longer applies. Open: today only the extension runs on a PC and it cannot
start a process, so a dedicated or headless browser needs a new local component on every PC; and where the ERP
credentials are kept once the login happens on the PC.

**Amended 2026-10-12 (owner): S8 chose headless.** On the Mac mini, with one real invoice up to the 发票导入单据
click, headless passed 10/13 and reached it in about 30 s; the dedicated headed browser passed 1/3 and the extension
2/3, both in about 42 s (the design's S8 result). Headless is also invisible to the employee, who therefore cannot
click into a run. Its failures — the 新增单 not opening right after login, and (seen on the extension) the login probe
giving up early — are executor bugs, not properties of headless, and are fixed on line 2.

The extension path works end to end but is not stable enough: runs most often stop for 转人工 on an exception. About
half of the instability the 2026-10-11 audit found comes from running in the employee's visible browser:
- the employee switches, minimises or occludes the tab and clicks are silently dropped (V-53);
- the employee types or clicks mid-fill;
- the debugger banner's Cancel button ends the run;
- the MV3 service worker is killed or the laptop sleeps;
- the employee's own network drops.

None of these exists when the browser is baox's own headless Chromium on the server. The owner chose that, with
hosted credentials, over hardening the extension further.

## Decisions

- **One path in v1: headless.** The server runs the existing `erp-executor` in a headless Chromium on the intranet
  host. The extension path stays in the code but is not offered. Making the path a per-account setting is later work.
- **ERP 凭据 are hosted.**
  - The employee saves their ERP account and password once, in their app account's settings.
  - The password is encrypted at rest with a key that lives only on the server.
  - The field is write-only and the employee can clear it at any time.
  - The credentials are used only for 去报销 and 对账.
  - Saving them triggers a trial login. A login the ERP refuses disables the credentials at once, and baox never
    retries a refused login, so it cannot lock the ERP account.
- **Sessions.**
  - baox logs in at the start of each job and logs out at the end.
  - Logging in may knock the same ERP account's existing session off. The owner accepted this on 2026-10-11, and the
    UI says so before 去报销.
  - An employee who logs in to ERP mid-job knocks baox off. The executor treats that as a lost session: before
    暂存 it is an 自动重新去报销 (ADR-0034), after it a 对账.
- **Hand-over is a 暂存 draft.**
  - The run imports, fills, strictly reads back, and clicks 暂存. The terminal state is **ERP 草稿已交接**: the
    draft has a 单据编号, and the employee opens it, checks it, and submits it.
  - 事由 carries ADR-0029's ownership marker so a draft can be found again.
  - baox never deletes drafts in v1.
- **Two read-backs.**
  - Fill stays on the page, using `Input.dispatch*` as today, because WebAPI writes were never measured (V-60).
  - Read-back is checked twice, and both must agree with the plan:
    - the existing DOM read-back;
    - the bill's model, read with WebAPI `View` after 暂存. This closes V-49, where the screen shows a value the
      model lacks.
- **Capacity.**
  - At most two headless jobs run at once on the host (14 GiB, about 7 GiB already used by other services).
  - Further jobs queue first-come first-served, and the page shows the position.
  - Chromium is installed through native bootstrap, like the other native prerequisites.
- **What carries over unchanged.**
  - ADR-0016's protocol and durable attempts.
  - ADR-0025's import seam.
  - Server-side judgement.
  - The per-account `ERP 自动化控制权`, now held by the server-side executor instead of a paired extension.

## Considered Options

- **Harden the extension and stay headed.** Rejected as the main path. The audit's executor-level fixes are done
  anyway (they serve both paths), but the class of human, focus and service-worker failures cannot be removed from a
  browser the employee also uses.
- **The old dedicated headed Chromium (ADR-0016 v1).** Rejected: it is still a window the OS can occlude. V-53 is that
  path's failure.
- **WebAPI `Save` for the whole bill.** Deferred. It would drop the DOM entirely, but write signatures are unmeasured.
  It also cannot replace the piaozone invoice assistant, through which invoices are imported.

## Consequences

- baox now holds a credential that can act as the employee in ERP. The ERP speaks plain HTTP (exploration §130), so
  the host must stay on the controlled intranet.
- 去报销 no longer needs the employee's machine to be on, awake or connected. The extension's reconnection rules
  (ADR-0020) do not apply to the default path.
- Every successful run leaves a draft in ERP, so the live test suite needs a test account whose drafts the
  maintainer deletes.
