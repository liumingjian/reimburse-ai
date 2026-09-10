import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  convertPdf,
  hashMarkdown,
  ingest,
  load,
  loadCandidate,
  pendingWorkOrder,
  prepare,
  project,
  PDF_MARKDOWN_SCHEMA_PATH,
  validateArtifact,
  validateCandidate,
} from '../src/pdf-markdown.mjs';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'baox-pdf-markdown-'));

async function artifactFor(markdown, materialId = 'm-test') {
  const dir = tempDir();
  const sourcePath = path.join(dir, 'source.pdf');
  fs.writeFileSync(sourcePath, Buffer.from('%PDF-1.7\nfixture', 'ascii'));
  return convertPdf({
    sourcePath,
    materialId,
    converter: async () => ({ status: 'converted', markdown, title: 'fixture' }),
  });
}

function metadata(artifact, kind, documentType) {
  return {
    schemaVersion: 1,
    materialId: artifact.materialId,
    contentHash: artifact.contentHash,
    source: {
      kind: 'agent_from_markdown',
      converter: 'markitdown',
      converterVersion: '0.1.7',
      runtimeLockHash: artifact.source.runtimeLockHash,
      markdownHash: artifact.source.markdownHash,
    },
    documentType,
    kind,
  };
}

function evidence(lineStart, quote, lineEnd = lineStart) {
  return [{ lineStart, lineEnd, quote }];
}

function invoiceCandidate(artifact, overrides = {}) {
  return {
    ...metadata(artifact, 'vat_common', 'invoice'),
    kindEvidence: overrides.kindEvidence ?? evidence(1, '电子发票(普通发票)'),
    fields: {
      invoiceNumber: '12345678901234567890',
      issueDate: '2026-09-01',
      netAmount: '18.25',
      taxAmount: '0.55',
      totalAmount: '18.80',
      ...overrides.fields,
    },
    segments: [],
    fieldEvidence: {
      invoiceNumber: evidence(2, '发票号码:12345678901234567890'),
      issueDate: evidence(3, '开票日期:2026年09月01日'),
      netAmount: evidence(6, '¥18.25'),
      taxAmount: evidence(6, '¥0.55'),
      totalAmount: evidence(7, '¥18.80'),
      ...overrides.fieldEvidence,
    },
    fieldStatus: {
      invoiceNumber: 'explicit',
      issueDate: 'explicit',
      netAmount: 'explicit',
      taxAmount: 'explicit',
      totalAmount: 'explicit',
      ...overrides.fieldStatus,
    },
    fieldBasis: overrides.fieldBasis ?? {},
    unreadable: overrides.unreadable ?? [],
    issues: overrides.issues ?? [],
  };
}

const INVOICE_MARKDOWN = [
  '电子发票(普通发票)',
  '发票号码:12345678901234567890',
  '开票日期:2026年09月01日',
  '| 项目 | 金额 | 税额 |',
  '| --- | --- | --- |',
  '| 合计 | ¥18.25 | ¥0.55 |',
  '| 价税合计 | ¥18.80 | |',
].join('\n');

test('prepare/load preserves hashes and rejects a tampered artifact', async () => {
  const dir = tempDir();
  const sourcePath = path.join(dir, 'source.pdf');
  const artifactPath = path.join(dir, 'artifact.json');
  fs.writeFileSync(sourcePath, Buffer.from('%PDF-1.7\nfixture', 'ascii'));
  const prepared = await prepare({
    sourcePath,
    materialId: 'm-1',
    outputPath: artifactPath,
    converter: async () => ({ status: 'converted', markdown: INVOICE_MARKDOWN, title: 'invoice' }),
  });
  assert.equal(prepared.artifact.status, 'converted');
  assert.equal(prepared.artifact.source.markdownHash, hashMarkdown(INVOICE_MARKDOWN));
  assert.equal(load(artifactPath, { sourcePath, materialId: 'm-1' }).contentHash, prepared.artifact.contentHash);
  const lockTampered = structuredClone(prepared.artifact);
  lockTampered.source.runtimeLockHash = '0'.repeat(64);
  assert.equal(validateArtifact(lockTampered).error.code, 'RUNTIME_LOCK_HASH');
  const tampered = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  tampered.markdown = `${tampered.markdown}\nchanged`;
  fs.writeFileSync(artifactPath, JSON.stringify(tampered));
  assert.throws(() => load(artifactPath), (error) => error.code === 'ARTIFACT_NUMBERING');
});

test('empty and converter failure are explicit loadable states', async () => {
  const dir = tempDir();
  const sourcePath = path.join(dir, 'source.pdf');
  fs.writeFileSync(sourcePath, Buffer.from('%PDF-1.7\nfixture', 'ascii'));
  const empty = await convertPdf({ sourcePath, converter: async () => ({ status: 'empty', markdown: '' }) });
  assert.equal(empty.status, 'empty');
  assert.equal(empty.error.code, 'MARKDOWN_EMPTY');
  const failed = await convertPdf({ sourcePath, converter: async () => ({ status: 'failed', markdown: '', error: { code: 'x', message: 'broken' } }) });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'x');
  const protocol = await convertPdf({ sourcePath, converter: async () => ({ status: 'unexpected', markdown: 'ignored' }) });
  assert.equal(protocol.status, 'failed');
  assert.equal(protocol.error.code, 'CONVERTER_PROTOCOL');
});

test('pending work order uses an empty closed fields object and per-kind field catalog', async () => {
  const artifact = await artifactFor(INVOICE_MARKDOWN);
  const order = pendingWorkOrder(artifact);
  assert.equal(order.status, 'ready');
  assert.deepEqual(order.candidateTemplate.fields, {});
  assert.deepEqual(order.candidateTemplate.kindEvidence, []);
  assert.ok(order.instructions.fields.vat_common.includes('invoiceNumber'));
  assert.ok(!order.instructions.fields.vat_common.includes('checkIn'));
  assert.match(order.numberedMarkdown, /^1 \| /);
});

test('candidate evidence must support the normalized date, money, and number values', async () => {
  const artifact = await artifactFor(INVOICE_MARKDOWN);
  const valid = validateCandidate(artifact, invoiceCandidate(artifact));
  assert.equal(valid.verdict, 'accepted');
  assert.equal(valid.record.status, 'accepted_with_issues');

  const badMoney = invoiceCandidate(artifact, { fields: { netAmount: '99.99' } });
  assert.equal(validateCandidate(artifact, badMoney).verdict, 'rejected');
  const badDate = invoiceCandidate(artifact, { fields: { issueDate: '2026-09-02' } });
  assert.equal(validateCandidate(artifact, badDate).verdict, 'rejected');
  const badNumber = invoiceCandidate(artifact, { fields: { invoiceNumber: '02345678901234567890' } });
  assert.equal(validateCandidate(artifact, badNumber).verdict, 'rejected');
  const badLine = invoiceCandidate(artifact, { fieldEvidence: { totalAmount: evidence(6, '¥18.25') } });
  assert.equal(validateCandidate(artifact, badLine).verdict, 'rejected');
  const badPage = invoiceCandidate(artifact, { fieldEvidence: { totalAmount: [{ lineStart: 7, lineEnd: 7, page: 1, quote: '¥18.80' }] } });
  assert.equal(validateCandidate(artifact, badPage).verdict, 'rejected');
});

test('money evidence must identify the net and tax columns, not only contain both tokens', async () => {
  const artifact = await artifactFor(INVOICE_MARKDOWN);
  const swapped = invoiceCandidate(artifact, {
    fields: { netAmount: '0.55', taxAmount: '18.25' },
    fieldEvidence: {
      netAmount: evidence(6, '¥0.55'),
      taxAmount: evidence(6, '¥18.25'),
    },
  });
  const result = validateCandidate(artifact, swapped);
  assert.equal(result.verdict, 'rejected');
  assert.ok(result.errors.some((error) => error.includes('netAmount evidence')));

  const combinedQuote = invoiceCandidate(artifact, {
    fieldEvidence: {
      netAmount: evidence(6, '| 合计 | ¥18.25 | ¥0.55 |'),
      taxAmount: evidence(6, '| 合计 | ¥18.25 | ¥0.55 |'),
    },
  });
  const combinedResult = validateCandidate(artifact, combinedQuote);
  assert.equal(combinedResult.verdict, 'rejected');
  assert.ok(combinedResult.errors.some((error) => error.includes('netAmount evidence')));
});

test('kind evidence must match a native document marker', async () => {
  const artifact = await artifactFor(INVOICE_MARKDOWN);
  const wrongKind = invoiceCandidate(artifact);
  wrongKind.kind = 'passenger_transport';
  const result = validateCandidate(artifact, wrongKind);
  assert.equal(result.verdict, 'rejected');
  assert.ok(result.errors.some((error) => error.includes('native kindEvidence')));

  const missing = invoiceCandidate(artifact);
  delete missing.kindEvidence;
  assert.equal(validateCandidate(artifact, missing).verdict, 'rejected');
});

test('candidate envelope requires every closed shape and rejects invalid enum values', async () => {
  const artifact = await artifactFor(INVOICE_MARKDOWN);
  const candidate = invoiceCandidate(artifact);
  const schema = JSON.parse(fs.readFileSync(PDF_MARKDOWN_SCHEMA_PATH, 'utf8'));
  assert.deepEqual(schema.required, [
    'schemaVersion', 'materialId', 'contentHash', 'source', 'documentType', 'kind',
    'kindEvidence', 'fields', 'segments', 'fieldEvidence', 'fieldStatus', 'fieldBasis', 'unreadable', 'issues',
  ]);
  assert.equal(schema.properties.kindEvidence.minItems, 1);
  assert.equal(schema.properties.fieldEvidence.additionalProperties.minItems, 1);
  assert.equal(schema.$defs.segment.properties.fieldEvidence.additionalProperties.minItems, 1);

  for (const key of ['source', 'documentType', 'kind', 'kindEvidence', 'fields', 'segments', 'fieldEvidence',
    'fieldStatus', 'fieldBasis', 'unreadable', 'issues']) {
    const missing = structuredClone(candidate);
    delete missing[key];
    assert.equal(validateCandidate(artifact, missing).verdict, 'rejected', `missing ${key}`);
  }

  const badStatus = structuredClone(candidate);
  badStatus.fieldStatus.issueDate = 'accepted';
  assert.equal(validateCandidate(artifact, badStatus).verdict, 'rejected');
  const duplicateUnreadable = structuredClone(candidate);
  duplicateUnreadable.unreadable = ['issueDate', 'issueDate'];
  assert.equal(validateCandidate(artifact, duplicateUnreadable).verdict, 'rejected');
  const emptyIssueNote = structuredClone(candidate);
  emptyIssueNote.issues = [{ code: 'review', note: '' }];
  assert.equal(validateCandidate(artifact, emptyIssueNote).verdict, 'rejected');
});

test('rail candidates keep missing net/tax as a blocking issue without inventing values', async () => {
  const markdown = [
    '电子发票(铁路电子客票)',
    '发票号码:26349119423005877606',
    '开票日期:2026年09月02日',
    '票价:¥703.00',
  ].join('\n');
  const artifact = await artifactFor(markdown, 'rail-1');
  const candidate = {
    ...metadata(artifact, 'rail_eticket', 'invoice'),
    kindEvidence: evidence(1, '电子发票(铁路电子客票)'),
    fields: { invoiceNumber: '26349119423005877606', issueDate: '2026-09-02', totalAmount: '703.00' },
    segments: [],
    fieldEvidence: {
      invoiceNumber: evidence(2, '发票号码:26349119423005877606'),
      issueDate: evidence(3, '开票日期:2026年09月02日'),
      totalAmount: evidence(4, '票价:¥703.00'),
    },
    fieldStatus: { invoiceNumber: 'explicit', issueDate: 'explicit', totalAmount: 'explicit' },
    fieldBasis: {},
    unreadable: [],
    issues: [],
  };
  const result = validateCandidate(artifact, candidate);
  assert.equal(result.verdict, 'accepted');
  assert.equal(result.record.fields.netAmount, null);
  assert.ok(result.record.issues.some((entry) => entry.code === 'amount_not_on_face'));
  const parsed = project(result.record);
  assert.equal(parsed.fields.totalAmount.cents, 70300);
  assert.equal(parsed.fields.netAmount, undefined);
  assert.equal(parsed.candidateSources.source, 'agent_from_markdown');
});

test('ride itinerary validates segment count and exact total conservation', async () => {
  const markdown = [
    '高德地图行程单',
    '共计2单行程，合计3.00元',
    '1 2026-09-01 08:30 广州市 天河区 → 越秀区 1.00元',
    '2 2026-09-01 09:30 广州市 越秀区 → 海珠区 2.00元',
  ].join('\n');
  const artifact = await artifactFor(markdown, 'ride-1');
  const base = metadata(artifact, 'ride_itinerary', 'ride_itinerary');
  const candidate = {
    ...base,
    kindEvidence: evidence(1, '高德地图行程单'),
    fields: { totalAmount: '3.00', segmentCount: 2 },
    segments: [
      {
        index: 1, travelDate: '2026-09-01', time: '08:30', city: '广州市', origin: '天河区', destination: '越秀区', amount: '1.00',
        fieldEvidence: {
          travelDate: evidence(3, '1 2026-09-01 08:30 广州市 天河区 → 越秀区 1.00元'),
          time: evidence(3, '1 2026-09-01 08:30 广州市 天河区 → 越秀区 1.00元'),
          city: evidence(3, '1 2026-09-01 08:30 广州市 天河区 → 越秀区 1.00元'),
          origin: evidence(3, '1 2026-09-01 08:30 广州市 天河区 → 越秀区 1.00元'),
          destination: evidence(3, '1 2026-09-01 08:30 广州市 天河区 → 越秀区 1.00元'),
          amount: evidence(3, '1 2026-09-01 08:30 广州市 天河区 → 越秀区 1.00元'),
        },
        fieldStatus: { travelDate: 'explicit', time: 'explicit', city: 'explicit', origin: 'explicit', destination: 'explicit', amount: 'explicit' },
        fieldBasis: {},
        unreadable: [],
      },
      {
        index: 2, travelDate: '2026-09-01', time: '09:30', city: '广州市', origin: '越秀区', destination: '海珠区', amount: '2.00',
        fieldEvidence: {
          travelDate: evidence(4, '2 2026-09-01 09:30 广州市 越秀区 → 海珠区 2.00元'),
          time: evidence(4, '2 2026-09-01 09:30 广州市 越秀区 → 海珠区 2.00元'),
          city: evidence(4, '2 2026-09-01 09:30 广州市 越秀区 → 海珠区 2.00元'),
          origin: evidence(4, '2 2026-09-01 09:30 广州市 越秀区 → 海珠区 2.00元'),
          destination: evidence(4, '2 2026-09-01 09:30 广州市 越秀区 → 海珠区 2.00元'),
          amount: evidence(4, '2 2026-09-01 09:30 广州市 越秀区 → 海珠区 2.00元'),
        },
        fieldStatus: { travelDate: 'explicit', time: 'explicit', city: 'explicit', origin: 'explicit', destination: 'explicit', amount: 'explicit' },
        fieldBasis: {},
        unreadable: [],
      },
    ],
    fieldEvidence: { totalAmount: evidence(2, '共计2单行程，合计3.00元'), segmentCount: evidence(2, '共计2单行程，合计3.00元') },
    fieldStatus: { totalAmount: 'explicit', segmentCount: 'explicit' },
    fieldBasis: {},
    unreadable: [],
    issues: [],
  };
  assert.equal(validateCandidate(artifact, candidate).verdict, 'accepted');
  const missingSegmentEvidence = structuredClone(candidate);
  delete missingSegmentEvidence.segments[0].fieldEvidence;
  assert.equal(validateCandidate(artifact, missingSegmentEvidence).verdict, 'rejected');
  const mismatch = structuredClone(candidate);
  mismatch.segments[1].amount = '2.01';
  assert.equal(validateCandidate(artifact, mismatch).verdict, 'rejected');
});

test('ingest persists only an accepted record and loadCandidate always revalidates with the artifact', async () => {
  const dir = tempDir();
  const artifact = await artifactFor(INVOICE_MARKDOWN, 'm-ingest');
  const artifactPath = path.join(dir, 'artifact.json');
  const candidatePath = path.join(dir, 'candidate.json');
  const candidate = invoiceCandidate(artifact);
  fs.writeFileSync(artifactPath, JSON.stringify(artifact));
  const result = await ingest({ artifactPath, submission: candidate, outputPath: candidatePath });
  assert.equal(result.verdict, 'accepted');
  assert.equal(loadCandidate(candidatePath, { artifactPath }).source.kind, 'agent_from_markdown');
  assert.throws(() => loadCandidate(candidatePath), (error) => error.code === 'ARTIFACT_REQUIRED');
  const rejectedPath = path.join(dir, 'rejected.json');
  const rejected = await ingest({ artifact, submission: invoiceCandidate(artifact, { fields: { totalAmount: '99.99' } }), outputPath: rejectedPath });
  assert.equal(rejected.verdict, 'rejected');
  assert.equal(fs.existsSync(rejectedPath), false);
});
