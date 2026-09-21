// The one address this extension will ever talk to. `scripts/build.mjs` writes EXTENSION_ORIGIN_PLACEHOLDER here (esbuild
// `define`) and into `manifest.json`'s `host_permissions`; the server stamps its own origin over both when the settings
// page hands the extension out (`template.ts`, `server/src/extension/download.ts`). So the address is fixed per
// download, and nothing at run time can change it.
//
// User story 7: the popup asks for the 配对码 (pairing code) and nothing else. An extension with a server field is an
// extension an employee can be talked into pointing at somebody else's server, which would hand that server their
// invoices and their ERP browser. Baking the address in removes the field and the conversation with it.
declare const __BAOX_ORIGIN__: string;

export const BAOX_ORIGIN: string = __BAOX_ORIGIN__;
