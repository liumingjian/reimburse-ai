# Accounts and sign-in

An empty app asks for its first administrator. Others register and wait for an administrator's approval before they
can sign in, and each account sees only its own tasks.

## Sub-features

- `setup` creates the first administrator on an empty data directory.
- `register` submits a registration that is not yet allowed to sign in.
- `approve` lets an administrator approve a pending registration at `/#/admin`.
- `sign-in` signs an approved account in; a wrong password is refused in place.
- `isolation` shows a new account none of the administrator's tasks.

## How to get to it (user POV)

- Open `/#/tasks` on an empty app: the 创建管理员 form.
- On the sign-in form: 没有账号？注册.
- As administrator: `/#/admin`, the row of the pending account, 批准.

## Driving it with verify.sh

Preconditions: a fresh run, so the data directory is empty. No ERP double is needed (`export const fake = null`).

- **Setup.** `page.goto('/#/tasks')`, fill `getByLabel('用户名')` and `getByLabel('密码')`, click
  `getByRole('button', { name: '创建管理员' })`. `getByRole('banner')` contains 管理员.
- **Register.** Click 退出登录, then `getByRole('button', { name: '没有账号？注册' })`, fill the same two labels and click
  `getByRole('button', { name: '注册', exact: true })`. The text 注册申请已提交，请等待管理员批准后再登录。 appears.
- **Refused before approval.** Sign in as the new user. The text 这个账号正在等待管理员批准。 appears.
- **Approve.** Sign in as `admin` and open `/#/admin`. In `getByTestId('account-row-<username>')` click 批准.
  `getByRole('status')` contains 已批准.
- **Isolation.** Sign in as the new user. The heading 还没有报销任务 shows even when the administrator has tasks.
- **Proof.** Screenshot after each step, plus `v.api.get('/api/session')` saved via `writeFileSync` into `v.out`.

## Gotchas

- `v.signIn()` uses `/api/auth/setup`, so it only works once per run. A second account needs the register and approve
  path.
- The shipped `new-task-upload` scenario covers `setup` on the page; the others have no scenario yet.
