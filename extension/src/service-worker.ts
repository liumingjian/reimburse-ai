import type { ExtensionBridgeExtensionMessage } from '@baox/contract';
import { serverBlobs } from './blobs';
import { bridgeRequestFrom, fromContentScript } from './bridge';
import { channelWatch, createChannelClient, type ChannelClient, type ChannelStatus, type ClientSocket } from './connection';
import { createErpRunner } from './erp-runner';
import { dedicatedErpTab } from './erp-tab';
import { channelClosed } from './messages';
import { BAOX_ORIGIN } from './origin';
import { createPairingRequests, type PopupAnswer, type PopupRequest, type StoredPairing } from './pairing-requests';
import { createSwitchDialog, SWITCH_PAGE } from './switch-dialog';

// The MV3 service worker: the only long-lived thing in the extension, and not very long-lived at all. Chrome stops it
// after 30 seconds of inactivity, so two things keep it up — the channel's heartbeat, which is traffic on an open
// socket, and an alarm that wakes the worker back up if it was stopped anyway. Neither alone is enough: the socket
// dies with the worker, and an alarm cannot fire faster than once a minute.
//
// Everything the popup can ask for goes through `chrome.runtime.sendMessage`, because the popup is a separate page
// with its own lifetime and must not hold the connection itself. What it asks is answered by `pairing-requests.ts`;
// this file only wires `chrome` into it. The baox page asks through the content script (the page bridge, `bridge.ts`),
// over the same runtime messaging, and is answered from a narrower set. The switch question's window
// (`switch-dialog.ts`) answers over it too.

const WAKE_ALARM = 'baox-keep-alive';

let client: ChannelClient | null = null;
let lastStatus: ChannelStatus | null = null;
// What a running 去报销 hears of the channel: when it went, and when it is back.
const connection = channelWatch();

function noteStatus(status: ChannelStatus | null): void {
  lastStatus = status;
  connection.status(status);
}

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
  request: (method, payload) => (client ? client.request(method, payload) : Promise.reject(channelClosed())),
  blobs: serverBlobs({ origin: BAOX_ORIGIN, token: async () => (await pairingRequests.readPairing())?.token ?? null, fetch: (url, init) => fetch(url, init) }),
  connection,
  // The job's link resumes it (`job-link.ts`); this is only the log line.
  onInterrupted: (jobId, { kind, reason }) => console.warn(`[baox] job ${jobId} interrupted: ${kind} (${reason})`),
});

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
    onStatus: noteStatus,
  });
}

// Asked before one-click pairing moves this extension to another 应用账号 (#292), in a window the extension owns.
const switchDialog = createSwitchDialog({
  windows: {
    create: async (options) => (await chrome.windows.create(options)) ?? {},
    remove: (windowId) => chrome.windows.remove(windowId),
    onRemoved: chrome.windows.onRemoved,
  },
  pageUrl: chrome.runtime.getURL(SWITCH_PAGE),
});

const pairingRequests = createPairingRequests({
  origin: BAOX_ORIGIN,
  storage: {
    get: (key) => chrome.storage.local.get(key),
    set: (items) => chrome.storage.local.set(items),
    remove: (key) => chrome.storage.local.remove(key),
  },
  channel: {
    start: connect,
    stop: () => {
      client?.stop();
      client = null;
      noteStatus(null);
    },
    running: () => client !== null,
    status: () => lastStatus,
  },
  browser: describeBrowser,
  confirmSwitch: switchDialog.confirm,
});

chrome.runtime.onStartup.addListener(() => void pairingRequests.start());
chrome.runtime.onInstalled.addListener(() => void pairingRequests.start());

// One minute is the shortest period MV3 allows. It is not the heartbeat — the channel's own ping is — it is what
// brings the worker back after Chrome has stopped it anyway.
chrome.alarms.create(WAKE_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WAKE_ALARM && !client) void pairingRequests.start();
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (answer: PopupAnswer | ExtensionBridgeExtensionMessage | null) => void) => {
  // The switch question's own page, recognised by its URL before anything else: it is opened in a tab-like window,
  // so it would otherwise pass for a content script.
  if (switchDialog.answer(message, sender.url)) {
    sendResponse(null);
    return false;
  }
  // A content script speaks for a web page, so it gets the page bridge's answers and nothing of the popup's.
  if (fromContentScript(sender)) {
    const request = bridgeRequestFrom(message, sender, BAOX_ORIGIN);
    if (!request) return false;
    void pairingRequests.bridge(request).then(sendResponse);
    return true;
  }
  void pairingRequests.answer(message as PopupRequest).then(sendResponse);
  // Keeps the message port open for the async answer above; without it the popup gets `undefined`.
  return true;
});

void pairingRequests.start();
