import { useCallback, useEffect, useState } from 'react';
import { compareExtensionVersions, EXTENSION_MINIMUM_VERSION, type ExtensionPairing } from '@baox/contract';
import { useExtensionBridge, useExtensionPairing, useSession } from '../adapter/context';
import type { ExtensionPresence } from '../adapter/extension-bridge';

// Which step of extension setup the employee is on (#290), so settings and the tutorial show that step and no other.
// Two sources decide it: what the 浏览器扩展 (browser extension) in this browser says over the page bridge, and the
// server's pairing state for this 应用账号 (app account).
//
// - checking: the probe is out; nothing is known yet.
// - notInstalled: nothing answered. Install steps and the manual 配对码 (pairing code), as before the bridge.
// - outdated: an extension answered with a version below EXTENSION_MINIMUM_VERSION. Only the upgrade steps.
// - notPairedHere: installed and new enough, but unpaired or paired to another 应用账号. For now the manual flow, as
//   for notInstalled; #287's one-click pairing hands the extension a 配对码 from here.
// - pairedHere: the extension says it acts for this account and the server agrees. No tutorial, just the connection.

export type ExtensionProbe = { status: 'probing' } | { status: 'answered'; presence: ExtensionPresence | null };

export type ExtensionSetupStep =
  | { kind: 'checking' }
  | { kind: 'notInstalled' }
  | { kind: 'outdated'; installed: string; minimum: string }
  | { kind: 'notPairedHere'; presence: ExtensionPresence }
  | { kind: 'pairedHere'; presence: ExtensionPresence };

export function extensionSetupStep(probe: ExtensionProbe, accountId: string | null, pairing: ExtensionPairing | null, minimum: string = EXTENSION_MINIMUM_VERSION): ExtensionSetupStep {
  if (probe.status === 'probing') return { kind: 'checking' };
  const presence = probe.presence;
  if (!presence) return { kind: 'notInstalled' };
  if (compareExtensionVersions(presence.version, minimum) < 0) return { kind: 'outdated', installed: presence.version, minimum };
  // Both halves must agree. The extension alone could be answering for a pairing the server has since replaced; the
  // server alone cannot tell whether that pairing lives in this browser.
  const here = presence.paired && accountId !== null && presence.accountId === accountId && pairing?.status === 'paired';
  return here ? { kind: 'pairedHere', presence } : { kind: 'notPairedHere', presence };
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
