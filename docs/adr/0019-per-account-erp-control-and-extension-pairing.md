# ERP control is per app account, and the extension pairs with a one-time code

The ERP browser moves out of the server and into each employee's own browser, driven by a browser extension, so the ERP session never leaves the user's machine. ADR-0016 built the seam for this deliberately; this decides who holds ERP control now that there is more than one browser, and how the server knows whose browser it is talking to. Decided in [#223](https://github.com/liumingjian/reimburse-ai/issues/223); it amends ADR-0016 and ADR-0018.

## Decisions

- **`ERP 自动化控制权` (ERP automation control) is per app account, not global.** One app account cannot run two ERP jobs at once. Different accounts never block each other, and the global 409 `erp_in_use` path of ADR-0018 is retired.
- **The lease expires when that account's browser connection is lost**, not when the app process exits. The holder of the other side is now a remote extension, not an in-process browser.
- **Pairing: a one-time code.** The web UI issues a short-lived, single-use code. The extension exchanges it for a long-lived token stored in `chrome.storage.local`. The token carries the app account id; the server routes ERP commands and receives observations by that id.
- **The pairing token is a distinct, separately revocable credential.** It is not the web session. Revoking it in the account UI does not log the user out of the web app, and logging out of the web app does not unpair the extension.
- **ERP authorisation is unchanged in substance, changed in place.** The employee logs in to the ERP themselves, and that login *is* the authorisation (ADR-0016). It now happens in their own browser's ERP session rather than in a browser baox started. The probed ERP account and 账套 (account set) are still recorded on the attempt and still never compared against the app account.

## Considered Options

- **Keep control global.** Rejected. The rule exists for 发票占用 (invoice occupancy) and for "an ERP write of unknown outcome is never replayed" — both properties of one ERP account writing one bill. Serialising across different users buys neither, and turns the system into a queue once ten people use it.
- **Drop the concept entirely**, on the grounds that each user has their own browser and session. Rejected: it is precisely one user's two concurrent jobs that could reference the same invoice and write through the same ERP account.
- **Authenticate the extension with the web session cookie.** Rejected: it welds the extension's lifetime to the cookie's, drags in `SameSite` and WebSocket-`Origin` semantics, and goes dead the moment the user logs out of the web app.
- **Authorise afresh on every 去报销.** Rejected: an interruption every single time defeats the purpose of automating the fill.

## Consequences

- `server/src/erp-lease.ts` becomes partitioned by app account id.
- New endpoints to issue and redeem pairing codes, and to revoke a token.
- `CONTEXT.md` is updated: 「ERP 自动化控制权」 is per app account and expires on connection loss; 「ERP 自动化授权」 happens in the user's own browser's ERP session.
- ADR-0018's "a second user's 去报销 gets a 409" clause no longer holds.
