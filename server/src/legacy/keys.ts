import { createHash } from 'node:crypto';

// The legacy kernel's three identity derivations, ported for the one-time `~/.baox` import (ADR-0015). Parity tests in
// keys.test.ts. Two of them key a legacy ERP identity `(tenant, account)` and only locate files; the third is the
// 发票身份 (invoice identity) that 发票占用 (invoice occupancy) compares.

export type LegacyIdentity = { account?: unknown; tenant?: unknown } | null | undefined;

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

// 50931a3:kernel/src/projects.mjs identityKey: the 个人项目簿 file name, `projects/<key>.json`. Trimmed.
export function bookFileKey(identity: LegacyIdentity): string | null {
  const account = text(identity?.account);
  const tenant = text(identity?.tenant);
  return account && tenant ? createHash('sha256').update(`${tenant}\0${account}`).digest('hex') : null;
}

// 50931a3:kernel/src/home-city.mjs identityKey: the key inside `home-cities.json`. Untrimmed, unlike the book key.
export function homeCityKey(identity: LegacyIdentity): string | null {
  const { account, tenant } = identity ?? {};
  return typeof account === 'string' && account && typeof tenant === 'string' && tenant ? JSON.stringify([tenant, account]) : null;
}

// 50931a3:kernel/src/parse.mjs invoiceIdentity: `vat-legacy:<code>:<n>` for a 10/12-digit code with an 8-digit number (checked
// first), else `einvoice-20:<n>` for a 20-digit number. The new app's `KindSpec.identity` yields the same einvoice key.
export function legacyInvoiceKey(fields: { invoiceCode?: string; invoiceNumber?: string }): string | null {
  const code = fields.invoiceCode ?? '';
  const number = fields.invoiceNumber ?? '';
  if (/^(?:\d{10}|\d{12})$/.test(code) && /^\d{8}$/.test(number)) return `vat-legacy:${code}:${number}`;
  if (/^\d{20}$/.test(number)) return `einvoice-20:${number}`;
  return null;
}

// A stored legacy `identityKey` is well-formed when it is one of the two shapes above.
export const LEGACY_INVOICE_KEY = /^(?:einvoice-20:\d{20}|vat-legacy:(?:\d{10}|\d{12}):\d{8})$/;
