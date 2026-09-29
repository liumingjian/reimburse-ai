import { describe, expect, it } from 'vitest';
import { createSwitchDialog, type SwitchWindows } from './switch-dialog';

// The switch question (#292) at its seam with `chrome.windows`: which window it opens, and which answers settle it.

const PAGE = 'chrome-extension://abc/switch.html';

function fakeWindows() {
  const created: string[] = [];
  const removed: number[] = [];
  const closeListeners: ((windowId: number) => void)[] = [];
  const windows: SwitchWindows = {
    create: async ({ url }) => {
      created.push(url);
      return { id: created.length };
    },
    remove: async (windowId) => void removed.push(windowId),
    onRemoved: { addListener: (listener) => void closeListeners.push(listener) },
  };
  const close = (windowId: number) => closeListeners.forEach((listener) => listener(windowId));
  return { windows, created, removed, close };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const idOf = (url: string) => new URLSearchParams(url.split('?')[1]).get('id');

describe('the switch question', () => {
  it('opens its own page naming the current account, and settles with the answer that page sends', async () => {
    const { windows, created, removed } = fakeWindows();
    const dialog = createSwitchDialog({ windows, pageUrl: PAGE });

    const answer = dialog.confirm({ accountId: 'a2', username: 'bob' });
    await settle();
    expect(created).toHaveLength(1);
    expect(created[0]?.startsWith(`${PAGE}?`)).toBe(true);
    expect(new URLSearchParams(created[0]?.split('?')[1]).get('account')).toBe('bob');

    expect(dialog.answer({ kind: 'switch_answer', id: idOf(created[0] ?? ''), accepted: true }, `${PAGE}?id=1&account=bob`)).toBe(true);
    await expect(answer).resolves.toBe(true);
    expect(removed).toEqual([1]);
  });

  it('names the account by its id when the app gave no username', async () => {
    const { windows, created } = fakeWindows();
    void createSwitchDialog({ windows, pageUrl: PAGE }).confirm({ accountId: 'a2', username: null });
    await settle();
    expect(new URLSearchParams(created[0]?.split('?')[1]).get('account')).toBe('a2');
  });

  it('reads a closed window as no', async () => {
    const { windows, close } = fakeWindows();
    const answer = createSwitchDialog({ windows, pageUrl: PAGE }).confirm({ accountId: 'a2', username: 'bob' });
    await settle();
    close(1);
    await expect(answer).resolves.toBe(false);
  });

  it('takes answers only from its own page, and only for the open question', async () => {
    const { windows, created } = fakeWindows();
    const dialog = createSwitchDialog({ windows, pageUrl: PAGE });
    let settled: boolean | null = null;
    void dialog.confirm({ accountId: 'a2', username: 'bob' }).then((value) => (settled = value));
    await settle();
    const id = idOf(created[0] ?? '');

    expect(dialog.answer({ kind: 'switch_answer', id, accepted: true }, 'http://10.250.0.222:8888/#/settings')).toBe(false);
    expect(dialog.answer({ kind: 'switch_answer', id, accepted: true }, 'chrome-extension://abc/popup.html')).toBe(false);
    expect(dialog.answer({ kind: 'switch_answer', id, accepted: true }, undefined)).toBe(false);
    expect(dialog.answer({ kind: 'switch_answer', id: 'stale', accepted: true }, PAGE)).toBe(true);
    await settle();
    expect(settled).toBeNull();
  });

  it('declines a question still open when a newer one is asked', async () => {
    const { windows, created, removed } = fakeWindows();
    const dialog = createSwitchDialog({ windows, pageUrl: PAGE });
    const first = dialog.confirm({ accountId: 'a2', username: 'bob' });
    await settle();
    const second = dialog.confirm({ accountId: 'a2', username: 'bob' });
    await expect(first).resolves.toBe(false);
    expect(removed).toEqual([1]);
    await settle();
    dialog.answer({ kind: 'switch_answer', id: idOf(created[1] ?? ''), accepted: true }, PAGE);
    await expect(second).resolves.toBe(true);
  });
});
