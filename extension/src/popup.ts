import { EXTENSION_PAIRING_CODE_LENGTH, EXTENSION_VERSION } from '@baox/contract';
import type { PopupAnswer } from './service-worker';

// The popup. One field: the 配对码 (pairing code). There is deliberately no server address here — see `origin.ts`.

// The static labels live in `popup.html`; these are the ones the script swaps in.
const POPUP_COPY = {
  pair: '配对',
  pairing: '正在配对…',
  paired: '已经和你的账号配对，可以去报销了。',
  connecting: '正在连接应用…',
  offline: '连不上应用。会自动重试；请确认你在公司网络里，应用也开着。',
  notPaired: '还没有配对。',
  version: '扩展版本',
} as const;

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`popup is missing #${id}`);
  return found as T;
};

const form = el<HTMLFormElement>('pair-form');
const codeInput = el<HTMLInputElement>('code');
const pairButton = el<HTMLButtonElement>('pair');
const unpairButton = el<HTMLButtonElement>('unpair');
const statusLine = el<HTMLParagraphElement>('status');
const errorLine = el<HTMLParagraphElement>('error');
const versionLine = el<HTMLParagraphElement>('version');

codeInput.maxLength = EXTENSION_PAIRING_CODE_LENGTH * 2;
versionLine.textContent = `${POPUP_COPY.version} ${EXTENSION_VERSION}`;

function describe(answer: PopupAnswer): string {
  if (!answer.paired) return POPUP_COPY.notPaired;
  switch (answer.status?.state) {
    case 'ready':
      return POPUP_COPY.paired;
    case 'refused':
      return answer.status.message;
    case 'offline':
      return POPUP_COPY.offline;
    default:
      return POPUP_COPY.connecting;
  }
}

function render(answer: PopupAnswer): void {
  statusLine.textContent = describe(answer);
  errorLine.textContent = answer.error ?? '';
  form.hidden = answer.paired;
  unpairButton.hidden = !answer.paired;
  pairButton.disabled = false;
  pairButton.textContent = POPUP_COPY.pair;
}

const ask = (message: unknown): Promise<PopupAnswer> => chrome.runtime.sendMessage(message) as unknown as Promise<PopupAnswer>;

form.addEventListener('submit', (event) => {
  event.preventDefault();
  pairButton.disabled = true;
  pairButton.textContent = POPUP_COPY.pairing;
  void ask({ kind: 'pair', code: codeInput.value }).then(render);
});

unpairButton.addEventListener('click', () => {
  void ask({ kind: 'unpair' }).then(render);
});

void ask({ kind: 'status' }).then(render);
