// The one address this extension will ever talk to, replaced at build time by `scripts/build.mjs` (esbuild `define`)
// and written into `manifest.json`'s `host_permissions` by the same script, from the same value.
//
// User story 7: the popup asks for the 配对码 (pairing code) and nothing else. An extension with a server field is an
// extension an employee can be talked into pointing at somebody else's server, which would hand that server their
// invoices and their ERP browser. Baking the address in removes the field and the conversation with it.
declare const __BAOX_ORIGIN__: string;

export const BAOX_ORIGIN: string = __BAOX_ORIGIN__;
