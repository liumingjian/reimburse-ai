# The 本地执行器 is installed on its own, and keeps itself on the server's program

**Status: proposed (2026-10-15).** Decided with the owner while settling line 2 item 6 of `docs/design/erp-headless-v1.md`:
how the 本地执行器 of ADR-0033 reaches an employee's PC and stays current. Employees use both Windows and macOS.

**Amended 2026-10-16 (owner, [#412](https://github.com/liumingjian/reimburse-ai/issues/412)): one command replaces the
zip.** The per-platform zip, its double-click launcher and the Gatekeeper / SmartScreen instructions are gone. The
employee picks Mac or Windows on the 设置页 and pastes one command into Terminal or PowerShell. The 本地执行器 may run on
the employee's own Node, but only Node 24.x. 47319 also serves an origin-checked pairing endpoint. The decisions below
are rewritten in place. The zip-era text survives only where it still holds.

## Decisions

- **A separate install, not part of the extension.**
  - The 浏览器扩展 cannot start a process, so shipping the executor inside the extension's zip would still leave the
    employee to start it by hand.
  - An employee on the headless path needs no extension at all.
- **Installing is one pasted command (amended 2026-10-16).**
  - On the 设置页 the employee picks Mac or Windows (neither is pre-selected) and clicks 「生成安装命令」:
    - Mac: `curl -fsSL http://<应用地址>/install/<配对码> | sh`
    - Windows: `powershell -ExecutionPolicy Bypass -c "irm http://<应用地址>/install/<配对码> | iex"`
  - The system chosen is stored with the pending 配对码, and `GET /install/<配对码>` returns the shell or PowerShell
    script for it. Fetching does not consume the code; pairing does (one-time, 10 minutes, one per account). An unknown
    or expired code still gets a script, one that prints 「配对码已过期，请回设置页重新生成」 and exits non-zero.
  - The script, in order:
    1. detects the platform (darwin-arm64, darwin-x64, win-x64), so the employee never has to know which Mac they have;
    2. picks a Node (next decision);
    3. downloads the program from the app server;
    4. stops any running 本地执行器;
    5. installs into `~/.baox/local-executor` (the same home under the user profile on Windows), overwriting, with the
       same start-at-login entry: the LaunchAgent `com.baox.local-executor`, or the script in the Startup folder;
    6. pairs with the code in the command;
    7. starts it.
  - None of this needs administrator rights. A script fetched by `curl` / `irm` carries no downloaded-file mark, so no
    Gatekeeper or SmartScreen prompt appears and the 设置页 no longer explains them.
  - The terminal shows only fixed Chinese lines (「检查运行环境」, 「下载运行环境 n%」, 「配对」,
    「已安装，可以关掉这个窗口」). Every failure maps to one actionable Chinese sentence, never a raw error.
  - Uninstalling is one command too: it stops the executor, removes the start-at-login entry and deletes its home. It
    leaves the employee's Node and the pairing in the app alone.
  - A web page cannot run a program on the PC, so the first install needs one paste; it cannot be a button.
- **Node: the employee's own Node 24, or the one the server caches (amended 2026-10-16).**
  - The employee's own Node is used if it is major version 24 and, on macOS, `codesign` verifies the official Node.js
    signature ("Developer ID Application: Node.js Foundation (HX7739G8FX)", checked on 2026-10-15). Windows checks the
    version only, for now.
  - Otherwise the script downloads the runtime for this platform from the app server, which serves the three runtimes
    it caches at deploy with each one's sha256, and verifies it before use. The employee's own Node is never upgraded,
    replaced or removed.
  - The executor's config records the absolute path of the Node it uses. The launcher and the start-at-login entry run
    that path, never `node` from PATH, so a Node from nvm or Homebrew still starts at login.
  - Every start rechecks it: the path still exists, it is still major 24, and on macOS it is still signed. If not, the
    executor switches to the downloaded runtime, fetching it if absent.
  - Every start (launcher, LaunchAgent, Windows start entry) clears `NODE_OPTIONS` and the other variables that make
    Node load extra code before the program.
  - Node's untouched binary keeps Node's own signature, which is why baox never builds a single executable: that would
    carry baox's code inside Node's binary, break the signature, and on Apple silicon need re-signing on the Linux build
    host with a third-party signer, ad hoc only.
  - The program is plain JavaScript (zod and the workspace packages), so one bundle serves every platform.
  - The runtimes are fetched at deploy from the configured Node mirror. Each is checked against the release's
    SHASUMS256.txt before it is used.
- **The app address.** The program needs the app's address. The zip had it written in by the server, as the extension's
  origin is; the install script now carries it.
- **It uses the browser the PC already has.**
  - Chrome first: installed for all users, or, on Windows, for this user only.
  - Then Edge, which every Windows 10 and 11 has.
  - baox ships no browser.
- **It updates itself, to exactly the program the server ships.**
  - The server publishes the program's sha256 and the runtime version. The executor asks with its pairing token at
    start, every 30 minutes while no job runs, and when the app refuses its connection.
  - Any difference is replaced, older or newer: the server is the one place a release is decided.
  - The new program must match the announced sha256 and must load and answer `self-check` under this runtime. Only
    then does it replace the old one (kept as `.prev`), with a rename, and the executor restarts into it. A release
    that cannot start never replaces a working one.
  - Never under a job: a restart waits until the job ends.
  - Self-update replaces only the program. The runtime check compares the Node major version, not the exact version
    (amended 2026-10-16). On the employee's own Node a server minor-version change is ignored, and a major-version
    change switches to the downloaded runtime automatically. The employee is never asked to download anything again.
- **One executor per PC.** It holds a fixed loopback port (47319) for as long as it runs. A second copy cannot get the
  port and leaves, and the system frees the port however the holder dies.
- **47319 also re-pairs (amended 2026-10-16).** The same listener serves a pairing endpoint. It accepts a 配对码 only
  from a request whose `Origin` is the app's own configured origin, and it answers the browser's private-network
  preflight. When the 设置页 finds an executor answering there it offers 「连接这台电脑的执行器」, which generates a code
  and posts it there; the executor pairs with it exactly as the install does. Re-pairing never needs the terminal.
- **When it stops.** It stops only when the app says the pairing is gone. Any other refusal it waits out for five
  minutes, then its launcher starts it again.

## Considered Options

- **A zip per platform with a double-click launcher** (the 2026-10-15 decision). Replaced 2026-10-16: about 100 MB per
  platform, almost all of it a Node many employees already have, then unzipping, a Gatekeeper or SmartScreen prompt,
  and typing a 配对码. Each manual step is where a non-technical employee gets stuck.
- **Keeping the zip as a fallback next to the command.** Rejected by the owner (「暂时不做这样一个兜底的保留」): one
  install path to keep working.
- **Detecting the OS from the browser.** Rejected: the employee picks Mac or Windows; the script tells the two Macs apart.

## Consequences

- **Trust.** The sha256 comes from the same server as the program, over the app's own connection. It proves the bytes
  arrived whole, not who wrote them. Whoever controls the app's server, or the network path to it, controls the program
  on every employee's PC, and those PCs receive ERP 凭据 per job. The same now holds for the install script and the
  downloaded runtime. While the app is reached over plain http that path is the intranet. HTTPS on the app server is
  what closes it, and is a release prerequisite: employees get the command only after the server serves HTTPS (the
  内网主机 may serve it over http for testing). Signing the program with a key the executor pins would close the server
  half too, and is not done.
- **The executor may hold the 报销系统 password on a Node the app did not ship.** Accepted by the owner on 2026-10-16
  to skip a 100 MB download for employees who already have Node. Bounded by: Node 24.x only; the code-injecting
  variables cleared at every start; on macOS only an officially signed Node. On Windows only the version is checked, so
  there a tampered Node 24 on the employee's PC would be handed the password.
- **The 配对码 is in the command,** so a copy left in terminal history or forwarded is a pairing credential until it
  pairs or expires (10 minutes), and useless after. ADR-0019 rejected a code pre-stamped into a downloaded zip because a
  zip lives on; a command's code does not.
- **Release prerequisites.** Besides HTTPS: one install, re-pair and uninstall each on a real Mac and a real Windows PC,
  including a check that the company's antivirus does not block `irm … | iex`. Until then the Windows script, the
  Startup entry and the Edge fallback are checked only by tests.
- The extension's version gate (ADR-0021) still applies: the executor reports the extension protocol version it was
  built with. Raising `EXTENSION_MINIMUM_VERSION` refuses an old executor, which then updates itself and reconnects,
  without the employee doing anything.
- The deploy downloads three runtimes, about 100 MB each, once per Node version, and keeps them across releases. No
  install package is assembled or offered any more.
- **Existing installs.** Executors installed from the zip keep their home and start entry, and receive the new program
  through self-update. Nothing migrates and nothing is reinstalled.
