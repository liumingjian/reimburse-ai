import { z } from 'zod';
import { ClientVersionSchema } from './channel';

// What only the 浏览器扩展 has: its download and the page bridge. 配对 (pairing), the channel, invoice originals and
// version negotiation are shared with the 本地执行器 (local executor) and live in `./channel`.

// ---------------------------------------------------------------------------
// Distribution (ADR-0021: load-unpacked in developer mode, Chrome and Edge only)
// ---------------------------------------------------------------------------

// Where the settings page downloads the extension from. Behind the session gate like the rest of the page.
export const EXTENSION_DOWNLOAD_PATH = '/api/extension/download';
export const EXTENSION_DOWNLOAD_FILENAME = 'baox-extension.zip';

// What `extension/scripts/build.mjs` bakes in wherever the app's origin belongs, including `host_permissions`. The
// build is a template: the server swaps this for its own origin every time it serves the zip
// (`server/src/extension/download.ts`). `.invalid` never resolves, so a template loaded by hand talks to nobody rather
// than to the wrong server.
export const EXTENSION_ORIGIN_PLACEHOLDER = 'http://baox-public-origin.invalid';

export const EXTENSION_DOWNLOAD_ERRORS = {
  unavailable: '这台服务器上还没有可以下载的浏览器扩展安装包，请联系管理员。',
} as const;
// ---------------------------------------------------------------------------
// The page bridge (#287)
// ---------------------------------------------------------------------------

// The baox page and the 浏览器扩展 talk directly through `window.postMessage`: the extension's content script runs on
// the one origin stamped into its build (the same origin as `host_permissions`, so it costs no permission prompt) and
// relays between the page and the service worker. Both sides parse every incoming message with the schemas below, so
// a message either is one of these or is ignored.
//
// Every message carries EXTENSION_BRIDGE_NAMESPACE, so unrelated `postMessage` traffic on the page never parses. The
// content script also checks that a message came from its own window and from the stamped origin; the page checks the
// same of the answers.
//
// Adding a message: add its schema to the page or extension union. The page's bridge module and the extension's relay
// both dispatch on `kind`, so a kind one side does not know is ignored there rather than misread.
export const EXTENSION_BRIDGE_NAMESPACE = 'baox-extension-bridge';

const BridgeNamespaceSchema = z.literal(EXTENSION_BRIDGE_NAMESPACE);

// Page -> extension: "who are you?". Answered with a presence.
export const ExtensionBridgeProbeSchema = z.object({ namespace: BridgeNamespaceSchema, kind: z.literal('probe') });
export type ExtensionBridgeProbe = z.infer<typeof ExtensionBridgeProbeSchema>;

// Extension -> page: installed, which version, and whether it is paired and to which 应用账号. Sent when the content
// script loads and in answer to every probe. `paired` is what the app would accept right now, so a pairing revoked from
// the settings page reads as unpaired at the next presence even while the token is still stored in the extension.
export const ExtensionBridgePresenceSchema = z.object({
  namespace: BridgeNamespaceSchema,
  kind: z.literal('presence'),
  version: ClientVersionSchema,
  paired: z.boolean(),
  accountId: z.string().min(1).nullable(),
});
export type ExtensionBridgePresence = z.infer<typeof ExtensionBridgePresenceSchema>;

// Page -> extension: "may you switch to the signed-in 应用账号 `accountId`?" (#292). Sent before a 配对码 is issued
// whenever the extension says it acts for another account, because issuing one already ends the signed-in account's
// own earlier pairing on the server, so a refused switch must come before it. The extension asks the employee in a
// window of its own, naming the account it acts for now; the page never renders that question and cannot answer it.
// Answered with a switch outcome.
export const ExtensionBridgeSwitchRequestSchema = z.object({ namespace: BridgeNamespaceSchema, kind: z.literal('switch'), accountId: z.string().min(1) });
export type ExtensionBridgeSwitchRequest = z.infer<typeof ExtensionBridgeSwitchRequestSchema>;

// accepted: the employee agreed, or there was nothing to agree to (the extension is unpaired, or already acts for
// `accountId`); the next pair request for `accountId` is redeemed without asking again. declined: the employee kept
// the other account, or closed the window; nothing changed.
export const ExtensionSwitchOutcomeSchema = z.enum(['accepted', 'declined']);
export type ExtensionSwitchOutcome = z.infer<typeof ExtensionSwitchOutcomeSchema>;

// Extension -> page: the answer to a switch request.
export const ExtensionBridgeSwitchOutcomeSchema = z.object({ namespace: BridgeNamespaceSchema, kind: z.literal('switch_outcome'), outcome: ExtensionSwitchOutcomeSchema });
export type ExtensionBridgeSwitchOutcome = z.infer<typeof ExtensionBridgeSwitchOutcomeSchema>;

// Page -> extension: "redeem this 配对码 (pairing code), issued for `accountId`". The page issues the code through the
// existing endpoint only when the extension is present and not paired to the signed-in 应用账号 (#291), or after an
// accepted switch request when it acts for another one (#292); the extension redeems it through the same path as a
// code typed into its popup. `accountId` lets the extension see a switch before redeeming: a switch no accepted switch
// request covers is asked about first. Answered with a pair outcome.
export const ExtensionBridgePairRequestSchema = z.object({ namespace: BridgeNamespaceSchema, kind: z.literal('pair'), code: z.string().min(1).max(64), accountId: z.string().min(1) });
export type ExtensionBridgePairRequest = z.infer<typeof ExtensionBridgePairRequestSchema>;

// How a pair request ended. paired: the extension now acts for `accountId`. failed: redeeming was refused or could not
// be done, with the same `code` and `message` the popup's redeem gets (version_too_old, network_error, the server's
// own refusals), so the page shows the reason the popup would. declined: the employee refused to switch the extension
// away from another 应用账号 (#292); nothing was redeemed.
export const ExtensionPairOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('paired'), accountId: z.string().min(1) }),
  z.object({ status: z.literal('failed'), code: z.string().min(1), message: z.string().min(1) }),
  z.object({ status: z.literal('declined') }),
]);
export type ExtensionPairOutcome = z.infer<typeof ExtensionPairOutcomeSchema>;

// Extension -> page: the answer to a pair request.
export const ExtensionBridgePairOutcomeSchema = z.object({ namespace: BridgeNamespaceSchema, kind: z.literal('pair_outcome'), outcome: ExtensionPairOutcomeSchema });
export type ExtensionBridgePairOutcome = z.infer<typeof ExtensionBridgePairOutcomeSchema>;

export const ExtensionBridgePageMessageSchema = z.discriminatedUnion('kind', [ExtensionBridgeProbeSchema, ExtensionBridgeSwitchRequestSchema, ExtensionBridgePairRequestSchema]);
export type ExtensionBridgePageMessage = z.infer<typeof ExtensionBridgePageMessageSchema>;

export const ExtensionBridgeExtensionMessageSchema = z.discriminatedUnion('kind', [ExtensionBridgePresenceSchema, ExtensionBridgeSwitchOutcomeSchema, ExtensionBridgePairOutcomeSchema]);
export type ExtensionBridgeExtensionMessage = z.infer<typeof ExtensionBridgeExtensionMessageSchema>;

type BridgeMessageBody<M> = M extends unknown ? Omit<M, 'namespace'> : never;

/** A bridge message from its `kind` and fields, with the namespace every message carries. Both sides build theirs here. */
export function bridgeMessage<T extends BridgeMessageBody<ExtensionBridgePageMessage | ExtensionBridgeExtensionMessage>>(body: T): T & { namespace: typeof EXTENSION_BRIDGE_NAMESPACE } {
  return { namespace: EXTENSION_BRIDGE_NAMESPACE, ...body };
}
