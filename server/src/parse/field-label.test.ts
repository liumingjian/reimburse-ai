import { describe, expect, it } from 'vitest';
import { fieldLabel } from './slots';

// Candidate keys shown to people: slot labels, and per-leg itinerary fields (`segments[i].<field>`, 0-based) as 第 N 段….
describe('fieldLabel', () => {
  it('names a leg field by its 1-based leg', () => {
    expect(fieldLabel('ride_itinerary', 'segments[0].origin')).toBe('第 1 段起点');
    expect(fieldLabel('ride_itinerary', 'segments[2].amount')).toBe('第 3 段金额');
  });

  it('keeps slot labels and falls back to the raw key', () => {
    expect(fieldLabel('ride_itinerary', 'itineraryTotal')).toBe('行程单合计');
    expect(fieldLabel('ride_itinerary', 'nope')).toBe('nope');
  });
});
