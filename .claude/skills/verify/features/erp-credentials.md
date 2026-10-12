# ERP 凭据 (设置页「报销系统账号密码」)

The employee saves the ERP account and password the baox 本地执行器 signs in with (ADR-0033). The page says that every
login knocks the account's other ERP logins off, saves, and runs a 试登录 through the paired 本地执行器. Afterwards it
shows only the account and the status: 还没有保存, 已保存还没有试登录成功 (with the reason), 试登录成功, or ERP 拒绝了
这个密码 (deleted). The password never comes back. The employee can 再试登录, 换一组, or 清除.

## Sub-features

- Save: account and password, then 保存并试登录.
- 试登录 outcomes: authorised; refused (password deleted); untested with a reason (no 本地执行器 connected, a
  浏览器扩展 paired, a job running, timed out, a second factor).
- 再试登录一次, 换一组账号密码, 清除 (with a confirm dialog).
- No key on the server: the section says saving is unavailable.

## How to get to it (user POV)

设置 (`/#/settings`), the section 报销系统账号密码 below 浏览器扩展.

## Driving it with verify.sh

Scenario `erp-credentials`. It needs the server's key, passed through the environment:

```bash
rexec --background --timeout 1500 'node -e "process.stdout.write(require(\"crypto\").randomBytes(32).toString(\"hex\"))" > /tmp/verify-erp.key && BAOX_ERP_CREDENTIAL_KEY_FILE=/tmp/verify-erp.key .claude/skills/verify/verify.sh run erp-credentials'
```

It drives save → untested (no 本地执行器) → reload → 清除, and asserts the API view never carries the password.

## Gotchas

- Not driven here: a successful or refused 试登录. That needs a paired 本地执行器 and the real ERP:
  `server/scripts/spike-local.ts` on the Mac, and `server/src/erp-credentials.test.ts` with a fake executor.
- Without `BAOX_ERP_CREDENTIAL_KEY_FILE` the section shows the unavailable notice and has no form.
