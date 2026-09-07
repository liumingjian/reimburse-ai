/**
 * 状态判定：**纯函数**。入参是一个已经采集好的观测对象，
 * 不读文件、不发请求、不碰浏览器（采集在 observe.mjs 里）。
 *
 * 分层是硬要求，不是风格：状态判定的测试要能在一台没有 Chrome、
 * 没有材料目录、没登录过 ERP 的机器上跑完。判断被钉住了，取数才谈得上可换。
 *
 * 判据一字不改地照 docs/design/state-machine.md 的两张表。这一批只落成
 * A 表（环境七态）和永远排在最前的 schema_too_new；B 表的任务主干状态
 * 按同样的方式往 RULES 后面接。
 */
import { bindingVerdict } from './binding.mjs';

/** 数据目录的格式版本。它才是版本闸的判据 —— 该判的是数据格式，不是代码版本。 */
export const SCHEMA_VERSION = 1;

/** 内核用 Node 内建的全局 WebSocket 走 CDP，21 以下没有。 */
export const MIN_NODE_MAJOR = 21;

/**
 * 判定顺序就是这张表的顺序：同时满足多个判据时，越靠前的先报。
 * `schema_too_new` 永远最先 —— 数据格式比内核新的时候，后面每一条判据
 * 都是拿旧眼睛看新数据，判出来的东西不作数。
 */
const RULES = [
  {
    state: 'schema_too_new',
    actor: 'user',
    when: (o) => (o.schemaVersion ?? SCHEMA_VERSION) > SCHEMA_VERSION,
    blocker: (o) => ({ kind: 'schema_too_new', resolvableBy: 'user',
      hint: `数据目录的格式版本是 ${o.schemaVersion}，这个内核只认到 ${SCHEMA_VERSION}；先升级 baox` }),
  },
  {
    state: 'env_node_unsupported',
    actor: 'user',
    when: (o) => o.nodeMajor < MIN_NODE_MAJOR,
    blocker: (o) => ({ kind: 'node_unsupported', resolvableBy: 'user',
      hint: `当前 Node 是 ${o.nodeVersion ?? o.nodeMajor}，内核要 ${MIN_NODE_MAJOR} 及以上` }),
  },
  {
    state: 'env_chrome_down',
    actor: 'kernel',
    when: (o) => !o.cdpUp,
  },
  {
    state: 'env_not_logged_in',
    actor: 'user',
    when: (o) => o.probe?.status === 'not_logged_in',
    blocker: () => ({ kind: 'not_logged_in', resolvableBy: 'user',
      hint: '专用 Chrome 里的 ERP 停在登录页；只有你本人能登，baox 不代填账号密码' }),
  },
  {
    // 页面加载中、读不出且没有登录表单、专用 Chrome 里根本没开着 ERP，
    // 以及读出了人但凑不出可比身份（account/tenant 缺一）：
    // 都是「探针给不出确定结论」，都要人看一眼那个窗口，重试解决不了。
    state: 'env_identity_unknown',
    actor: 'user',
    when: (o) => ['loading', 'unknown', 'no_tab'].includes(o.probe?.status)
      || (o.probe?.status === 'matched' && bindingVerdict(o.binding, o.probe.identity) === 'incomplete'),
    blocker: (o) => ({ kind: 'identity_unknown', resolvableBy: 'user',
      hint: o.probe?.status === 'no_tab'
        ? '专用 Chrome 里没有开着 ERP 的页面；请在那个窗口里打开 ERP'
        : '读不出当前登录的是谁，也看不见登录表单；请人工看一眼那个 Chrome 窗口' }),
  },
  {
    state: 'env_identity_unbound',
    actor: 'user',
    when: (o) => o.probe?.status === 'matched' && bindingVerdict(o.binding, o.probe.identity) === 'unbound',
  },
  {
    state: 'env_identity_mismatched',
    actor: 'user',
    when: (o) => o.probe?.status === 'matched' && bindingVerdict(o.binding, o.probe.identity) === 'mismatched',
    blocker: (o) => ({ kind: 'identity_mismatched', resolvableBy: 'user',
      hint: `这台机器绑定的是 ${o.binding.displayName ?? o.binding.account}，`
        + `ERP 当前登录的是 ${o.probe.identity.displayName ?? o.probe.identity.account}；`
        + 'baox 只替绑定的那个人报销' }),
  },
];

/**
 * 观测 -> { state, actor, blockedBy }。
 * `blockedBy` 是结构化开放项，每项含 kind / materialId / hint / resolvableBy。
 */
export function determineState(observation) {
  const o = observation ?? {};
  for (const rule of RULES) {
    if (!rule.when(o)) continue;
    const blocker = rule.blocker?.(o);
    return {
      state: rule.state,
      actor: rule.actor,
      blockedBy: blocker ? [{ materialId: null, ...blocker }] : [],
    };
  }
  // A 表全过。任务主干（B 表）还没落成，到这里就是环境就绪。
  // actor 是 null 而不是三种角色之一 —— 照表：env_ready 没有人要动手。
  return { state: 'env_ready', actor: null, blockedBy: [] };
}

/** 判定顺序本身是可测的事实，测试直接读它，不靠复述。 */
export const STATE_ORDER = RULES.map((r) => r.state).concat('env_ready');
