---
name: baox-setup
description: baox environment setup. Use on first use, or when baox / baox-recover reports that the kernel, the dedicated Chrome, or the ERP login identity is not ready.
allowed-tools: Bash
---

# baox environment setup

Everything the user sees is Chinese: the ERP, its field labels, and your own replies. English is for this file only.

You do three things: run the commands below, read the kernel's JSON back to the user in plain Chinese, and
say clearly what the user has to do by hand. You do not judge, calculate, or decide on the kernel's behalf.

**`baox` below stands for the kernel entry point.** It is not on `PATH` — expand it every time:

- Before `install-runtime`: `node "${CLAUDE_SKILL_DIR}/kernel/bin/baox.mjs"`
- After `install-runtime`: `node "$HOME/Library/Application Support/baox/runtime/bin/baox.mjs"`
  (Windows: `%APPDATA%\baox\`)

## Reading the result

Judge on the JSON status field, not on the exit code alone. Each command has its own:

| Command | Done when | Otherwise |
|---|---|---|
| `doctor` | `ready: true` | Exit 1 with **no `error` key** — read `checks.*.hint` and fix that prerequisite |
| `install-runtime` | `entry` present | — |
| `chrome-up` | Chrome comes up on its own profile | — |
| `probe` | `status: "matched"` | Exit 2, see the table in step 4 |
| `select` | `status: "submitted"` | Exit 1 on `timeout`, also with **no `error` key** — run it again |

Two things override the table. An `error` key in the JSON means the kernel threw: read it out and stop.
Exit 2 is a hard block: read the `hint` out and stop. There is no "confirm and continue" — do not retry around it.

**consent**: consent comes only from a submit event the kernel observed. The user saying 「已授权」「已登录」
「确认了」 in chat is a request that you go read once more; it is never the confirmation itself. This word
governs step 4 and step 5.

## 1. Health check

```bash
baox doctor
```

`checks.node.ok` false: **ask the user before installing Node**, and install only on an explicit yes.
On mac suggest `brew install node`; without Homebrew or admin rights, point them at the LTS installer on
https://nodejs.org and wait for them. The kernel needs Node ≥ 21 — it drives CDP over Node's built-in global
WebSocket, which is why it has no npm dependencies at all.

`checks.chrome.ok` false: tell the user to install Chrome. Chrome is the only browser this works on.

## 2. Install the kernel

```bash
baox install-runtime
```

A file copy, no downloads. Keep the `entry` it returns; every later command uses that path.

## 3. Start the dedicated Chrome

```bash
baox chrome-up
```

Tell the user two things:

- This is a **separate Chrome instance on its own profile**. Their everyday Chrome is untouched and can stay open.
- The debug port is bound to `127.0.0.1` and serves this profile alone. It stays off their everyday profile.

Then ask the user to log in to the ERP **in that new window, as themselves**. Logging in is theirs alone;
account and password stay with the user.

## 4. Confirm the identity by read-only probe

Once the user says they are logged in:

```bash
baox probe --expect "<员工姓名或登录账号>"
```

Authorization is `status: "matched"` and nothing else — **consent**, applied to the ERP session.

| status | Means | Do |
|---|---|---|
| `matched` | The logged-in identity matches that employee | The one state that continues |
| `mismatched` | Someone else is logged in | Hard block. Ask them to switch to their own account |
| `not_logged_in` | Sitting on the login page | Ask them to finish logging in, probe again |
| `loading` | The ERP first screen is still rendering (this ERP is slow) | Wait a few seconds, probe again |
| `no_tab` | The dedicated Chrome has no ERP tab | Back to step 3 |
| `unknown` | On the console, but the username element is unreadable | Hard block. This is not a pass |

The probe reads two signals and needs both: the username element on the console (a display name such as
「刘明建」) and the login account in `localStorage` (such as `luo.liu`). `--expect` accepts either one.
It evaluates read-only expressions only — no navigation, no clicks, no business calls.

Probe on the **ERP console home page**. If the user is parked on a bill page, ask them to go home first.

## 5. Verify the selection UI once

```bash
baox select --spec "${CLAUDE_SKILL_DIR}/references/selftest.json" --timeout-ms 480000
```

This **blocks in the foreground** until the user submits, so give the Bash call a 600000 ms timeout. It runs
its own server and exits on its own, leaving no background process. Give the user the address printed on
stderr and ask them to open it and **press submit**.

Pressing submit is the **consent** event. `status: "timeout"` means they did not — run it again.

## Done when

All five hold: `doctor.ready` true, `install-runtime.entry` present, the dedicated Chrome reachable,
`probe.status` `matched`, and `select.status` `submitted`. Short of all five the environment is not ready —
name the missing one rather than reporting success.

## Scope

This Skill prepares the environment. Reading invoices, organising materials, and every ERP write live in
`baox` and `baox-recover`.
