import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ParseOutcome } from '../parse/dispatch';
import type { ParseInput } from '../parse/material';
import { runPrivateGate, THRESHOLDS, type CorpusParser } from './private-gate';

// Slice 16 (#196): `pnpm test:private` gates parser accuracy on the private corpus. These tests build a throwaway
// corpus with a fake parser, so they never need the real samples.

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'baox-private-corpus-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const SECRET_FILE = 'zz-secret-name-4711';
const SECRET_VALUES = ['SecretSeller-9931', '8827.33', 'WrongValue-5512', 'ExtractedOnly-6620'];

function put(relativePath: string, content = 'bytes') {
  const path = join(root, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function expectFields(relativePath: string, fields: Record<string, string>) {
  put(`${relativePath}.expected.json`, JSON.stringify(fields));
}

// The fake reads what to return from the file content, so each sample decides its own outcome.
const fakeParser: CorpusParser = async (input: ParseInput): Promise<ParseOutcome> => {
  const spec = JSON.parse(new TextDecoder().decode(input.bytes)) as { kind?: string; layout?: string; values?: Record<string, string>; outcome?: string };
  if (spec.outcome === 'unrecognised') return { outcome: 'unrecognised', reason: 'no_layout' };
  const kind = spec.kind as 'vat_invoice';
  const source = `rule:${spec.kind}/${spec.layout}`;
  return {
    outcome: 'recognised',
    kind,
    layout: spec.layout ?? '',
    parserVersion: '1',
    kindLabel: 'x',
    findings: [],
    missing: [],
    candidates: Object.entries(spec.values ?? {}).map(([key, value]) => ({ key, value, source, parserVersion: '1', evidence: 'ok' as never, refs: [] })),
  };
};

const sample = (kind: string, layout: string, values: Record<string, string>) => JSON.stringify({ kind, layout, values });

async function run(corpus: string | undefined) {
  const lines: string[] = [];
  const code = await runPrivateGate(corpus, { parse: fakeParser, out: (line) => lines.push(line) });
  return { code, report: lines.join('\n') };
}

describe('pnpm test:private (#196)', () => {
  it('prints per-layout, per-field accuracy and exits non-zero when a field falls below its threshold', async () => {
    const good = sample('vat_invoice', 'einvoice', { sellerName: SECRET_VALUES[0]!, totalAmount: SECRET_VALUES[1]!, buyerName: SECRET_VALUES[3]! });
    put(`vat_invoice/einvoice/${SECRET_FILE}-1.pdf`, good);
    expectFields(`vat_invoice/einvoice/${SECRET_FILE}-1.pdf`, { sellerName: SECRET_VALUES[0]!, totalAmount: SECRET_VALUES[1]! });
    put(`vat_invoice/einvoice/${SECRET_FILE}-2.pdf`, good);
    expectFields(`vat_invoice/einvoice/${SECRET_FILE}-2.pdf`, { sellerName: SECRET_VALUES[2]!, totalAmount: SECRET_VALUES[1]! });

    const { code, report } = await run(root);

    expect(report).toMatch(/vat_invoice\/einvoice\s+pdf\s+sellerName\s+1\/2\s+50\.0%\s+>= 100\.0%\s+FAIL/);
    expect(report).toMatch(/vat_invoice\/einvoice\s+pdf\s+totalAmount\s+2\/2\s+100\.0%\s+>= 100\.0%\s+ok/);
    expect(code).toBe(1);
  });

  it('exits 0 when every layout, field and recognition rate meets its threshold', async () => {
    put('taxi_receipt/machine_printed/a.jpg', sample('taxi_receipt', 'machine_printed', { invoiceNumber: '1' }));
    expectFields('taxi_receipt/machine_printed/a.jpg', { invoiceNumber: '1' });
    put('unrecognised/b.pdf', JSON.stringify({ outcome: 'unrecognised' }));

    const { code, report } = await run(root);

    expect(report).toMatch(/taxi_receipt\/machine_printed\s+image\s+invoiceNumber\s+1\/1\s+100\.0%\s+>= 98\.0%\s+ok/);
    expect(report).toMatch(/unrecognised\s+pdf\s+\(recognition\)\s+1\/1\s+100\.0%\s+>= 100\.0%\s+ok/);
    expect(code).toBe(0);
  });

  it('fails a layout whose samples land in another layout, even without field expectations', async () => {
    put('rail_ticket/12306/a.pdf', sample('vat_invoice', 'einvoice', {}));

    const { code, report } = await run(root);

    expect(report).toMatch(/rail_ticket\/12306\s+pdf\s+\(recognition\)\s+0\/1\s+0\.0%\s+>= 100\.0%\s+FAIL/);
    expect(code).toBe(1);
  });

  it('skips cleanly (exit 0) when BAOX_PRIVATE_CORPUS is unset', async () => {
    const { code, report } = await run(undefined);
    expect(code).toBe(0);
    expect(report).toContain('skipped');
  });

  it('never prints a field value, a file name or a path', async () => {
    put(`vat_invoice/einvoice/${SECRET_FILE}.pdf`, sample('vat_invoice', 'einvoice', { sellerName: SECRET_VALUES[3]!, totalAmount: SECRET_VALUES[1]! }));
    expectFields(`vat_invoice/einvoice/${SECRET_FILE}.pdf`, { sellerName: SECRET_VALUES[2]!, totalAmount: SECRET_VALUES[1]! });
    put(`${SECRET_FILE}-stray.pdf`, 'not json');
    put(`unrecognised/${SECRET_FILE}.png`, sample('vat_invoice', 'einvoice', { sellerName: SECRET_VALUES[0]! }));

    const { report } = await run(root);

    expect(report.length).toBeGreaterThan(0);
    expect(report).not.toContain(SECRET_FILE);
    expect(report).not.toContain(root);
    expect(report).not.toContain(tmpdir());
    for (const value of SECRET_VALUES) expect(report).not.toContain(value);
  });

  it('records a threshold for every medium', () => {
    expect(THRESHOLDS.pdf).toEqual({ recognition: 1, field: 1 });
    expect(THRESHOLDS.image).toEqual({ recognition: 0.98, field: 0.98 });
  });
});
