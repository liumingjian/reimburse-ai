# The app server serves only HTTPS, under a private CA constrained to its own address

**Amended 2026-10-18 ([ADR-0037](0037-local-executor-is-the-only-way-to-reimburse.md)): the browser extension is gone,** so the address-change migration for its users below no longer applies.

**Status: proposed (2026-10-17).** Decided with the owner in the follow-up to the #412 grill
([#413](https://github.com/liumingjian/reimburse-ai/issues/413)). HTTPS on the app server is a release prerequisite
of the 本地执行器's one-command install (ADR-0035) and of sending ERP 凭据 to employee PCs (ADR-0033). There is no
public domain to put a publicly trusted certificate on, so the server gets one from a private CA. This reverses the
phase-1 rejection of `tls internal` in [browser-extension-v1.md](../design/browser-extension-v1.md#deployment-phase-1-intranet-no-domain).

## Decisions

- **A private root CA, constrained to one address.**
  - The root carries an X.509 name constraint that permits only `10.250.0.222`, and is valid for 10 years. A root
    that an employee PC trusts could otherwise sign a certificate for any site the employee visits.
  - The operator generates the root key in the candidate's `host` stage, kept like the ERP 凭据 key
    (`docs/deployment/native-operator.zh-CN.md`): outside every release, kept across switch and rollback, never
    rewritten once it exists.
  - Caddy issues and renews short-lived server certificates from it by itself.
  - Whether Chrome, Edge and macOS enforce a name constraint on a locally trusted root is checked on the real-machine
    run. Where one does not, the certificate still works and only this protection is lost.
- **The production instance serves HTTPS only.**
  - The origin becomes `https://10.250.0.222:8443`. `http://10.250.0.222:8888` closes, with no redirect: nothing on
    222 is served over http any more.
  - The 本地执行器 connects over `wss://`.
  - Development instances on the Mac mini and the e2e suite stay on http. `BAOX_PUBLIC_ORIGIN` keeps accepting both
    schemes. e2e tests behaviour, not the transport; the real-machine run tests the transport.
- **Each PC trusts the root once, by one pasted command.**
  - Employee PCs are not managed by IT, so nothing pushes the root. The employee pastes one 「信任证书」 command:
    - on a Mac it adds the root to the login keychain, which asks for the employee's macOS password once;
    - on Windows it adds the root to the current user's trusted roots, which asks 「是否安装此证书」 once.
    - Neither needs administrator rights.
  - The command comes in the launch notice (企业微信 or email), not from a page, since no page can be trusted before the
    root is. It fetches the root with certificate checks off (`curl -k`, or the PowerShell equivalent) and installs it
    only if its sha256 matches the fingerprint written into the command. The fingerprint travels in a different
    channel from the certificate, so tampering on the intranet path is caught.
  - Every employee needs this, whichever 去报销的方式 they use: the 设置页 itself is HTTPS.
  - The 设置页's 「安装遇到问题？」 carries the matching command that removes the root. Uninstalling the 本地执行器
    leaves the root alone, because the employee still uses the app.
- **Everything else then trusts the root through the operating system.**
  - The install command keeps its shape, over https and without `-k` or pinning:
    `curl -fsSL https://10.250.0.222:8443/install/<配对码> | sh`. macOS's `/usr/bin/curl` uses SecureTransport, which reads
    the keychain (curl 8.7.1 on macOS 26.6, checked 2026-10-17), and PowerShell's `irm` uses the Windows store.
  - The 本地执行器 starts Node with `--use-system-ca` (Node 24.21, checked 2026-10-17). It is a command-line flag,
    so clearing `NODE_OPTIONS` at every start (ADR-0035) does not remove it.
  - Chrome and Edge use the operating system's trust store on both systems.
- **Switching.** 222 moves to HTTPS once this work is merged and deployed, before the one-command install is offered
  to employees.
  - The 浏览器扩展 bakes its origin in at download, so its users take the existing address-change migration: they
    re-download it and pair again.
  - The 本地执行器 has not been offered to employees yet (HTTPS was its prerequisite). The test PCs that run a zip
    install reinstall with the command, so #412's "zip installs keep working" holds only until this switch.
  - Web sessions reset.
- **Losing or rotating the root** means every PC runs the 「信任证书」 command again with the new fingerprint.

## Considered Options

- **A publicly trusted certificate on a domain.** Not available: the owner has no suitable public domain.
- **IT pushing the root** (group policy, MDM). It would ask nothing of employees, but their PCs are not centrally
  managed.
- **Keeping 8888 on http for a trust page and the root file.** It was the first recommendation. Rejected for the
  stronger rule that nothing on the server is served over http, and because a fingerprint shown on an http page proves
  nothing (trust on first use). The launch notice carries it instead.
- **Pinning the server's key in each command (`curl -k --pinnedpubkey`)** instead of trusting a root. It would secure
  the install command but not the browser, which must open the 设置页 over HTTPS anyway.
- **Click-through certificate warnings.** Rejected again, for phase 1's reason: they teach the wrong habit.

## Consequences

- The plaintext gap that `docs/deployment/intranet-phase-1.md` records ("Traffic is in clear on the LAN") closes for
  the app. The ERP itself stays on plain http; that is outside baox.
- The root key is now the most sensitive file on 222 after the ERP 凭据 key: whoever holds it can impersonate the app
  to every PC that trusts it (within the name constraint).
- Every employee does one extra step before their first use, and again after a root rotation.
- Test instances keep an http configuration that production no longer uses, so a regression that only shows under TLS
  (the `Secure` cookie flag, `wss://`, the browser's private-network preflight to 47319 from an https page) is caught
  only by the real-machine run.
