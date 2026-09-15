import { describe, expect, it } from 'vitest';
import { KINDS } from '../parse/kinds';
import { bookFileKey, homeCityKey, legacyInvoiceKey } from './keys';

// Parity with the legacy kernel's three identity derivations. Inputs and expected outputs are translated from
// kernel/src/projects.mjs identityKey (+ kernel/test/projects.test.mjs), kernel/src/home-city.mjs identityKey
// (+ kernel/test/home-city.test.mjs) and kernel/src/parse.mjs invoiceIdentity (+ kernel/test/parse.test.mjs).

const ALICE = { account: 'alice', tenant: 'tenant-a' };
const BOB = { account: 'bob', tenant: 'tenant-a' };

describe('book file key (projects/<key>.json)', () => {
  it('is hex sha256 of tenant NUL account', () => {
    expect(bookFileKey(ALICE)).toBe('edf43860cf315becf548f9d9296bfc709227da2bc180b76b51fc7dc575c5c54b');
    expect(bookFileKey({ account: 'bob', tenant: 'tenant-b' })).toBe('8c223eab6a92f3b2faf38e3152d05488fb94b770fbeeac14ac6f1be8234c511e');
  });

  it('trims both parts, isolates accounts of one tenant, and needs both', () => {
    expect(bookFileKey({ account: ' alice ', tenant: 'tenant-a' })).toBe(bookFileKey(ALICE));
    expect(bookFileKey(BOB)).not.toBe(bookFileKey(ALICE));
    expect(bookFileKey({ account: 'alice', tenant: '  ' })).toBeNull();
    expect(bookFileKey(null)).toBeNull();
  });
});

describe('home-city key (home-cities.json)', () => {
  it('is JSON [tenant, account], untrimmed', () => {
    expect(homeCityKey(ALICE)).toBe('["tenant-a","alice"]');
    expect(homeCityKey({ account: ' alice ', tenant: 'tenant-a' })).toBe('["tenant-a"," alice "]');
    expect(homeCityKey(BOB)).not.toBe(homeCityKey(ALICE));
    expect(homeCityKey({ account: '', tenant: 'tenant-a' })).toBeNull();
  });
});

describe('invoice identity key (tasks/<dir>/invoices.json identityKey)', () => {
  it('20-digit numbers are einvoice-20; a 10/12-digit code with an 8-digit number is vat-legacy', () => {
    expect(legacyInvoiceKey({ invoiceNumber: '12345678901234567890' })).toBe('einvoice-20:12345678901234567890');
    expect(legacyInvoiceKey({ invoiceCode: '131002325021', invoiceNumber: '04213377' })).toBe('vat-legacy:131002325021:04213377');
    expect(legacyInvoiceKey({ invoiceCode: '1310023250', invoiceNumber: '04213377' })).toBe('vat-legacy:1310023250:04213377');
    // vat-legacy wins when both shapes fit, as in the kernel.
    expect(legacyInvoiceKey({ invoiceCode: '131002325021', invoiceNumber: '12345678' })).toBe('vat-legacy:131002325021:12345678');
    expect(legacyInvoiceKey({ invoiceNumber: '1234567' })).toBeNull();
    expect(legacyInvoiceKey({ invoiceCode: '13100232502', invoiceNumber: '04213377' })).toBeNull();
  });

  it('matches the new app invoice identity for every kind that has one', () => {
    for (const number of ['26312000000098127734', '12345678901234567890', '1234']) {
      const legacy = legacyInvoiceKey({ invoiceNumber: number });
      expect(KINDS.vat_invoice.identity?.({ invoiceNumber: number })).toBe(legacy);
      expect(KINDS.rail_ticket.identity?.({ invoiceNumber: number })).toBe(legacy);
    }
  });
});
