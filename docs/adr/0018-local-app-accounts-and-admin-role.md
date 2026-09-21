# The local app has its own accounts, an admin role and a public project book

baox v1 stays a single local process, yet it gets real app accounts. The data model then already matches the V2 central deployment, and several people can share one machine. The accounts are independent of ERP accounts (ADR-0016). Decided in [#159](https://github.com/liumingjian/reimburse-ai/issues/159); this redraws the map's earlier ruling that put all auth and data isolation in V2.

## Decisions

- **Local only.** The server binds `127.0.0.1`. Accounts exist for data ownership and roles, not as network hardening. LAN or remote access, TLS and brute-force protection stay V2.
- **Credentials.** Username + password, hashed with salted `node:crypto` `scrypt` (no dependency). Server-side sessions live in SQLite. The browser holds only a random token in an `HttpOnly; SameSite=Strict` cookie, which expires on a fixed sliding window (30 days). Logout deletes the session row.
- **Registration and the first admin.**
  - While no account exists, the app shows only "create admin". That first account becomes the authorized admin. Later self-registration creates a pending application and grants no session; an administrator must explicitly approve it before login. Existing accounts retain authorization during migration. Approval is separate from activation and role, so restoration or promotion cannot bypass approval.
  - Admins may promote or demote others. The server always keeps at least one admin.
- **Two roles.** `user` and `admin`, stored as a flag on the account. An admin is a full user (own project book, home city, tasks) plus two powers: editing the 公共项目簿 (public project book) and managing accounts.
- **Accounts are deactivated, never deleted.** A deactivated account cannot log in. Its tasks, audit records and 发票占用 (invoice occupancy) stay as they are.
- **Password recovery.** An admin sets a temporary password, which the user must change at next login. If an admin is locked out, a local `baox admin emergency-reset <username>` command on the machine is the fallback. It refuses any target that is not the only active admin, and every reset writes an `account_event` audit record with no actor.

  *Amended 2026-09-21 by [#228](https://github.com/liumingjian/reimburse-ai/issues/228), before the service binds anything other than `127.0.0.1`.* The original fallback reset **any** account unconditionally, on the reasoning that access to the machine counts as authority. That reasoning holds for a process on one person's laptop; on the shared intranet host of spec [#246](https://github.com/liumingjian/reimburse-ai/issues/246) it degrades the whole model to "whoever has a shell is god", including reading other people's 发票原件 (invoice originals). The web-UI temporary password above is now the only way to recover *someone else's* account; the CLI only unlocks an administrator.

  *Amended again 2026-09-21 by the spec #246 code review (story 42: the CLI resets only an administrator's **own** account).* Restricting the CLI to administrators still let a shell on a host with two administrators take the other one over. A command line has no session, so "own" is made unambiguous instead: the CLI refuses unless the target is the **only active administrator** (role admin, active, approved — the set the last-admin guard counts). That keeps its purpose, since a sole administrator locked out is by definition the one at the shell, and closes the takeover: with two or more administrators, the other one sets a temporary password in the web UI, the path above. The refusal is `not_sole_admin`.
- **One non-terminal task per account.** This replaces the global rule. ERP jobs stay serialised by the global ERP control lease (ADR-0016). A second user's 去报销 gets a 409 "ERP is in use by another task" and may retry later.
- **Isolation.**
  - Per account: 个人项目簿 (personal project book), 常驻城市 (home city), tasks with their materials and audit records. Admins cannot see other users' tasks.
  - Shared: the public project book, company rules and the project catalog cache.
  - **Invoice occupancy is global.** A legal invoice cannot be reimbursed twice by anyone. A clash across accounts says only "occupied by another account's task", with no name or task details. Content-addressed blobs may be deduplicated on disk, but they are reachable only through the owner's tasks.
- **Public project book.**
  - Stored in SQLite in the same shape as personal books, with public scope instead of an owner.
  - Admins edit, deactivate/restore, and delete public entries in the web UI. Deactivation reserves the project number; deletion releases it and preserves submitted history. Legacy removal facts retain their original deactivation meaning. Changes are append-only (ADR-0015).
  - 任务选择 (task selection) pins code + name + source (`public` / `personal`) per line. Later public-book edits do not touch submitted selections, and the ERP catalog check still verifies them.
  - An entry deactivated before submission can no longer be chosen, so the page asks the user to re-select.
- **Legacy import.** The one-time `~/.baox` import runs when the first admin is created, and everything goes to that account: project book (it stays personal and is not seeded into the public book), home city, and invoice occupancy from ERP-touched legacy tasks. Legacy identity bindings are no longer imported, because nothing reads them after ADR-0016. This amends ADR-0015's import scope.

## Considered Options

- **No accounts until V2.** Rejected: the user wants app accounts and an admin-owned public project book now, and retrofitting ownership onto every table later costs more than carrying it from the start.
- **A global single-task rule.** Rejected: one user's task stuck before 转人工 would block every other user's material work. The global lease already serialises the only part that must be exclusive, ERP.
- **Per-account invoice occupancy.** Rejected: occupancy guards against reimbursing a legal invoice twice, which is a company-wide fact.

## Consequences

- Every per-account table carries an owner account id from its first migration.
- The map's "at most one non-terminal task" note (ADR-0014) and ADR-0015's import list are amended as above.
