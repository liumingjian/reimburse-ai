import { relayPageBridge } from './bridge';
import { BAOX_ORIGIN } from './origin';

// The page bridge's content script (#287): injected into baox pages only (the manifest matches the stamped origin and
// nothing else), it relays between the page and the service worker. The protocol and its checks live in `bridge.ts`.

const relay = relayPageBridge({ window, origin: BAOX_ORIGIN, ask: (request) => chrome.runtime.sendMessage(request) });
void relay.announce();
