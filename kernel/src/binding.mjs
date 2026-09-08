import fs from 'node:fs';
import path from 'node:path';
import { paths, ensureDir } from './paths.mjs';
import { probeIdentity, ERP_ORIGIN } from './probe.mjs';

/**
 * 个人绑定：这台机器上的 baox 认哪一个 ERP 身份。
 *
 * 它替代了原来的 `--expect <名字>`。那条路有三处是坏的：
 *   1. 比的东西对不上 —— 真机上显示名是「刘明建」、账号是 `luo.liu`，
 *      用户会打前者，说明书的例子写的是后者，两边都可能不匹配；
 *   2. 任一命中即通过 —— localStorage 里的账号在登出后仍然留着（见 ADR-0002 补记），
 *      "账号命中"能在会话已经失效时误判为通过；
 *   3. 那个字符串是模型转述的 —— 报销主体错了，发票就写进了别人的单子，不可撤销。
 *
 * 所以绑定只在**内核自己渲染的那份东西**上产生：上面的每个值都是内核刚从 ERP 读到的，
 * 用户只能认或不认，全程没有字符串经过模型的手。
 *
 * 第一次认身份走**终端表格**（`next` 的 `confirm_table`，落盘在 confirm.mjs 的
 * receiveIdentity 里）。本地确认页只留给**改绑** —— 那是一次推翻已有绑定的动作，
 * 值得一次要人手敲 `confirm-identity` 的显式往返。
 *
 * 判据是 account + tenant，不含 displayName —— 显示名在 ERP 里可改，
 * 拿它当判据等于把门栓拴在一个别人能拧的东西上。它只留着给用户看，
 * 因为那是用户唯一认得出来的东西。tenant 要一起比：换账套等于换一整套主数据。
 */
const bindingPath = () => path.join(paths.root, 'identity.json');

// 排障用的旁路。做成环境变量而不是命令行开关：模型写不出它，
// 它只会出现在人手敲的那一行里，而且每一次输出都把它标出来。
export const SKIP_ENV = 'BAOX_SKIP_IDENTITY_CHECK';
export const skipping = () => process.env[SKIP_ENV] === '1';

export function readBinding() {
  try { return JSON.parse(fs.readFileSync(bindingPath(), 'utf8')); } catch { return null; }
}

const persistBinding = (record) => {
  ensureDir(paths.root);
  const tmp = `${bindingPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, bindingPath());
  return record;
};

export function writeBinding(identity) {
  return persistBinding({
    account: identity.account, tenant: identity.tenant,
    displayName: identity.displayName ?? null,          // 只展示，不作判据
    confirmedAt: new Date().toISOString(),
  });
}

export const validHomeCity = (value) => typeof value === 'string'
  && value.trim().length > 0 && value.trim().length <= 20
  && value.trim() !== '暂不确认'
  && !/[\u0000-\u001f\u007f]/.test(value);

export function writeHomeCity(identity, homeCity) {
  if (!validHomeCity(homeCity)) return null;
  const binding = readBinding();
  if (bindingVerdict(binding, identity) !== 'matched') return null;
  return persistBinding({
    ...binding,
    homeCity: homeCity.trim(),
    homeCityConfirmedAt: new Date().toISOString(),
  });
}

/**
 * 纯函数：绑定和当前登录身份对得上吗。
 *   unbound —— 这台机器还没确认过身份；
 *   incomplete —— 当前登录读不出 account 或 tenant，凑不成一个可比的身份；
 *   matched / mismatched。
 */
export function bindingVerdict(binding, identity) {
  if (!identity?.account || !identity?.tenant) return 'incomplete';
  if (!binding) return 'unbound';
  return binding.account === identity.account && binding.tenant === identity.tenant
    ? 'matched' : 'mismatched';
}

/**
 * 身份闸。会话信号先过（probeIdentity），再过个人绑定。
 *
 * 返回的 status 是**合并后的最终结论** —— matched 意味着"会话有效**且**是绑定的那个人"。
 * 调用方一律只认 matched，别的一概硬阻塞：多一档"看情况"就是多一条把发票写进
 * 别人单子里的路。
 */
export async function gateIdentity({ origin = ERP_ORIGIN, waitMs } = {}) {
  const probe = await probeIdentity(waitMs === undefined ? { origin } : { origin, waitMs });
  if (probe.status !== 'matched') return probe;

  const binding = readBinding();
  const verdict = bindingVerdict(binding, probe.identity);
  if (verdict === 'matched') return { ...probe, binding };

  if (skipping()) {
    // 旁路只在这里生效，而且必须在输出里留下痕迹：一份看不出自己被旁路过的
    // 记录，比没有记录更糟。
    return { ...probe, binding, bindingVerdict: verdict, identityCheckSkipped: SKIP_ENV };
  }

  if (verdict === 'incomplete') {
    return { ...probe, status: 'identity_incomplete', binding,
      hint: 'ERP 页面上读不出登录账号或账套（localStorage 的 k3cloudloginInfo 不完整），'
        + '身份凑不成一个可比的东西。请在专用 Chrome 里重新登录一次再试' };
  }
  if (verdict === 'unbound') {
    return { ...probe, status: 'identity_unconfirmed', binding: null,
      hint: '这台机器还没确认过报销人是谁。跑 baox next，内核会在终端上摆一张表，'
        + '上面是它自己从 ERP 读到的身份，你认下来它才落盘' };
  }
  return { ...probe, status: 'identity_mismatched', binding,
    hint: `这台机器绑定的是 ${binding.displayName ?? binding.account}（账号 ${binding.account}，`
      + `账套 ${binding.tenant}），ERP 当前登录的是 ${probe.identity.displayName}`
      + `（账号 ${probe.identity.account}，账套 ${probe.identity.tenant}）。`
      + 'baox 只替绑定的那个人报销：请在专用 Chrome 里换回本人登录。'
      + '确实要把这台机器改绑到当前这个身份，跑 baox confirm-identity（没有进行中的任务时才允许改）' };
}
