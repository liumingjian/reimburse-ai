/**
 * `baox next`：把状态判定的结论翻成模型唯一要做的那一件事。
 *
 * 模型在整个流程里只调两条命令 —— 问（`next --dir`）和答（`next --after`）。
 * 它不选命令、不拼命令、不组织措辞：`step.argv` 是内核给的完整命令行，
 * `speak` 是内核写死的原话。措辞是模型差异最大的地方，所以不交给模型。
 *
 * 这一批只落成环境七态和 `run` / `tell_user` / `done` 三种 step；
 * 其余四种（read_images / ask_user / confirm_table / dispute）随各自的状态一起来。
 */
import path from 'node:path';
import url from 'node:url';
import { determineState, SCHEMA_VERSION, MIN_NODE_MAJOR } from './state.mjs';
import { currentStep, issueStep } from './steptoken.mjs';

/** 内核自己的入口。argv 里给绝对路径：模型原样执行，不需要知道 baox 装在哪。 */
const BIN = path.join(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))), 'bin', 'baox.mjs');
const argvFor = (...args) => [process.execPath, BIN, ...args];

const ENV_PROGRESS = { phase: 1, of: 10, label: '环境准备' };

// 退出码：0 继续 / 2 有硬阻塞，未解决不得继续。硬阻塞是那些「等下去也不会好」的：
// Node 太老、数据格式太新、登错了人。停在登录页不是硬阻塞 —— 那是在等人，不是被拦住。
const BLOCKED = 2;

/**
 * 状态 -> step + 原话。纯函数：同一个状态加同一份观测，永远得到同一句话。
 */
export function stepFor(state, observation = {}) {
  const o = observation;
  const who = o.probe?.identity?.displayName ?? o.probe?.identity?.account ?? null;
  const bound = o.binding?.displayName ?? o.binding?.account ?? null;

  switch (state) {
    case 'schema_too_new':
      return {
        step: { kind: 'tell_user' },
        speak: '这台机器上的报销数据是更新版本的 baox 写的，我这一版读不了，'
          + '硬来只会把数据弄坏。请先把 baox 升到新版，我们再继续。',
        context: `数据目录里记的格式版本是 ${o.schemaVersion}，这个内核只认到 ${SCHEMA_VERSION}。`
          + '版本闸看的是数据格式，不是代码版本号。',
        progress: null,
        exit: BLOCKED,
      };

    case 'env_node_unsupported':
      return {
        step: { kind: 'tell_user' },
        speak: `你这台机器上的 Node 是 ${o.nodeVersion ?? o.nodeMajor}，baox 需要 ${MIN_NODE_MAJOR} 或更高。`
          + '装好新版 Node 之后跟我说一声，我接着往下走。',
        context: '内核用 Node 内建的全局 WebSocket 和 Chrome 通信，21 以下的 Node 没有这个东西。',
        progress: ENV_PROGRESS,
        exit: BLOCKED,
      };

    case 'env_chrome_down':
      return {
        step: { kind: 'run', argv: argvFor('chrome-up') },
        speak: '我先把 baox 专用的 Chrome 打开。它有自己独立的 profile，'
          + '和你平时用的那个 Chrome 互不影响，也不会碰你日常的浏览记录。',
        context: '专用 Chrome 上开着一个只在本机回环地址上监听的调试端口，'
          + '它只指向 baox 自己的 profile，绝不指向你日常的 Chrome。',
        progress: ENV_PROGRESS,
        exit: 0,
      };

    case 'env_not_logged_in':
      return {
        step: { kind: 'tell_user' },
        speak: '请你在刚打开的那个 baox 专用 Chrome 窗口里，用你本人的账号登录 ERP。'
          + '我不会替你填账号密码。登进主界面之后告诉我一声，我接着往下走。',
        context: 'ERP 的登录页和主控制台是同一个网址，所以我按页面上有没有登录表单来判断。'
          + '另外登录页上也读得出你上次登录的账号，那不算已登录。',
        progress: ENV_PROGRESS,
        exit: 0,
      };

    case 'env_identity_unknown':
      return {
        step: { kind: 'tell_user' },
        speak: '我读不出那个专用 Chrome 窗口里现在是谁登录着。麻烦你看一眼这个窗口：'
          + '停在登录页就登录一下，页面卡着就刷新一下，弄好了告诉我。'
          + '身份读不确定我就不往下走 —— 报销主体错了是不可撤销的。',
        context: '探针只读页面上已有的信息，不导航、不点击。'
          + '现在的情况是页面加载没完成、或者读不出用户名又看不见登录表单。',
        progress: ENV_PROGRESS,
        exit: 0,
      };

    case 'env_identity_unbound':
      return {
        // 绑定只在确认页上产生：页面展示的是内核自己从 ERP 读到的值，
        // 用户点一次「是我本人」才落盘 —— 全程没有字符串经过模型的手。
        step: { kind: 'run', argv: argvFor('confirm-identity') },
        speak: `这台机器还没记下我在替谁报销。我这就打开一个本地确认页，`
          + `上面是我刚从 ERP 读到的身份${who ? `（${who}）` : ''}，`
          + '你核对一下，是本人就点「是我本人」。只有那一次点击算数。',
        context: '绑定判据是登录账号加账套，不含显示名 —— 显示名在 ERP 里改得动，'
          + '拿它当门栓等于把门栓拴在别人能拧的东西上。',
        progress: ENV_PROGRESS,
        exit: 0,
      };

    case 'env_identity_mismatched':
      return {
        step: { kind: 'tell_user' },
        speak: `这台机器绑定的是 ${bound}，但 ERP 现在登录的是 ${who}。`
          + 'baox 只替绑定的那个人报销，请在专用 Chrome 里换回本人的账号登录。'
          + '确实要把这台机器改绑到当前这个身份，得先把手上的任务走完或作废。',
        context: '判据是登录账号加账套。换账套等于换一整套主数据，也算换了人。'
          + '中途换人会把一份报销记在两个人头上，所以这里是硬阻塞。',
        progress: ENV_PROGRESS,
        exit: BLOCKED,
      };

    case 'env_ready':
      return {
        step: { kind: 'done' },
        speak: `环境准备好了：专用 Chrome 开着，ERP 登录着${who ? `，当前替 ${who} 报销` : ''}。`
          + '接下来就可以开始处理报销材料了。',
        context: '这一步之后不需要你再打开任何浏览器页面，除非要改绑身份或者浏览项目目录。',
        progress: ENV_PROGRESS,
        exit: 0,
      };

    default:
      // 状态落成了却没给它写 step，是内核自己的 bug，不能装作没看见。
      throw new Error(`状态 ${state} 还没有对应的 step`);
  }
}

/**
 * 一次 `next` 的完整应答：观测 -> 状态 -> step，中间过一道凭据核对。
 *
 * 状态永远来自**这一次的观测**，不来自模型的自述：模型说「做完了」不推进状态，
 * 推进的依据是内核自己看得见的事实。所以 `--result` 在这里不被解读，
 * 它只是「你确实跑了那条命令」的凭证。
 */
export function nextResponse({ observation, sourceKey, after = null, hasResult = false }) {
  const verdict = determineState(observation);
  const shaped = stepFor(verdict.state, observation);

  // 凭据核对。两种「不算数」的回传，处置完全一样：忽略回传，重发当前步骤。
  let ignored = null;
  if (after !== null) {
    const outstanding = currentStep(sourceKey);
    if (!outstanding || outstanding.token !== after) {
      ignored = { reason: 'stale_token',
        note: '这个凭据不是我现在挂着的那一个（多半是上一步的），我按当前状态重发一次' };
    } else if (outstanding.state !== verdict.state) {
      // 状态已经往前走了，这个凭据自然作废。不是错，就是这一步过去了。
      ignored = null;
    } else if (shaped.step.kind === 'run' && !hasResult) {
      ignored = { reason: 'no_result',
        note: '这一步要的是命令的实际输出，没有输出就没有事实，状态不动' };
    }
  }

  const record = issueStep(sourceKey, verdict.state);
  const identity = observation.probe?.status === 'matched'
    ? { displayName: observation.probe.identity.displayName ?? null,
        account: observation.probe.identity.account ?? null }
    : (observation.binding
      ? { displayName: observation.binding.displayName ?? null, account: observation.binding.account ?? null }
      : null);

  return {
    command: 'next',
    schemaVersion: SCHEMA_VERSION,
    identity,
    task: null,                       // 任务主干（B 表）还没落成，环境这一段还谈不上任务
    state: verdict.state,
    progress: shaped.progress,
    actor: verdict.actor,
    stepToken: record.token,
    step: shaped.step,
    speak: shaped.speak,
    context: shaped.context,
    blockedBy: verdict.blockedBy,
    ...(ignored ? { ignored } : {}),
    exit: shaped.exit,
  };
}
