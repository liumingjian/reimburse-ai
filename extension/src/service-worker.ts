import { EXTENSION_VERSION } from '@baox/contract';
import { createChannelClient, type ChannelClient, type ChannelStatus, type ClientSocket } from './connection';
import { createErpRunner } from './erp-runner';
import { dedicatedErpTab } from './erp-tab';
import { BAOX_ORIGIN } from './origin';
import { redeemPairingCode } from './pairing';

// The MV3 service worker: the only long-lived thing in the extension, and not very long-lived at all. Chrome stops it
// after 30 seconds of inactivity, so two things keep it up — the channel's heartbeat, which is traffic on an open
// socket, and an alarm that wakes the worker back up if it was stopped anyway. Neither alone is enough: the socket
// dies with the worker, and an alarm cannot fire faster than once a minute.
//
// Everything the popup can ask for goes through `chrome.runtime.sendMessage`, because the popup is a separate page
// with its own lifetime and must not hold the connection itself.

const WAKE_ALARM = 'baox-keep-alive';
const PAIRING_KEY = 'pairing';

type StoredPairing = { token: string; accountId: string };

type PopupRequest = { kind: 'status' } | { kind: 'pair'; code: string } | { kind: 'unpair' };

export type PopupAnswer = { paired: boolean; accountId: string | null; version: string; status: ChannelStatus | null; error: string | null };

let client: ChannelClient | null = null;
let lastStatus: ChannelStatus | null = null;

// What the server asks of a connected extension: run a 去报销 in a tab of its own, over `chrome.debugger`. The chrome
// APIs are passed through lambdas so the executor side never names the `chrome` global.
const runErpJob = createErpRunner({
  browser: (erpOrigin, choice) => dedicatedErpTab({
    erpOrigin,
    choice,
    tabs: {
      create: (properties) => chrome.tabs.create(properties),
      get: (tabId) => chrome.tabs.get(tabId),
      update: (tabId, properties) => chrome.tabs.update(tabId, properties),
    },
    windows: { update: (windowId, properties) => chrome.windows.update(windowId, properties) },
    debugger: {
      attach: (target, version) => chrome.debugger.attach(target, version),
      detach: (target) => chrome.debugger.detach(target),
      sendCommand: (target, method, params) => chrome.debugger.sendCommand(target, method, params),
      onEvent: chrome.debugger.onEvent,
      onDetach: chrome.debugger.onDetach,
    },
  }),
  request: (method, payload) => (client ? client.request(method, payload) : Promise.reject(new Error('和应用的连接断开了。'))),
  // #257 resumes from here; until then an interruption only ends the job, through the command or request that failed.
  onInterrupted: (jobId, { kind, reason }) => console.warn(`[baox] job ${jobId} interrupted: ${kind} (${reason})`),
});

async function readPairing(): Promise<StoredPairing | null> {
  const stored = await chrome.storage.local.get(PAIRING_KEY);
  const value = stored[PAIRING_KEY] as Partial<StoredPairing> | undefined;
  return value && typeof value.token === 'string' && typeof value.accountId === 'string' ? { token: value.token, accountId: value.accountId } : null;
}

// What the settings page shows next to 浏览器. Read off the user agent because there is nothing better: Chrome and
// Edge are the only two supported (ADR-0021), and an employee only needs to recognise which machine this is.
function describeBrowser(): string {
  const agent = navigator.userAgent;
  const name = /Edg\//.test(agent) ? 'Edge' : 'Chrome';
  const version = /(?:Edg|Chrome)\/(\d+)/.exec(agent)?.[1] ?? '';
  const platform = /Windows/.test(agent) ? 'Windows' : /Mac OS X/.test(agent) ? 'macOS' : /Linux/.test(agent) ? 'Linux' : '';
  return [name, version, platform].filter(Boolean).join(' ');
}

function connect(pairing: StoredPairing): void {
  client?.stop();
  client = createChannelClient({
    origin: BAOX_ORIGIN,
    token: pairing.token,
    open: (url) => new WebSocket(url) as unknown as ClientSocket,
    onRequest: runErpJob,
    onStatus: (status) => {
      lastStatus = status;
    },
  });
}

async function start(): Promise<void> {
  const pairing = await readPairing();
  if (!pairing) return;
  connect(pairing);
}

async function answer(request: PopupRequest): Promise<PopupAnswer> {
  const base = { version: EXTENSION_VERSION, status: lastStatus, error: null as string | null };
  switch (request.kind) {
    case 'pair': {
      const outcome = await redeemPairingCode({ origin: BAOX_ORIGIN, code: request.code, browser: describeBrowser() });
      if (!outcome.ok) return { ...base, paired: false, accountId: null, error: outcome.message };
      await chrome.storage.local.set({ [PAIRING_KEY]: { token: outcome.token, accountId: outcome.accountId } });
      connect({ token: outcome.token, accountId: outcome.accountId });
      return { ...base, status: lastStatus, paired: true, accountId: outcome.accountId };
    }
    case 'unpair': {
      client?.stop();
      client = null;
      lastStatus = null;
      await chrome.storage.local.remove(PAIRING_KEY);
      return { ...base, status: null, paired: false, accountId: null };
    }
    default: {
      const pairing = await readPairing();
      // The popup may be the first thing to run after Chrome stopped the worker, so asking for status is also how
      // the connection comes back.
      if (pairing && !client) connect(pairing);
      return { ...base, status: lastStatus, paired: pairing !== null, accountId: pairing?.accountId ?? null };
    }
  }
}

chrome.runtime.onStartup.addListener(() => void start());
chrome.runtime.onInstalled.addListener(() => void start());

// One minute is the shortest period MV3 allows. It is not the heartbeat — the channel's own ping is — it is what
// brings the worker back after Chrome has stopped it anyway.
chrome.alarms.create(WAKE_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WAKE_ALARM && !client) void start();
});

chrome.runtime.onMessage.addListener((message: PopupRequest, _sender, sendResponse: (answer: PopupAnswer) => void) => {
  void answer(message).then(sendResponse);
  // Keeps the message port open for the async answer above; without it the popup gets `undefined`.
  return true;
});

void start();
