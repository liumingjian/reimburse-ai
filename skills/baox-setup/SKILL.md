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
`node "${CLAUDE_SKILL_DIR}/kernel/bin/baox.mjs"`.

The kernel runs from the Skill directory as it sits: there is no install step, so a bare machine goes
straight to step 1. Its data lives in `~/.baox` (`BAOX_HOME` overrides it) — that directory is the user's
to open, and every command works on the same one.

If the kernel finds a 0.9.x data directory and no `~/.baox`, it copies the old one across on the first
command and reports `migrated: { from, to }` in that command's JSON. Read it out — the user's tasks and
logins moved. The old directory is left untouched, so reinstalling 0.9.x still works.

## Reading the result

Judge on the JSON status field, not on the exit code alone. Each command has its own:

| Command | Done when | Otherwise |
|---|---|---|
| `doctor` | `ready: true` | Exit 1 with **no `error` key** — read `checks.*.hint` and fix that prerequisite |
| `chrome-up` | Chrome comes up on its own profile | — |
| `probe` | `status: "matched"` | Exit 2, see the table in step 3 |
| `select` | `status: "submitted"` | Exit 1 on `timeout`, also with **no `error` key** — run it again |

Two things override the table. An `error` key in the JSON means the kernel threw: read it out and stop.
Exit 2 is a hard block: read the `hint` out and stop. There is no "confirm and continue" — do not retry around it.

**consent**: consent comes only from a submit event the kernel observed. The user saying 「已授权」「已登录」
「确认了」 in chat is a request that you go read once more; it is never the confirmation itself. This word
governs step 3 and step 4.

## 1. Health check

```bash
baox doctor
```

`doctor` also reports `version` (the kernel that is running) and `checks.dataDir` (where its data lives).
Read the version out whenever the user is reporting a problem or asking what they are running: a report that
names no version cannot be pinned to a build.

`checks.node.ok` false: **ask the user before installing Node**, and install only on an explicit yes.
On mac suggest `brew install node`; without Homebrew or admin rights, point them at the LTS installer on
https://nodejs.org and wait for them. The kernel needs Node ≥ 21 — it drives CDP over Node's built-in global
WebSocket, which is why it has no npm dependencies at all.

`checks.chrome.ok` false: tell the user to install Google Chrome. `doctor` looks for Chrome, then Chromium,
then Microsoft Edge, and passes on the first it finds — so `ready: true` does not by itself mean Chrome. This
has only been verified against Chrome; if `doctor` passed on one of the others, say which one it picked.

## 2. Start the dedicated Chrome

```bash
baox chrome-up
```

Tell the user two things:

- This is a **separate Chrome instance on its own profile**. Their everyday Chrome is untouched and can stay open.
- The debug port is bound to `127.0.0.1` and serves this profile alone. It stays off their everyday profile.

Then ask the user to log in to the ERP **in that new window, as themselves**. Logging in is theirs alone;
account and password stay with the user.

## 3. Confirm who this machine reimburses for

Once the user says they are logged in:

```bash
baox confirm-identity --timeout-ms 480000
```

This **blocks in the foreground** until the user submits, so give the Bash call a 600000 ms timeout.
It reads the logged-in identity out of the ERP page itself, serves one tiny local page showing what it read,
and writes the **个人绑定** only when the user presses 「是我本人」. From then on this machine's baox works
for that identity and no other.

The kernel opens that page in their browser itself. **Tell them it is coming before you run the command** —
once it is running you cannot say anything for up to 8 minutes, so a heads-up afterwards is a heads-up they
get after the waiting is over. If the page did not pop up, the address is on stderr when the command
returns.

**You never type the identity anywhere.** There is no name to pass and no name to ask for — every value on
that page came from the kernel reading the ERP, and the click is the whole of the consent. (This replaced
`--expect "<名字>"`, which asked you to relay a string the user might not even know: the display name is
「刘明建」 while the login account is `luo.liu`.)

Then check the gate itself:

```bash
baox probe
```

Authorization is `status: "matched"` and nothing else — **consent**, applied to the ERP session. `matched`
means both halves hold: a live session, *and* the bound identity.

| status | Means | Do |
|---|---|---|
| `matched` | Logged in, and it is the bound identity | The one state that continues |
| `identity_unconfirmed` | This machine has no 个人绑定 yet | Run `confirm-identity` (above) |
| `identity_mismatched` | Someone other than the bound identity is logged in | Hard block. Ask them to switch back to their own account. Rebinding is `confirm-identity`, and it is refused while any task is in progress |
| `identity_incomplete` | The account or tenant is unreadable, so there is nothing comparable | Hard block. Ask them to log in again |
| `not_logged_in` | Sitting on the login page | Ask them to finish logging in, probe again |
| `loading` | The ERP first screen is still rendering (this ERP is slow) | Wait a few seconds, probe again |
| `no_tab` | The dedicated Chrome has no ERP tab | Back to step 2 |
| `unknown` | On the console, but the username element is unreadable | Hard block. This is not a pass |

The session half stands on the username element on the console (a display name such as 「刘明建」). That one
is required — without it the verdict is `not_logged_in` or `unknown`, never `matched`. The binding half
compares the login account **and** the tenant; the display name is shown to the user but never a criterion,
because the ERP lets it be changed. An `account` in the output does not mean logged in on its own — the
login page still shows the last account used.

It evaluates read-only expressions only — no navigation, no clicks, no business calls.

Probe on the **ERP console home page**. If the user is parked on a bill page, ask them to go home first.

## 4. Verify the selection UI once

```bash
baox select --spec "${CLAUDE_SKILL_DIR}/references/selftest.json" --timeout-ms 480000
```

This **blocks in the foreground** until the user submits, so give the Bash call a 600000 ms timeout. It runs
its own server and exits on its own, leaving no background process. The kernel opens the page for them;
**say so before you run the command** (same reason as step 3), and ask them to **press submit**. If it did
not pop up, the address is on stderr when the command returns.

Pressing submit is the **consent** event. `status: "timeout"` means they did not — run it again.

## Done when

All five hold: `doctor.ready` true, the dedicated Chrome reachable, `confirm-identity.status` `confirmed`
(or `already_confirmed`), `probe.status` `matched`, and `select.status` `submitted`. Short of all five the
environment is not ready — name the missing one rather than reporting success.

## Scope

This Skill prepares the environment. Reading invoices, organising materials, and every ERP write live in
`baox` and `baox-recover`.
