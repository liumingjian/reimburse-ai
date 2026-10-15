# The 本地执行器 is installed on its own, and keeps itself on the server's program

**Status: proposed (2026-10-15).** Decided with the owner while settling line 2 item 6 of `docs/design/erp-headless-v1.md`:
how the 本地执行器 of ADR-0033 reaches an employee's PC and stays current. Employees use both Windows and macOS.

## Decisions

- **A separate install, not part of the extension.**
  - The 浏览器扩展 cannot start a process, so shipping the executor inside the extension's zip would still leave the
    employee to start it by hand.
  - An employee on the headless path needs no extension at all.
  - The settings page offers one zip per platform: Windows x64, Apple-silicon Mac, Intel Mac. A browser cannot tell
    the two Macs apart, so the employee picks.
- **The zip holds Node's own runtime, one bundled program and a launcher. It is not a single executable.**
  - A Node single executable would carry baox's code inside Node's binary.
    - That breaks Node's signature.
    - On Apple silicon an unsigned binary does not run, and it can only be signed again on a Mac.
    - The release is built on the intranet host, which is Linux.
  - Node's untouched binary keeps its signature: Authenticode on Windows, Developer ID and notarisation on macOS.
  - The program is plain JavaScript (zod and the workspace packages), so one bundle serves every platform.
  - The runtimes are fetched at deploy from the configured Node mirror. Each is checked against the release's
    SHASUMS256.txt before it is used.
- **Installing is one double-click.** The launcher asks for a 配对码, then:
  - copies the runtime, the program and the app's address (written into the zip by the server, as the extension's
    origin is) into the executor's own directory;
  - registers it to start with the login: a script in the Startup folder on Windows, a LaunchAgent on macOS;
  - starts it.

  None of this needs administrator rights. The employee still has to get past SmartScreen (Windows) or Gatekeeper's
  「仍要打开」 (macOS) for the launcher script once; the settings page says how.
- **It uses the browser the PC already has.**
  - Chrome first: installed for all users, or, on Windows, for this user only.
  - Then Edge, which every Windows 10 and 11 has.
  - baox ships no browser.
- **It updates itself, to exactly the program the server ships.**
  - The server publishes the program's sha256 and the runtime version. The executor asks with its pairing token at
    start, every 30 minutes while no job runs, and when the app refuses its connection.
  - Any difference is replaced, older or newer: the server is the one place a release is decided.
  - The new program must match the announced sha256. It replaces the old one with a rename, and the executor restarts
    into it.
  - A release for another Node version is not swapped in place: the executor tells the employee to download the zip
    again.
- **One executor per login.** A pid file keeps a second copy from taking the account's channel from the first.

## Consequences

- The extension's version gate (ADR-0021) still applies: the executor reports the extension protocol version it was
  built with. Raising `EXTENSION_MINIMUM_VERSION` refuses an old executor, which then updates itself and reconnects,
  without the employee doing anything.
- The deploy downloads three runtimes, about 100 MB each, once per Node version, and keeps them across releases. Each
  platform's zip is assembled once per program and address and cached under the data directory.
- **Not verified on a real Windows PC yet.** The Windows launcher, the Startup script, the Edge fallback and SmartScreen's
  prompt have only been checked by tests that read the generated files.
