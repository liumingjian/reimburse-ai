import type { SwitchAnswer } from './switch-dialog';

// The switch question's page (#292), opened by the service worker in a window of its own (`switch-dialog.ts`). It
// names the account the extension acts for now, which the service worker put in the query, and sends the answer back.

const SWITCH_COPY = {
  current: (account: string) => `这台浏览器里的报销助手现在替账号「${account}」报销。`,
  consequence: (account: string) => `刚才的设置页登录的是另一个账号。换过去之后，「${account}」要重新配对，才能再用这台浏览器报销。`,
  accept: '换成设置页的账号',
  keep: (account: string) => `继续替「${account}」报销`,
} as const;

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`switch page is missing #${id}`);
  return found as T;
};

const query = new URLSearchParams(location.search);
const id = query.get('id') ?? '';
const account = query.get('account') ?? '';

el('current').textContent = SWITCH_COPY.current(account);
el('consequence').textContent = SWITCH_COPY.consequence(account);
const accept = el<HTMLButtonElement>('accept');
const keep = el<HTMLButtonElement>('keep');
accept.textContent = SWITCH_COPY.accept;
keep.textContent = SWITCH_COPY.keep(account);

async function answer(accepted: boolean): Promise<void> {
  accept.disabled = true;
  keep.disabled = true;
  const reply: SwitchAnswer = { kind: 'switch_answer', id, accepted };
  // The service worker closes this window once it has the answer; closing it here too covers a worker that is gone.
  await (chrome.runtime.sendMessage(reply) as unknown as Promise<unknown>).catch(() => undefined);
  window.close();
}

accept.addEventListener('click', () => void answer(true));
keep.addEventListener('click', () => void answer(false));
keep.focus();
