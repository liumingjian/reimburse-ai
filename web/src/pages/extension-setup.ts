import { useCallback, useEffect, useRef, useState } from 'react';
import { compareExtensionVersions, EXTENSION_MINIMUM_VERSION, type ExtensionPairing } from '@baox/contract';
import { useAppStore, useExtensionBridge, useExtensionPairing, useSession } from '../adapter/context';
import type { ExtensionPresence } from '../adapter/extension-bridge';

// Which step of extension setup the employee is on (#290), so settings and the tutorial show that step and no other.
// Two sources decide it: what the 浏览器扩展 (browser extension) in this browser says over the page bridge, and the
// server's pairing state for this 应用账号 (app account).
//
// - checking: the probe is out; nothing is known yet.
// - notInstalled: nothing answered. Install steps and the manual 配对码 (pairing code), as before the bridge.
// - outdated: an extension answered with a version below EXTENSION_MINIMUM_VERSION. Only the upgrade steps.
// - notPairedHere: installed and new enough, and unpaired (or paired to this account while the server says otherwise).
//   The settings page issues a 配对码 and hands it to the extension (`useAutoPair`, #291).
// - pairedElsewhere: installed and new enough, but acting for another 应用账号. The manual flow, as for notInstalled,
//   until #292 lets the extension confirm the switch; one-click pairing must not void a colleague's pairing silently.
// - pairedHere: the extension says it acts for this account and the server agrees. No tutorial, just the connection.

export type ExtensionProbe = { status: 'probing' } | { status: 'answered'; presence: ExtensionPresence | null };

export type ExtensionSetupStep =
  | { kind: 'checking' }
  | { kind: 'notInstalled' }
  | { kind: 'outdated'; installed: string; minimum: string }
  | { kind: 'notPairedHere'; presence: ExtensionPresence }
  | { kind: 'pairedElsewhere'; presence: ExtensionPresence }
  | { kind: 'pairedHere'; presence: ExtensionPresence };

export function extensionSetupStep(probe: ExtensionProbe, accountId: string | null, pairing: ExtensionPairing | null, minimum: string = EXTENSION_MINIMUM_VERSION): ExtensionSetupStep {
  if (probe.status === 'probing') return { kind: 'checking' };
  const presence = probe.presence;
  if (!presence) return { kind: 'notInstalled' };
  if (compareExtensionVersions(presence.version, minimum) < 0) return { kind: 'outdated', installed: presence.version, minimum };
  // Both halves must agree. The extension alone could be answering for a pairing the server has since replaced; the
  // server alone cannot tell whether that pairing lives in this browser.
  const here = presence.paired && accountId !== null && presence.accountId === accountId && pairing?.status === 'paired';
  if (here) return { kind: 'pairedHere', presence };
  return presence.paired && presence.accountId !== accountId ? { kind: 'pairedElsewhere', presence } : { kind: 'notPairedHere', presence };
}

/**
 * The setup step for the signed-in account, probing the extension on mount. `reprobe` asks again: after anything that
 * changes the pairing (issuing a 配对码 voids the old one, 撤销配对 ends it), so the page never shows a stale step.
 */
export function useExtensionSetup(): { step: ExtensionSetupStep; reprobe: () => void } {
  const bridge = useExtensionBridge();
  const session = useSession();
  const pairing = useExtensionPairing();
  const [probe, setProbe] = useState<ExtensionProbe>({ status: 'probing' });
  const [round, setRound] = useState(0);

  useEffect(() => {
    let current = true;
    setProbe({ status: 'probing' });
    void bridge.probe().then((presence) => {
      if (current) setProbe({ status: 'answered', presence });
    });
    return () => {
      current = false;
    };
  }, [bridge, round]);

  const reprobe = useCallback(() => setRound((value) => value + 1), []);
  return { step: extensionSetupStep(probe, session.data?.account?.accountId ?? null, pairing.data), reprobe };
}

// One-click 扩展配对 (#291): where the automatic pairing got to. idle: not attempted (or not wanted). pairing: a 配对码 is
// being issued and handed over. paired: the extension redeemed it. silent: nothing answered, so the issued code is the
// employee's to type, as without the bridge. failed: issuing or redeeming failed, with the reason the popup would show.
// #292 adds declined (the employee kept the extension with another 应用账号).
export type AutoPair = { status: 'idle' } | { status: 'pairing' } | { status: 'paired' } | { status: 'silent' } | { status: 'failed'; message: string };

// Reading the pairing again until the server sees the extension connected: redeeming returns before the extension's
// channel is up, and the page has no push for it.
const CONNECTED_POLLS = 10;
const CONNECTED_POLL_MS = 500;

/**
 * Pairs the extension in this browser without the employee typing anything: when the first step settled on is
 * notPairedHere, issues a 配对码 through the existing endpoint, hands it over the bridge, and on success reloads the
 * pairing and re-probes until the page reaches 已连接. Decided once per page visit, on the first step after the probe
 * and the pairing read are both in, so a later 撤销配对 or a failed attempt never issues codes behind the employee's back.
 */
export function useAutoPair(step: ExtensionSetupStep, reprobe: () => void): AutoPair {
  const store = useAppStore();
  const bridge = useExtensionBridge();
  const pairing = useExtensionPairing();
  const [state, setState] = useState<AutoPair>({ status: 'idle' });
  const decided = useRef(false);
  const loaded = pairing.data !== null;

  useEffect(() => {
    if (decided.current || step.kind === 'checking' || !loaded) return;
    decided.current = true;
    // #292 adds pairedElsewhere here, once the extension asks before switching accounts.
    if (step.kind !== 'notPairedHere') return;
    setState({ status: 'pairing' });
    void (async () => {
      const issued = await store.extensionPairingAction((adapter) => adapter.createExtensionPairingCode());
      if (!issued.ok) {
        setState({ status: 'failed', message: issued.error.message });
        return;
      }
      const code = issued.pairing.code;
      if (!code) {
        setState({ status: 'idle' });
        return;
      }
      const outcome = await bridge.pair(code);
      if (!outcome) {
        setState({ status: 'silent' });
        return;
      }
      switch (outcome.status) {
        case 'failed':
          setState({ status: 'failed', message: outcome.message });
          return;
        case 'paired':
          for (let poll = 0; poll < CONNECTED_POLLS; poll += 1) {
            if (poll > 0) await new Promise((resolve) => setTimeout(resolve, CONNECTED_POLL_MS));
            await store.loadExtensionPairing();
            if (store.getState().extensionPairing.data?.connected) break;
          }
          setState({ status: 'paired' });
          reprobe();
          return;
      }
    })();
  }, [step.kind, loaded, store, bridge, reprobe]);

  return state;
}
