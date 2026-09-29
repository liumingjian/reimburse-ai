import {
  bridgeMessage,
  EXTENSION_VERSION,
  type ExtensionBridgeExtensionMessage,
  type ExtensionBridgePageMessage,
  type ExtensionBridgePairOutcome,
  type ExtensionBridgePresence,
  type ExtensionBridgeSwitchOutcome,
} from '@baox/contract';
import type { ChannelStatus } from './connection';
import { APP_UNREACHABLE } from './messages';
import { checkPairing, redeemPairingCode, revokePairing, type PairingOutcome } from './pairing';

// What the popup asks the service worker about the pairing: pair with a 配对码 (pairing code), 撤销配对 (revoke the
// pairing), and status. The service worker only wires `chrome` into this; storage, the network and the channel are
// injected so the whole exchange runs in a test without a browser. Anything else that pairs the extension goes through
// `redeem` too (the popup through `pair`, the page bridge through `bridge`), so the version check, the refusal wording
// and what a pairing starts stay in one place.
//
// The baox page asks through the page bridge (`bridge.ts`, #287) and is answered by `bridge`: a narrower set than the
// popup's, because a web page must never be able to 撤销配对 or read the token.

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

/**
 * The account the extension acts for now, as the switch confirmation names it: by the username the app gave, or by
 * its id when the app could not be reached to ask.
 */
export type CurrentAccount = { accountId: string; name: string };

/**
 * Asks the employee, in UI the extension owns, whether to stop acting for `current` and pair with the account signed
 * in on the baox page (#292). Resolves true when they agree; false when they refuse or close the question.
 */
export type ConfirmSwitch = (current: CurrentAccount) => Promise<boolean>;

export type PairingRequestsOptions = {
  origin: string;
  storage: PairingStorage;
  channel: PairingChannel;
  /** What the settings page shows next to 浏览器, sent when redeeming. */
  browser: () => string | null;
  /** The service worker opens a window of the extension's own (`switch-dialog.ts`). Without one, every switch is refused. */
  confirmSwitch?: ConfirmSwitch;
  // Injected so the test does not need a network; the service worker passes the global.
  fetchImpl?: typeof fetch;
};

export type PairingRequests = ReturnType<typeof createPairingRequests>;

const declineEverySwitch: ConfirmSwitch = async () => false;

export function createPairingRequests({ origin, storage, channel, browser, confirmSwitch = declineEverySwitch, fetchImpl = fetch }: PairingRequestsOptions) {
  // The switch the employee last agreed to, from one account to another (#292). The page asks before it issues the
  // 配对码, because issuing it already ends the signed-in account's earlier pairing on the server; the pair request
  // that follows then redeems without asking a second time. Used up by that one pair request.
  let agreed: { from: string; to: string } | null = null;
  const base = () => ({ version: EXTENSION_VERSION, status: channel.status(), error: null as string | null });

  async function readPairing(): Promise<StoredPairing | null> {
    const stored = await storage.get(PAIRING_KEY);
    const value = stored[PAIRING_KEY] as Partial<StoredPairing> | undefined;
    return value && typeof value.token === 'string' && typeof value.accountId === 'string' ? { token: value.token, accountId: value.accountId } : null;
  }

  /** The one redeem path: exchanges a 配对码 for the pairing, stores it, and opens the channel with it. */
  async function redeem(code: string): Promise<PairingOutcome> {
    const outcome = await redeemPairingCode({ origin, code, browser: browser(), fetchImpl });
    if (!outcome.ok) return outcome;
    const pairing = { token: outcome.token, accountId: outcome.accountId };
    await storage.set({ [PAIRING_KEY]: pairing });
    channel.start(pairing);
    return outcome;
  }

  async function pair(code: string): Promise<PopupAnswer> {
    const outcome = await redeem(code);
    if (!outcome.ok) return { ...base(), paired: false, accountId: null, error: outcome.message };
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

  // The channel's own word on the stored pairing, when it has one: `ready` means the app accepted this token, a
  // `not_paired` refusal that it no longer does. Anything else (no client, connecting, offline) says nothing.
  function channelSays(pairing: StoredPairing): 'paired' | 'not_paired' | null {
    const current = channel.status();
    if (current?.state === 'ready' && current.accountId === pairing.accountId) return 'paired';
    if (current?.state === 'refused' && current.code === 'not_paired') return 'not_paired';
    return null;
  }

  // Whether the app still honours the stored pairing. A pairing revoked from the settings page stays in storage (the
  // app tells the extension only over the channel, by refusing it), so the stored token alone is not enough to
  // announce the extension as paired. The channel settles it when it can. Only otherwise is the app asked, because
  // every answer counts there as a connection and would move 最近连接 (last connected) on a mere page visit. An app
  // that cannot be reached leaves the stored pairing standing.
  async function stillPaired(pairing: StoredPairing): Promise<boolean> {
    const said = channelSays(pairing);
    if (said !== null) return said === 'paired';
    return (await checkPairing({ origin, token: pairing.token, fetchImpl })).state !== 'not_paired';
  }

  /**
   * Whether pairing with `accountId` may go ahead: at once when nothing would be lost (unpaired, a pairing the app no
   * longer honours, or already acting for `accountId`); otherwise only if the employee agrees to switch. The app is
   * asked even over a ready channel, for the username the question names the account by.
   */
  async function mayPairWith(accountId: string): Promise<boolean> {
    const pairing = await readPairing();
    if (!pairing || pairing.accountId === accountId) return true;
    if (channelSays(pairing) === 'not_paired') return true;
    const check = await checkPairing({ origin, token: pairing.token, fetchImpl });
    if (check.state === 'not_paired') return true;
    return confirmSwitch({ accountId: pairing.accountId, name: check.state === 'paired' ? check.username : pairing.accountId });
  }

  /** What the extension announces to the baox page: its version, and the 应用账号 it is paired to, if the app agrees. */
  async function presence(): Promise<ExtensionBridgePresence> {
    const pairing = await readPairing();
    const paired = pairing !== null && (await stillPaired(pairing));
    // A page visit is as good a time as the popup's to bring the connection back.
    if (pairing && paired && !channel.running()) channel.start(pairing);
    return bridgeMessage({ kind: 'presence', version: EXTENSION_VERSION, paired, accountId: paired ? pairing.accountId : null });
  }

  /**
   * Answers the baox page's "may you switch to `accountId`?" (#292), asked before it issues a 配对码. Asks the employee
   * only when the extension acts for another account the app still honours; an agreed switch is remembered for the
   * pair request that follows.
   */
  async function switchFromPage(accountId: string): Promise<ExtensionBridgeSwitchOutcome> {
    const from = (await readPairing())?.accountId ?? null;
    const accepted = await mayPairWith(accountId);
    agreed = accepted && from !== null && from !== accountId ? { from, to: accountId } : null;
    return bridgeMessage({ kind: 'switch_outcome', outcome: accepted ? 'accepted' : 'declined' });
  }

  /**
   * Redeems a 配对码 the baox page handed over (#291), the same way as one typed into the popup, and answers with the
   * outcome; a failure keeps the redeem's code and message, so the page shows what the popup would. A switch away from
   * another account is redeemed only when the employee agreed to it: through the switch request just before (and is
   * not asked again), or, when none covers it, by being asked now (#292). Refused, nothing is redeemed.
   */
  async function pairFromPage(code: string, accountId: string): Promise<ExtensionBridgePairOutcome> {
    const from = (await readPairing())?.accountId ?? null;
    const covered = agreed !== null && agreed.from === from && agreed.to === accountId;
    agreed = null;
    if (!covered && !(await mayPairWith(accountId))) return bridgeMessage({ kind: 'pair_outcome', outcome: { status: 'declined' } });
    const outcome = await redeem(code);
    return bridgeMessage({
      kind: 'pair_outcome',
      outcome: outcome.ok ? { status: 'paired', accountId: outcome.accountId } : { status: 'failed', code: outcome.code, message: outcome.message },
    });
  }

  /** Answers a message from the baox page, relayed by the content script. */
  function bridge(message: ExtensionBridgePageMessage): Promise<ExtensionBridgeExtensionMessage> {
    switch (message.kind) {
      case 'probe':
        return presence();
      case 'switch':
        return switchFromPage(message.accountId);
      case 'pair':
        return pairFromPage(message.code, message.accountId);
    }
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

  return { readPairing, redeem, pair, unpair, status, start, answer, presence, bridge };
}
