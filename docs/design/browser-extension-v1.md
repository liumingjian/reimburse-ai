# Browser-extension V1: consensus

Outcome of a grilling round held 2026-09-20/21, on top of ADR-0019 through ADR-0022 and the
V1 scope statement archived in `docs/research/erp-expense-flow/issue-archive-223-234.md` (#227).

This is a consensus record, not a spec and not a backlog. It is the input a `/to-spec` run turns
into a spec. Where it contradicts an ADR, the contradiction is named explicitly below.

## Goal

Any approved 应用账号 (app account) in the company runs 去报销 (fill ERP) from a browser
extension in their own Chrome or Edge. baox fills the 费用报销单 and passes 严格回读 (strict
read-back); the employee clicks 保存 themselves (ADR-0028).

"Anyone" means any approved app account on one shared instance at one company. Administrator
approval (ADR-0018) stays: once the service is reachable over the network, open registration
would let strangers upload invoices and burn 发票占用 (invoice occupancy).

## Prerequisites

- PR #244 is merged (`b375732`, 2026-09-21). The page steps the extension reuses — the
  assistant's two views, settling before clicking 电脑端选取, the 76x0 anchor, the upload/import
  split, 重新去报销 closing the unsaved 新增 — are on main.
- #228 (remove the unconditional `baox admin reset-password`) lands first. It blocks binding the
  service to anything other than 127.0.0.1.

## Step 0: the spike, before any architecture change

A throwaway unpacked extension, run by the maintainer against the live ERP, verifying two things:

1. `chrome.debugger` can reach the piaozone 发票无忧助手 cross-origin iframe;
2. assigning a `DataTransfer` built in `Runtime.evaluate` to the hidden `multiple` file input
   triggers recognition.

The run stops before the 发票导入单据 click — this is the 排练 (rehearsal) of #230, it consumes no
invoices and leaves nothing to clean up. Findings go to `docs/research/`. Only after it passes is
ADR-0021 amended. If (2) fails, reopen the round: option B of ADR-0021 uses the same `DataTransfer`
mechanism and would fail with it.

## Architecture: the executor moves into the extension

`chrome.debugger.sendCommand` is CDP, and `server/src/erp/executor/` already speaks CDP, including
a child session for the piaozone iframe. So the extension swaps the transport, not the page logic.

- New package `erp-executor/`: the current executor plus `protocol.ts`. ADR-0016 anticipated this
  ("a root package once the V2 extension becomes its second consumer").
- New package `extension/`: the `chrome.debugger` adapter, the WebSocket client, pairing and popup.
  The adapter implements the existing `CdpSession` interface, so the stateful jsdom fake ERP keeps
  covering every step; only the adapter and the shell need a real browser.
- `server` keeps the CDP adapter for development and tests only; a production build refuses it
  (#227's demotion).

**This amends ADR-0021**: the content-script/debugger hybrid becomes all-debugger. ADR-0021
rejected all-debugger only because `DOM.setFileInputFiles` takes local paths; building the `File`
objects inside the page from server-sent bytes needs no path.

## Channel

- The extension opens the WebSocket; the server can never reach the employee's browser. The token
  travels in the first message, not the URL. A heartbeat of at most 20s keeps the MV3 service
  worker alive.
- Invoice originals go over HTTP: `GET /erp/blobs/:sha256`, authorised by the pairing token, and
  serving only the blobs named in the running job's plan (ADR-0022's owner-scoped read path). The
  WebSocket carries control messages only.
- Reconnection window: 120s, then ADR-0020 applies — with `attempt_started`, 对账; without it,
  abort in place and say plainly that no ERP write happened.

## Pairing

- One-time code: 8 characters, 10 minutes, single use.
- The zip downloaded from the settings page carries this server's origin, baked in, including
  `host_permissions`. The popup asks for the code only, and offers no way to change the server
  address — one field, and no way to redirect the extension at a rogue server.
- **One active pairing per app account**; a new pairing revokes the old one. The lease is per
  account (ADR-0019), so two paired browsers would leave no rule for which one gets the job.
- Pairing is independent of app login in both directions (ADR-0019). The settings page lists the
  paired browser and its last connection, with a revoke button.

## Execution

Each 去报销 opens a dedicated new ERP tab; `chrome.debugger` attaches to that tab only, never to
tabs the employee opened. Login happens there. The tab is brought to the foreground during the
fill, so background-tab timer throttling cannot disturb the Kendo grid's timing. Progress is
watched in the baox page.

## Deployment, phase 1: intranet, no domain

No domain means no publicly trusted certificate. `tls internal` would require every employee to
trust a private CA on an unmanaged personal machine; click-through warnings teach the wrong habit.
Both were rejected in favour of plain HTTP on the intranet, with guardrails:

- Caddy still fronts the service, listening on `:80`; Node keeps binding 127.0.0.1. Adding a domain
  later is a one-line Caddyfile change.
- `BAOX_PUBLIC_ORIGIN` replaces the local-only host guard in `app.ts` with an exact-origin check,
  which still defeats DNS rebinding.
- The `Secure` cookie flag follows the scheme: set under https, absent under http.
- The server refuses to start when the origin is http and the host is not a private address, so the
  plaintext deployment cannot accidentally be exposed to the internet.
- The firewall admits intranet ranges only. Employees off the intranet wait for the domain phase.
- Accepted risk, to be written into the deployment doc: app passwords, pairing tokens and invoice
  originals travel in clear on the LAN. This is not below the company's existing posture — the ERP
  itself is served over plain `http://erp.antute.com.cn` (public IP 1.119.199.76).

Moving to a domain later is handled as an upgrade: employees re-download the extension and re-pair,
and web sessions reset.

Data move: copy the existing data directory (SQLite plus originals) as-is; no format conversion and
no migration script. 发票占用 must carry over, or invoices already reimbursed lose their protection
against a second reimbursement. Deployment doc: stop the service, copy the directory, confirm it
sits on an encrypted volume (ADR-0022), then start.

## Distribution

Load-unpacked in developer mode (ADR-0021), with the zip served from the app's own settings page so
extension and server versions match, Chinese step-by-step upgrade instructions, and the server
enforcing a minimum version.

## Still deferred

OCR worker concurrency and rate limiting (#227).

## Written down already

`CONTEXT.md` gained 浏览器扩展 and 扩展配对, and ERP 自动化控制权 now expires when the account's
**paired extension** loses its connection. The ADR-0021 amendment waits for the spike. Phase-1 plain
HTTP gets no ADR: it is a config change away from reversible, so it belongs in the deployment doc.
