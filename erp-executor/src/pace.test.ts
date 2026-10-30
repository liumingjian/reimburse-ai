import { describe, expect, it } from 'vitest';
import { waitFor } from './pace';

describe('condition observation', () => {
  it('recovers from one unreadable observation', async () => {
    let reads = 0;
    await expect(waitFor(async () => {
      if (++reads === 1) throw new Error('temporary read');
      return true;
    }, Boolean, 100, 1)).resolves.toBe(true);
    expect(reads).toBe(2);
  });

  it('limits consecutive unreadable observations', async () => {
    let reads = 0;
    await expect(waitFor(async () => { reads++; throw new Error('unreadable'); }, Boolean, 1000, 1))
      .rejects.toThrow('unreadable');
    expect(reads).toBe(3);
  });

  it('does not swallow a condition error', async () => {
    let reads = 0;
    await expect(waitFor(async () => { reads++; return false; }, () => { throw new Error('condition'); }, 100, 1))
      .rejects.toThrow('condition');
    expect(reads).toBe(1);
  });

  it('does not return an old value after the last read failed at the deadline', async () => {
    let reads = 0;
    await expect(waitFor(async () => {
      if (++reads > 1) throw new Error('last read failed');
      return false;
    }, Boolean, 5, 10)).rejects.toThrow('last read failed');
  });
});
