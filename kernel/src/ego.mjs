import { spawn } from 'node:child_process';

/**
 * The only browser transport used by the kernel. The task space is persistent
 * across invocations, while each command is a short-lived Node heredoc run.
 */
export const EGO_COMMAND = process.env.BAOX_EGO_BROWSER || 'ego-browser';
// The host provisions a persistent task space and passes its id explicitly.
// Numeric ids must reach the helper as numbers: a string such as "1" can be
// treated as a name and create a second space when the id is absent.
const configuredTaskSpace = process.env.BAOX_EGO_TASK_SPACE?.trim() || null;
export const EGO_TASK_SPACE = configuredTaskSpace === null ? null
  : (/^\d+$/.test(configuredTaskSpace) ? Number(configuredTaskSpace) : configuredTaskSpace);
export const EGO_RESULT_PREFIX = '__BAOX_EGO_RESULT__';

const DEFAULT_TIMEOUT_MS = 45_000;

const requireTaskSpace = () => {
  if (EGO_TASK_SPACE !== null) return;
  const error = new Error('未配置 ego task space。请先在 ego-browser 中创建或确认持久 task space，记录数字 id，再以 BAOX_EGO_TASK_SPACE=<id> 运行 baox');
  error.code = 'EGO_TASK_SPACE_REQUIRED';
  throw error;
};

export const safeUrl = (value) => {
  const raw = String(value ?? '');
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return raw.split(/[?#]/, 1)[0];
  }
};

const selectedFields = (tab) => ({
  id: tab?.targetId ?? tab?.id ?? tab?.tabId ?? null,
  url: safeUrl(tab?.url),
  title: tab?.title ?? null,
});

const scriptFor = (body) => `
try {
  const __safeUrl = (value) => {
    const raw = String(value ?? '');
    try {
      const parsed = new URL(raw);
      return parsed.origin + parsed.pathname;
    } catch {
      return raw.split(/[?#]/, 1)[0];
    }
  };
  const __task = await useOrCreateTaskSpace(${JSON.stringify(EGO_TASK_SPACE)});
  const __value = await (async () => {
${body}
  })();
  cliLog(${JSON.stringify(EGO_RESULT_PREFIX)} + JSON.stringify({ ok: true, value: __value }));
} catch (__error) {
  cliLog(${JSON.stringify(EGO_RESULT_PREFIX)} + JSON.stringify({ ok: false, error: {
    name: __error?.name ?? 'Error', message: __error?.message ?? String(__error),
    code: __error?.code ?? null,
  } }));
}
`;

/**
 * Run one ego-browser Node script through stdin. This is deliberately a
 * process boundary: no page operation is available to the kernel process
 * itself, and no Chrome/CDP endpoint can be passed around as a page handle.
 */
export function runEgoScript(body, { timeoutMs = DEFAULT_TIMEOUT_MS, command = EGO_COMMAND } = {}) {
  if (typeof body !== 'string' || !body.trim()) throw new TypeError('ego script must be non-empty');
  requireTaskSpace();
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      const error = new Error(`ego-browser 超过 ${timeoutMs}ms 没有返回`);
      error.code = 'EGO_TIMEOUT';
      reject(error);
    }, timeoutMs);
    timer.unref();

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish(reject, error));
    child.once('close', (code, signal) => {
      // ego-browser's cliLog currently writes to stderr. Only consume lines
      // carrying our marker; never surface arbitrary CLI output to callers.
      const line = `${stdout}\n${stderr}`.split(/\r?\n/).reverse()
        .find((candidate) => candidate.includes(EGO_RESULT_PREFIX));
      if (!line) {
        const error = new Error(`ego-browser 未返回受控结果（code=${code}, signal=${signal}）`);
        error.code = code === 127 ? 'EGO_NOT_FOUND' : 'EGO_PROTOCOL_ERROR';
        finish(reject, error);
        return;
      }
      let result;
      try {
        const markerAt = line.indexOf(EGO_RESULT_PREFIX);
        result = JSON.parse(line.slice(markerAt + EGO_RESULT_PREFIX.length));
      }
      catch (error) {
        error.message = `ego-browser 返回结果不是 JSON：${error.message}`;
        error.code = 'EGO_PROTOCOL_ERROR';
        finish(reject, error);
        return;
      }
      if (!result.ok) {
        const error = new Error(result.error?.message || 'ego-browser 脚本失败');
        error.name = result.error?.name || 'EgoError';
        error.code = result.error?.code || 'EGO_SCRIPT_ERROR';
        finish(reject, error);
        return;
      }
      finish(resolve, result.value);
    });
    child.stdin.end(scriptFor(body));
  });
}

export const isEgoPage = (page) => page?.transport === 'ego'
  && EGO_TASK_SPACE !== null && page.taskSpace === EGO_TASK_SPACE && !!page.tabId;

export const egoPage = ({ tabId, id, targetId, url = null, title = null } = {}) => {
  requireTaskSpace();
  return {
    transport: 'ego', taskSpace: EGO_TASK_SPACE,
    tabId: targetId ?? tabId ?? id, url: safeUrl(url), title,
  };
};

export async function listEgoTabs() {
  const tabs = await runEgoScript('return (await listTabs()).map((tab) => ({ targetId: tab.targetId, id: tab.id, url: __safeUrl(tab.url), title: tab.title }));');
  return tabs.map(selectedFields);
}

/** Evaluate in a selected real tab through the ego helper `js()`. */
export async function evaluateEgoPage(page, expression, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!isEgoPage(page)) {
    const error = new Error('ERP 页面句柄不是 ego task-space page context');
    error.code = 'EGO_PAGE_REQUIRED';
    throw error;
  }
  if (typeof expression !== 'string' || !expression.trim()) throw new TypeError('page expression must be non-empty');
  return runEgoScript(`
const tabs = await listTabs();
const tab = tabs.find((candidate) => (candidate.targetId ?? candidate.id) === ${JSON.stringify(page.tabId)});
if (!tab) throw new Error('ego task space 中找不到目标页面');
await switchTab(tab.targetId ?? tab.id);
return await js(${JSON.stringify(expression)});
`, { timeoutMs });
}

export async function openEgoTab(url, { wait = true, timeoutSeconds = 30 } = {}) {
  const tab = await runEgoScript(`const tab = await openOrReuseTab(${JSON.stringify(url)}, {
  wait: ${wait === true}, timeout: ${Number(timeoutSeconds)},
});
return { targetId: tab?.targetId, id: tab?.id, tabId: tab?.tabId,
  url: __safeUrl(tab?.url), title: tab?.title };`);
  return egoPage(tab);
}

export async function closeEgoTab(tabId) {
  if (!tabId) throw new TypeError('ego tab id is required');
  return runEgoScript(`
await closeTab(${JSON.stringify(tabId)});
return !(await listTabs()).some((tab) => (tab.targetId ?? tab.id) === ${JSON.stringify(tabId)});
`);
}

export const egoRequiredError = (operation) => {
  const error = new Error(`${operation} 尚未迁移到 ego-browser；旧 Chrome/CDP 路径已阻塞`);
  error.code = 'EGO_REQUIRED';
  return error;
};

export const isEgoControlError = (error) => {
  const text = `${error?.code ?? ''} ${error?.message ?? error ?? ''}`.toLowerCase()
    .replace(/[_-]+/g, ' ');
  return /user\s*(?:is\s+)?controll|user\s*owned|not\s*assigned(?:\s+to\s+an\s+agent)?|inactive\s+task\s+space|task\s+space\s+.*(?:inactive|unassigned)|ownership/.test(text);
};
