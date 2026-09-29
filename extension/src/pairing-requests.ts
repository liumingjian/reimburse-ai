import { EXTENSION_VERSION } from '@baox/contract';
import type { ChannelStatus } from './connection';
import { APP_UNREACHABLE } from './messages';
import { redeemPairingCode, revokePairing } from './pairing';

// What the popup asks the service worker about the pairing: pair with a 配对码 (pairing code), 撤销配对 (revoke the
// pairing), and status. The service worker only wires `chrome` into this; storage, the network and the channel are
// injected so the whole exchange runs in a test without a browser. Anything else that pairs the extension goes through
// `pair` too, so the version check and the refusal wording stay in one place.

const PAIRING_KEY = 'pairing';

export type StoredPairing = { token: string; accountId: string };

const UNPAIR_NOT_REACHED = `这个浏览器已经不再和账号配对，但应用那边没能撤销：${APP_UNREACHABLE}请到应用设置页的「浏览器扩展」一节撤销配对。`;

export type PopupRequest = { kind: 'status' } | { kind: 'pair'; code: string } | { kind: 'unpair' };

export type PopupAnswer = { paired: boolean; accountId: string | null; version: string; status: ChannelStatus | null; error: string | null };

/** The slice of `chrome.storage.local` the pairing lives in. */
export type PairingStorage = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
};

/** The channel to the app, as far as pairing is concerned: started with a pairing, stopped when it ends. */
export type PairingChannel = {
  /** Opens the channel with this pairing, replacing any client already running. */
  start(pairing: StoredPairing): void;
  /** Stops the running client, if any, and forgets its status. */
  stop(): void;
  running(): boolean;
  /** The last status the channel reported; null when there is no client. */
  status(): ChannelStatus | null;
};

export type PairingRequestsOptions = {
  origin: string;
  storage: PairingStorage;
  channel: PairingChannel;
  /** What the settings page shows next to 浏览器, sent when redeeming. */
  browser: () => string | null;
  // Injected so the test does not need a network; the service worker passes the global.
  fetchImpl?: typeof fetch;
};

export type PairingRequests = ReturnType<typeof createPairingRequests>;

export function createPairingRequests({ origin, storage, channel, browser, fetchImpl = fetch }: PairingRequestsOptions) {
  const base = () => ({ version: EXTENSION_VERSION, status: channel.status(), error: null as string | null });

  async function readPairing(): Promise<StoredPairing | null> {
    const stored = await storage.get(PAIRING_KEY);
    const value = stored[PAIRING_KEY] as Partial<StoredPairing> | undefined;
    return value && typeof value.token === 'string' && typeof value.accountId === 'string' ? { token: value.token, accountId: value.accountId } : null;
  }

  async function pair(code: string): Promise<PopupAnswer> {
    const outcome = await redeemPairingCode({ origin, code, browser: browser(), fetchImpl });
    if (!outcome.ok) return { ...base(), paired: false, accountId: null, error: outcome.message };
    const pairing = { token: outcome.token, accountId: outcome.accountId };
    await storage.set({ [PAIRING_KEY]: pairing });
    channel.start(pairing);
    return { ...base(), paired: true, accountId: outcome.accountId };
  }

  async function unpair(): Promise<PopupAnswer> {
    // 撤销配对 ends the pairing on the app too, not only here: a token left valid there would still be this account's
    // extension. This browser forgets it either way; if the app could not be reached, the employee is told to finish
    // the job from the settings page.
    const pairing = await readPairing();
    const revoked = pairing ? await revokePairing({ origin, token: pairing.token, fetchImpl }) : true;
    channel.stop();
    await storage.remove(PAIRING_KEY);
    return { ...base(), status: null, paired: false, accountId: null, error: revoked ? null : UNPAIR_NOT_REACHED };
  }

  async function status(): Promise<PopupAnswer> {
    const pairing = await readPairing();
    // The popup may be the first thing to run after Chrome stopped the worker, so asking for status is also how the
    // connection comes back.
    if (pairing && !channel.running()) channel.start(pairing);
    return { ...base(), paired: pairing !== null, accountId: pairing?.accountId ?? null };
  }

  /** Opens the channel if a pairing is stored: on startup, install, and the wake alarm. */
  async function start(): Promise<void> {
    const pairing = await readPairing();
    if (pairing) channel.start(pairing);
  }

  function answer(request: PopupRequest): Promise<PopupAnswer> {
    switch (request.kind) {
      case 'pair':
        return pair(request.code);
      case 'unpair':
        return unpair();
      default:
        return status();
    }
  }

  return { readPairing, pair, unpair, status, start, answer };
}
