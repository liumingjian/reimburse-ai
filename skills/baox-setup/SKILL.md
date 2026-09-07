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
`node "${CLAUDE_SKILL_DIR}/kernel/bin/launch.mjs"`.

The launcher hands each command to the kernel installed in the baox data directory, after checking the two
are the same version. `doctor` and `install-runtime` also run before anything is installed, which is what
makes this one path work from a bare machine onward.

Three of its exit-2 blocks land in this Skill, and this Skill is where they are fixed:

| `status` | Do |
|---|---|
| `runtime_not_installed` | Step 2 — the environment was never set up |
| `version_drift` | The Skill directories and the installed kernel disagree. Have the user confirm `baox`, `baox-recover` and `baox-setup` all sit in **one** location and came from **one** build — they update together — then run step 2 again |
| `downgrade_refused` | The installed kernel is **newer** than this Skill, so step 2 would roll it back. Almost always two baox installs on one machine: a personal `~/.claude/skills/` copy silently shadows the project `.claude/skills/` one, with no error on either side. Read the hint out, have the user run `/skill-doctor` (or `ls -d ~/.claude/skills/baox*`) and remove the copy they don't want. Only if they say they really do want the older kernel, re-run step 2 with `--allow-downgrade` |

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

`doctor` also reports `version` (the kernel this Skill carries) and `runtime.installed` (the one in the data
directory, `null` before step 2). Read the version out whenever the user is reporting a problem or asking
what they are running: a report that names no version cannot be pinned to a build.

`checks.node.ok` false: **ask the user before installing Node**, and install only on an explicit yes.
On mac suggest `brew install node`; without Homebrew or admin rights, point them at the LTS installer on
https://nodejs.org and wait for them. The kernel needs Node ≥ 21 — it drives CDP over Node's built-in global
WebSocket, which is why it has no npm dependencies at all.

`checks.chrome.ok` false: tell the user to install Google Chrome. `doctor` looks for Chrome, then Chromium,
then Microsoft Edge, and passes on the first it finds — so `ready: true` does not by itself mean Chrome. This
has only been verified against Chrome; if `doctor` passed on one of the others, say which one it picked.

## 2. Install the kernel

```bash
baox install-runtime
```

A file copy, no downloads. It copies the kernel this Skill carries into the data directory, where all three
Skills reach it. `version` is what is now installed; `replaced` is what was there before, `null` on a first
install. Every command after this one goes through the launcher, so there is no path to keep.

Run this again after the user updates the Skill directories — that is the whole fix for `version_drift`.

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

The probe stands on the username element on the console (a display name such as 「刘明建」). That one is
required — without it the verdict is `not_logged_in` or `unknown`, never `matched`. The login account in
`localStorage` (such as `luo.liu`) comes along when it is readable and can be `null`. `--expect` is matched
against **either**, so pass whichever the user actually knows.

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
