import { describe, expect, it } from 'vitest';
import { allocate, conservingLegs, pairItineraries, splitTax, type ItineraryRef, type RideInvoice } from './allocation';

// Origin: 50931a3:kernel/test/events.test.mjs — 逐段分摊 (per-leg allocation) and evidence linking:
// `合并交通票：各段之和与价税合计分毫不差时，内核直接定案`, `差一分钱就得问用户，行程单金额只作候选`,
// `分毫不差的判据不给一分钱的容差`, `用户提交逐段金额之后才拆出三条候选明细，且三项金额分别守恒`, `逐段金额之和差一分也不收`,
// `用户给过的分摊压过行程单`, `拆税额只按票面比例…余数落在最大的一段`, `证据关联按合计金额相等连线，且要求唯一`.
// The kernel's AA invoice (67.17 + 2.02 = 69.19) and three-leg itinerary (26.69 + 20.85 + 21.65) are kept as inputs.

const AA_INVOICE = { netAmount: '67.17', taxAmount: '2.02', totalAmount: '69.19' };
const leg = (index: number, amount: string | null, date = '2026-07-09') => ({ index, date, time: null, city: '北京市', origin: `起点${index}`, destination: `终点${index}`, amount });
const AA_LEGS = [leg(1, '26.69'), leg(2, '20.85'), leg(3, '21.65', '2026-07-10')];

const cents = (values: string[]) => values.map((v) => Math.round(Number(v) * 100));

describe('conservingLegs: exact to the cent, no tolerance', () => {
  it('adopts amounts that sum to the invoice total and refuses a cent off or a missing leg', () => {
    expect(conservingLegs(['26.69', '42.50'], 6919)).toEqual([2669, 4250]);
    expect(conservingLegs(['26.69', '42.51'], 6919)).toBeNull();
    expect(conservingLegs(['26.69', null], 6919)).toBeNull();
    expect(conservingLegs([], 6919)).toBeNull();
    // Amounts are two-decimal and positive.
    expect(conservingLegs(['69.19', '0.00'], 6919)).toBeNull();
    expect(conservingLegs(['70.19', '-1.00'], 6919)).toBeNull();
  });
});

describe('splitTax: net and tax by the invoice ratio, each conserving', () => {
  it('puts the rounding residue on the largest leg (first on a tie) and reports it', () => {
    const split = splitTax([5000, 5000], 9709, 291);
    // 48.545 cents each rounds to 4855 twice (one cent too many): the -1 goes to leg 1.
    expect(split).toEqual({ nets: [4854, 4855], taxes: [146, 145], residueCents: -1, residueOn: 0 });
    expect(split?.nets.reduce((a, b) => a + b, 0)).toBe(9709);
    expect(split?.taxes.reduce((a, b) => a + b, 0)).toBe(291);
  });

  it('gives up when the face itself does not conserve', () => {
    expect(splitTax([5000, 5000], 9709, 292)).toBeNull();
  });
});

describe('allocate', () => {
  it('a conserving itinerary is adopted without asking; net and tax conserve per invoice', () => {
    const result = allocate(AA_INVOICE, AA_LEGS);
    expect(result).toMatchObject({ status: 'adopted', source: 'itinerary_conserved' });
    if (result.status !== 'adopted') return;
    expect(result.legs.map((l) => l.gross)).toEqual(['26.69', '20.85', '21.65']);
    expect(result.legs.map((l) => l.net)).toEqual(['25.91', '20.24', '21.02']);
    expect(result.legs.map((l) => l.tax)).toEqual(['0.78', '0.61', '0.63']);
    expect(cents(result.legs.map((l) => l.net)).reduce((a, b) => a + b)).toBe(6717);
    expect(cents(result.legs.map((l) => l.tax)).reduce((a, b) => a + b)).toBe(202);
    for (const l of result.legs) expect(Math.round(Number(l.net) * 100) + Math.round(Number(l.tax) * 100)).toBe(Math.round(Number(l.gross) * 100));
  });

  it('m03 (67.18 + 2.01) with the m04 legs: the residue cent lands on the largest leg', () => {
    const result = allocate({ netAmount: '67.18', taxAmount: '2.01', totalAmount: '69.19' }, [leg(1, '26.69'), leg(2, '20.85'), leg(3, '21.65')]);
    if (result.status !== 'adopted') throw new Error('expected adopted');
    expect(result.legs.map((l) => [l.gross, l.net, l.tax])).toEqual([
      ['26.69', '25.92', '0.77'],
      ['20.85', '20.24', '0.61'],
      ['21.65', '21.02', '0.63'],
    ]);
  });

  it('an AA split (legs shared, itinerary amounts still conserving) is adopted as printed', () => {
    const result = allocate({ netAmount: '48.54', taxAmount: '1.46', totalAmount: '50.00' }, [leg(1, '25.00'), leg(2, '25.00')]);
    expect(result).toMatchObject({ status: 'adopted', legs: [{ gross: '25.00' }, { gross: '25.00' }] });
  });

  it('a cent off: nothing is adopted, the itinerary amounts are only suggestions', () => {
    const skewed = [leg(1, '26.70'), ...AA_LEGS.slice(1)];
    expect(allocate(AA_INVOICE, skewed)).toEqual({
      status: 'required',
      total: '69.19',
      legs: skewed,
      suggested: ['26.70', '20.85', '21.65'],
      reason: 'not_conserving',
    });
    // A leg without an amount cannot conserve either.
    expect(allocate(AA_INVOICE, [leg(1, null), ...AA_LEGS.slice(1)])).toMatchObject({ status: 'required', suggested: [null, '20.85', '21.65'] });
  });

  it("the user's per-leg totals win over the itinerary and split net/tax the same way", () => {
    const result = allocate(AA_INVOICE, AA_LEGS, ['30.00', '20.00', '19.19']);
    expect(result).toMatchObject({ status: 'adopted', source: 'user_allocation' });
    if (result.status !== 'adopted') return;
    expect(result.legs.map((l) => l.gross)).toEqual(['30.00', '20.00', '19.19']);

    const skewed = allocate(AA_INVOICE, [leg(1, '26.70'), ...AA_LEGS.slice(1)], ['26.69', '20.85', '21.65']);
    if (skewed.status !== 'adopted') throw new Error('expected adopted');
    expect(skewed.legs.map((l) => [l.net, l.tax])).toEqual([
      ['25.91', '0.78'],
      ['20.24', '0.61'],
      ['21.02', '0.63'],
    ]);
  });

  it('user totals a cent off, of the wrong count or malformed are not taken: the item stays required', () => {
    const skewed = [leg(1, '26.70'), ...AA_LEGS.slice(1)];
    expect(allocate(AA_INVOICE, skewed, ['26.70', '20.85', '21.65'])).toMatchObject({ status: 'required', reason: 'answer_not_conserving' });
    expect(allocate(AA_INVOICE, skewed, ['69.19'])).toMatchObject({ status: 'required', reason: 'answer_not_conserving' });
    expect(allocate(AA_INVOICE, skewed, ['26.69', '20.85', '21.6'])).toMatchObject({ status: 'required', reason: 'answer_not_conserving' });
  });
});

describe('pairItineraries: link by equal declared total, uniquely both ways', () => {
  const invoice = (materialId: string, totalAmount: string): RideInvoice => ({ materialId, values: { ...AA_INVOICE, totalAmount } });
  const itinerary = (materialId: string, itineraryTotal: string): ItineraryRef => ({ materialId, values: { itineraryTotal } });

  it('pairs one invoice with the one itinerary of the same total; a lone itinerary stays unlinked', () => {
    expect(pairItineraries([invoice('a', '69.19'), invoice('b', '38.40')], [itinerary('x', '69.19'), itinerary('y', '12.00')])).toEqual({
      pairs: new Map([['a', 'x']]),
      ambiguous: [],
      unlinked: ['y'],
    });
  });

  it('an itinerary matching two invoices, or an invoice matching two itineraries, is ambiguous and links nothing', () => {
    expect(pairItineraries([invoice('a', '69.19'), invoice('b', '69.19')], [itinerary('x', '69.19')])).toEqual({
      pairs: new Map(),
      ambiguous: [{ itineraryId: 'x', invoiceIds: ['a', 'b'] }],
      unlinked: [],
    });
    expect(pairItineraries([invoice('a', '69.19')], [itinerary('x', '69.19'), itinerary('y', '69.19')])).toEqual({
      pairs: new Map(),
      ambiguous: [
        { itineraryId: 'x', invoiceIds: ['a'] },
        { itineraryId: 'y', invoiceIds: ['a'] },
      ],
      unlinked: [],
    });
  });
});
