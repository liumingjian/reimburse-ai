import { useCallback, useEffect, useRef, useState } from 'react';
import { compareClientVersions, MINIMUM_CLIENT_VERSION, type PairingView } from '@baox/contract';
import { useAppStore, useExtensionBridge, useExtensionPairing, useSession } from '../adapter/context';
import type { ExtensionPresence } from '../adapter/extension-bridge';

// Which step of extension setup the employee is on (#290), so settings and the tutorial show that step and no other.
// Two sources decide it: what the 浏览器扩展 (browser extension) in this browser says over the page bridge, and the
// server's pairing state for this 应用账号 (app account).
//
// - checking: the probe is out; nothing is known yet.
// - notInstalled: nothing answered. Install steps and the manual 配对码 (pairing code), as before the bridge.
// - outdated: an extension answered with a version below MINIMUM_CLIENT_VERSION. Only the upgrade steps.
// - notPairedHere: installed and new enough, and unpaired (or paired to this account while the server says otherwise).
//   The settings page issues a 配对码 and hands it to the extension (`useAutoPair`, #291).
// - pairedElsewhere: installed and new enough, but acting for another 应用账号. The extension asks the employee
//   before switching (`useAutoPair`, #292); declined or unanswered, the manual flow as for notInstalled. One-click
//   pairing must not void a colleague's pairing silently.
// - pairedHere: the extension says it acts for this account and the server agrees. No tutorial, just the connection.

export type ExtensionProbe = { status: 'probing' } | { status: 'answered'; presence: ExtensionPresence | null };

export type ExtensionSetupStep =
  | { kind: 'checking' }
  | { kind: 'notInstalled' }
  | { kind: 'outdated'; installed: string; minimum: string }
  | { kind: 'notPairedHere'; presence: ExtensionPresence }
  | { kind: 'pairedElsewhere'; presence: ExtensionPresence }
  | { kind: 'pairedHere'; presence: ExtensionPresence };

export function extensionSetupStep(probe: ExtensionProbe, accountId: string | null, pairing: PairingView | null, minimum: string = MINIMUM_CLIENT_VERSION): ExtensionSetupStep {
  if (probe.status === 'probing') return { kind: 'checking' };
  const presence = probe.presence;
  if (!presence) return { kind: 'notInstalled' };
  if (compareClientVersions(presence.version, minimum) < 0) return { kind: 'outdated', installed: presence.version, minimum };
  // Both halves must agree. The extension alone could be answering for a pairing the server has since replaced; the
  // server alone cannot tell whether that pairing lives in this browser. A pairing the 本地执行器 holds is never this
  // extension's (#428).
  const here = presence.paired && accountId !== null && presence.accountId === accountId && pairing?.status === 'paired' && pairing.holder === 'extension';
  if (here) return { kind: 'pairedHere', presence };
  return presence.paired && presence.accountId !== accountId ? { kind: 'pairedElsewhere', presence } : { kind: 'notPairedHere', presence };
}

/**
 * Whether this account still has to be paired in this browser: no extension answered, or it answered unpaired or
 * acting for another account. Settings offers the manual 配对码 flow for these; the tutorial shows the install steps
 * or, for an extension already installed, points back to settings.
 */
export function awaitsPairing(step: ExtensionSetupStep): step is Extract<ExtensionSetupStep, { kind: 'notInstalled' | 'notPairedHere' | 'pairedElsewhere' }> {
  return step.kind === 'notInstalled' || step.kind === 'notPairedHere' || step.kind === 'pairedElsewhere';
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

// One-click 扩展配对 (extension pairing) (#291): where the automatic pairing got to. idle: not attempted (or not wanted, or the extension
// never answered whether it may switch accounts). confirming: the extension acting for another 应用账号 is asking the
// employee whether to switch (#292). pairing: a 配对码 is being issued and handed over. paired: the extension redeemed
// it. silent: nothing answered the pair request, so the issued code is the employee's to type, as without the bridge.
// declined: the employee kept the extension with the other account. failed: issuing or redeeming failed, with the
// reason the popup would show.
export type AutoPair =
  | { status: 'idle' }
  | { status: 'confirming' }
  | { status: 'pairing' }
  | { status: 'paired' }
  | { status: 'silent' }
  | { status: 'declined' }
  | { status: 'failed'; message: string };

/**
 * Pairs the extension in this browser without the employee typing anything: when the first step settled on is
 * notPairedHere, issues a 配对码 through the existing endpoint, hands it over the bridge, and on success reloads the
 * pairing and re-probes until the page reaches 已连接. On pairedElsewhere the extension first asks the employee whether
 * to switch accounts (#292), and the code is issued only once they agree: issuing one already ends this account's
 * earlier pairing, so a refused switch leaves everything as it was. Decided once per page visit, on the first step
 * after the probe and the pairing read are both in, so a later 撤销配对 or a failed attempt never issues codes behind
 * the employee's back. `wanted` (#428): only when 去报销的方式 is the 浏览器扩展 because the extension holds the pairing;
 * with the 本地执行器 paired, or nothing paired, it never issues a code by itself, since issuing ends the current
 * pairing. Decided with the rest, so turning to the extension later on the page issues nothing either.
 */
export function useAutoPair(step: ExtensionSetupStep, reprobe: () => void, wanted: boolean): AutoPair {
  const store = useAppStore();
  const bridge = useExtensionBridge();
  const pairing = useExtensionPairing();
  const accountId = useSession().data?.account?.accountId ?? null;
  const [state, setState] = useState<AutoPair>({ status: 'idle' });
  const decided = useRef(false);
  const loaded = pairing.data !== null;

  useEffect(() => {
    if (decided.current || step.kind === 'checking' || !loaded || accountId === null) return;
    decided.current = true;
    if (!wanted) return;
    if (step.kind !== 'notPairedHere' && step.kind !== 'pairedElsewhere') return;
    const switching = step.kind === 'pairedElsewhere';
    setState({ status: switching ? 'confirming' : 'pairing' });
    void (async () => {
      if (switching) {
        const answer = await bridge.switchTo(accountId);
        if (answer !== 'accepted') {
          setState({ status: answer === 'declined' ? 'declined' : 'idle' });
          return;
        }
        setState({ status: 'pairing' });
      }
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
      const outcome = await bridge.pair(code, accountId);
      if (!outcome) {
        setState({ status: 'silent' });
        return;
      }
      switch (outcome.status) {
        case 'failed':
          setState({ status: 'failed', message: outcome.message });
          return;
        case 'declined':
          setState({ status: 'declined' });
          return;
        case 'paired':
          await store.awaitExtensionConnected();
          setState({ status: 'paired' });
          reprobe();
          return;
      }
    })();
  }, [step.kind, loaded, accountId, store, bridge, reprobe, wanted]);

  return state;
}
