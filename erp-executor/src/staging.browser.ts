// The browser build's `staging.ts`, selected by the `browser` map in package.json: a browser has no local path to
// stage an invoice at, so the extension's bundle puts the bytes into the page instead (`invoice-files.ts`).

export { stageInPage as stageInvoices } from './invoice-files';
