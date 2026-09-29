import type { ConfirmSwitch } from './pairing-requests';

// The question an employee answers before one-click pairing moves this extension from one 应用账号 (app account) to
// another (#292), for instance on a shared computer. The extension owns it: a service worker cannot call `confirm()`,
// and a dialog the baox page drew could be drawn, or answered, by the page itself. So the service worker opens
// `switch.html` in a small window of its own, and that page sends the answer back over runtime messaging.
//
// One question is open at a time; a newer one (a second tab asking) declines the older. Closing the window declines.
// The open question lives in the service worker's memory. The other account's channel heartbeat keeps the worker up
// while the employee reads; a worker Chrome stops anyway loses the question, and the page, answered by nobody, falls
// back to the manual flow.
// The chrome APIs are injected so this runs in a test without a browser.

/** The page this file opens, relative to the extension's root; `build.mjs` copies it into the package. */
export const SWITCH_PAGE = 'switch.html';

/** What `switch.html` sends the service worker: the answer to question `id`. */
export type SwitchAnswer = { kind: 'switch_answer'; id: string; accepted: boolean };

/** The slice of `chrome.windows` the question uses. */
export type SwitchWindows = {
  create(options: { url: string; type: 'popup'; width: number; height: number; focused: boolean }): Promise<{ id?: number }>;
  remove(windowId: number): Promise<void>;
  onRemoved: { addListener(listener: (windowId: number) => void): void };
};

export type SwitchDialogOptions = {
  windows: SwitchWindows;
  /** The full URL of SWITCH_PAGE (`chrome.runtime.getURL`): where it is opened, and the only sender answers come from. */
  pageUrl: string;
};

export type SwitchDialog = {
  confirm: ConfirmSwitch;
  /**
   * Takes a runtime message if it came from SWITCH_PAGE, and returns whether it did, so the service worker answers
   * nothing else to it. Only an answer to the open question settles it.
   */
  answer(message: unknown, senderUrl: string | undefined): boolean;
};

type Question = { id: string; windowId: number | null; settle: (accepted: boolean) => void };

export function createSwitchDialog({ windows, pageUrl }: SwitchDialogOptions): SwitchDialog {
  let open: Question | null = null;
  let asked = 0;

  function finish(accepted: boolean): void {
    const question = open;
    if (!question) return;
    open = null;
    question.settle(accepted);
    if (question.windowId !== null) void windows.remove(question.windowId).catch(() => undefined);
  }

  windows.onRemoved.addListener((windowId) => {
    if (open?.windowId === windowId) finish(false);
  });

  const confirm: ConfirmSwitch = (current) => {
    finish(false);
    asked += 1;
    const id = String(asked);
    return new Promise((settle) => {
      const question: Question = { id, windowId: null, settle };
      open = question;
      const url = `${pageUrl}?${new URLSearchParams({ id, account: current.name }).toString()}`;
      windows.create({ url, type: 'popup', width: 440, height: 300, focused: true }).then(
        (created) => {
          if (open === question) question.windowId = created.id ?? null;
          else if (created.id !== undefined) void windows.remove(created.id).catch(() => undefined);
        },
        () => {
          if (open === question) finish(false);
        },
      );
    });
  };

  function answer(message: unknown, senderUrl: string | undefined): boolean {
    if (!senderUrl || withoutQuery(senderUrl) !== pageUrl) return false;
    const reply = message as Partial<SwitchAnswer> | null;
    if (reply?.kind === 'switch_answer' && typeof reply.accepted === 'boolean' && open?.id === reply.id) finish(reply.accepted);
    return true;
  }

  return { confirm, answer };
}

// By hand rather than through `URL`: a chrome-extension: URL has an opaque origin outside the browser.
const withoutQuery = (url: string): string => url.split(/[?#]/, 1)[0] ?? '';
