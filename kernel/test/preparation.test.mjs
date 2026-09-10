import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-preparation-home-'));
process.env.BAOX_HOME = home;

const { takeInventory } = await import('../src/inventory.mjs');
const { classifyInventory } = await import('../src/classify.mjs');
const { buildEvents } = await import('../src/events.mjs');
const { linesDigest } = await import('../src/selection.mjs');
const {
  buildPreparation,
  generatePreparation,
  inspectPreparation,
} = await import('../src/preparation.mjs');

const repo = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const resources = path.join(repo, 'resources');
const IDENTITY = { account: 'fixture.user', tenant: 'fixture-tenant' };

async function realCase() {
  const fullInventory = await takeInventory(resources);
  const classification = classifyInventory(resources, fullInventory, null, { mode: 'legacy' });
  const classifiedIds = new Set(classification.results
    .filter((result) => result.role === 'primary_voucher' || result.role === 'reference')
    .map((result) => result.materialId));
  const explicitlyExcluded = fullInventory.materials.filter((material) => !classifiedIds.has(material.materialId));
  const inventory = {
    ...fullInventory,
    materials: fullInventory.materials.filter((material) => classifiedIds.has(material.materialId)),
    excluded: [...(fullInventory.excluded ?? []), ...explicitlyExcluded],
  };
  const built = buildEvents(classification);
  const task = {
    taskId: 'preparation-test',
    createdAt: '2026-09-09T00:00:00.000Z',
    sourceKey: 'fixture-source',
    sourceLabel: 'resources',
    currentVersionId: inventory.versionId,
    identity: IDENTITY,
    homeCity: '广州',
  };
  const projects = { P1: { verdict: 'confirmed', name: '测试项目' } };
  const expenseItems = {
    E1: { verdict: 'confirmed', name: '住宿' },
    E2: { verdict: 'confirmed', name: '本地市内交通' },
    E3: { verdict: 'confirmed', name: '长途交通' },
  };
  const lines = built.lineItems.map((line) => {
    const event = built.events.find((item) => item.eventId === line.eventId);
    const accommodation = event.kind === 'vat_special';
    const rail = event.kind === 'rail_eticket';
    return {
      ...line,
      ...(rail ? { origin: '合肥南', destination: '广州南', routeComplete: true } : {}),
      ...(accommodation ? { city: '合肥' } : {}),
      category: accommodation ? 'accommodation' : rail ? 'long_distance' : 'local_city_transport',
      categoryLabel: accommodation ? '住宿' : rail ? '长途交通' : '本地市内交通',
      projectCode: 'P1',
      projectName: '测试项目',
      projectSource: 'erp_catalog_confirmed',
      projectsFrom: 'project_book',
      expenseItemCode: accommodation ? 'E1' : rail ? 'E3' : 'E2',
      expenseItemName: accommodation ? '住宿' : rail ? '长途交通' : '本地市内交通',
      expenseItemSource: 'erp_catalog_confirmed',
      invoiceType: rail ? '火车票' : accommodation ? '增值税发票' : '其他运输票',
      invoiceTypeSource: rail ? 'save-contract:rail_eticket'
        : accommodation ? 'save-contract:vat_special' : 'save-contract:passenger_transport',
      fieldSources: {
        date: event.dateEvidence ?? 'fixture-date',
        endDate: accommodation ? 'hotel-folio:checkOut' : 'same-day-expense-date',
        amounts: event.amountSource,
        project: 'project-book:fixture',
        expenseItem: 'erp-catalog:fixture',
        invoiceType: 'save-contract:fixture',
        ...(rail || !accommodation ? {
          origin: rail ? 'invoice-face:railFrom' : 'ride-itinerary:origin',
          destination: rail ? 'invoice-face:railTo' : 'ride-itinerary:destination',
          route: rail ? 'invoice-face:railFrom/railTo' : 'ride-itinerary:route',
        } : { city: 'hotel-folio:city' }),
      },
    };
  });
  const selection = {
    versionId: built.versionId,
    linesDigest: linesDigest({ lineItems: lines }),
    identity: IDENTITY,
    homeCity: '广州',
    purpose: '客户支持',
    projects: Object.fromEntries(lines.map((line) => [line.lineId, 'P1'])),
    projectSource: 'erp_catalog_confirmed',
    projectsFrom: 'project_book',
  };
  const catalog = {
    versionId: built.versionId,
    linesDigest: selection.linesDigest,
    identity: IDENTITY,
    projects,
    expenseItems,
  };
  const rail = classification.results.find((result) => result.kind === 'rail_eticket');
  const railEvent = built.events.find((event) => event.kind === 'rail_eticket');
  const receiptFacts = {
    fresh: true,
    taskId: task.taskId,
    versionId: built.versionId,
    identity: IDENTITY,
    readAt: new Date().toISOString(),
    rows: [{
      voucherMaterialId: rail.materialId,
      contentHash: rail.contentHash,
      identityKey: rail.identity.key,
      netAmount: '644.95',
      taxAmount: '58.05',
      grossAmount: '703.00',
      source: 'erp_receipt',
    }],
  };
  return {
    sourceDir: resources,
    task,
    inventory,
    classification,
    built,
    lines,
    selection,
    catalog,
    receiptFacts,
  };
}

test('real PDF bytes with simulated business context build a ready portable preparation bundle', async () => {
  const input = await realCase();
  const preparation = buildPreparation({ ...input, classifiedConfirmed: true,
    projectCandidates: [{ number: 'P1', name: '测试项目' }] });

  assert.equal(preparation.ready, true, preparation.problems.map((problem) => problem.code).join(', '));
  assert.equal(preparation.document.invoices.length, 3);
  assert.equal(preparation.document.evidence.length, 2);
  assert.equal(preparation.document.invoices.every((invoice) => invoice.targetPath.startsWith('invoices/')), true);
  assert.equal(preparation.document.evidence.every((evidence) => evidence.targetPath.startsWith('evidence/')), true);
  assert.equal(preparation.document.invoices.some((invoice) => invoice.identity.scheme === 'einvoice-20'), true);
  assert.ok(preparation.document.lines.find((line) => line.route === '合肥南 → 广州南'));
  const hotelLine = preparation.document.lines.find((line) => line.category === 'accommodation');
  assert.equal(hotelLine.city, '合肥');
  assert.match(hotelLine.fieldSources.city, /hotel-folio:city/);

  const before = crypto.createHash('sha256').update(fs.readFileSync(
    path.join(resources, '长途', '26349119423005877606.pdf'))).digest('hex');
  const result = await generatePreparation({ ...input, preparation });
  const inspection = inspectPreparation({ task: input.task, preparation: result });
  assert.equal(inspection.status, 'valid');
  assert.equal(inspection.ready, true);
  assert.deepEqual(inspection.document, preparation.document);
  assert.ok(fs.existsSync(path.join(result.directory, 'invoices')));
  assert.ok(fs.existsSync(path.join(result.directory, 'evidence')));
  assert.equal(fs.existsSync(path.join(resources, 'invoices')), false);
  const after = crypto.createHash('sha256').update(fs.readFileSync(
    path.join(resources, '长途', '26349119423005877606.pdf'))).digest('hex');
  assert.equal(after, before);
  const detail = fs.readFileSync(path.join(result.directory, 'detail.md'), 'utf8');
  assert.match(detail, /合肥南 → 广州南/);
  assert.match(detail, /费用项目编码/);
  assert.match(detail, /明细总额: 4394\.63 元/);
  assert.match(detail, /入住至离店: 2026-08-09 至 2026-08-22/);
  assert.match(detail, /不含税金额: 50\.12 元/);
  assert.match(detail, /\]\(invoices\/m-.*\.pdf\)/);
});

test('rail amount rule does not depend on stale or legacy receipt facts', async () => {
  const input = await realCase();
  const stale = buildPreparation({ ...input, classifiedConfirmed: true,
    projectCandidates: [{ number: 'P1', name: '测试项目' }],
    receiptFacts: { ...input.receiptFacts,
      readAt: new Date(Date.now() - 16 * 60 * 1000).toISOString() },
  });
  const staleLine = stale.document.lines.find((line) => line.kind === 'rail_eticket');
  assert.equal(stale.ready, true);
  assert.equal(staleLine.netCents, 70300);
  assert.equal(staleLine.taxCents, 0);
  assert.equal(staleLine.totalCents, 70300);
  assert.equal(staleLine.amountSource, 'rail_total_tax_zero_rule');

  const legacy = buildPreparation({ ...input, classifiedConfirmed: true,
    projectCandidates: [{ number: 'P1', name: '测试项目' }],
    receiptFacts: {
      taskId: input.task.taskId, versionId: input.built.versionId, identity: input.task.identity,
      confirmed: true, source: 'erp_receipt_readback', facts: [{
        materialId: staleLine.voucherMaterialId, netCents: 1, taxCents: 2, totalCents: 3,
      }],
    },
  });
  const legacyLine = legacy.document.lines.find((line) => line.kind === 'rail_eticket');
  assert.equal(legacyLine.netCents, 70300);
  assert.equal(legacyLine.taxCents, 0);
  assert.equal(legacyLine.totalCents, 70300);
});

test('rail preparation ignores receipt net/tax and keeps the total-plus-zero-tax rule', async () => {
  const input = await realCase();
  const rail = input.receiptFacts.rows[0];
  const preparation = buildPreparation({ ...input, classifiedConfirmed: true,
    projectCandidates: [{ number: 'P1', name: '测试项目' }],
    receiptFacts: { ...input.receiptFacts, rows: [{ ...rail,
      netAmount: '645.87', taxAmount: '58.13', grossAmount: '704.00' }] },
  });
  const line = preparation.document.lines.find((item) => item.kind === 'rail_eticket');
  assert.equal(preparation.ready, true);
  assert.equal(line.totalCents, 70300);
  assert.equal(line.netCents, 70300);
  assert.equal(line.taxCents, 0);
  assert.equal(line.amountSource, 'rail_total_tax_zero_rule');
});

test('catalog identity, version, and line digest are required even with confirmed rows', async () => {
  const input = await realCase();
  const preparation = buildPreparation({ ...input, classifiedConfirmed: true,
    projectCandidates: [{ number: 'P1', name: '测试项目' }],
    catalog: { projects: input.catalog.projects, expenseItems: input.catalog.expenseItems },
  });
  assert.equal(preparation.ready, false);
  assert.ok(preparation.problems.some((problem) => problem.code === 'catalog_version_missing'));
  assert.ok(preparation.problems.some((problem) => problem.code === 'catalog_lines_digest_missing'));
  assert.ok(preparation.problems.some((problem) => problem.code === 'catalog_identity_missing'));
});

test('an in-scope material without a classified voucher role cannot be silently excluded', async () => {
  const input = await realCase();
  const unknown = { materialId: 'm-unclassified', relPath: 'missing.pdf', fileName: 'missing.pdf',
    format: 'pdf', contentHash: 'a'.repeat(64), size: 1, readStatus: 'ok' };
  const preparation = buildPreparation({ ...input,
    inventory: { ...input.inventory, materials: [...input.inventory.materials, unknown] },
    classifiedConfirmed: true,
    projectCandidates: [{ number: 'P1', name: '测试项目' }],
  });
  assert.equal(preparation.ready, false);
  assert.ok(preparation.problems.some((problem) => problem.code === 'material_unclassified'));
  assert.equal(preparation.document.excluded.some((item) => item.materialId === unknown.materialId), true);
});

test('rail total-plus-zero-tax is ready without receipt facts while unknown VAT mapping still blocks', async () => {
  const input = await realCase();
  const preparation = buildPreparation({ ...input, classifiedConfirmed: true,
    projectCandidates: [{ number: 'P1', name: '测试项目' }], receiptFacts: null,
  });
  assert.equal(preparation.ready, true);
  const railLine = preparation.document.lines.find((line) => line.kind === 'rail_eticket');
  assert.deepEqual({ net: railLine.netAmount, tax: railLine.taxAmount, total: railLine.totalAmount },
    { net: '703.00', tax: '0.00', total: '703.00' });

  const noRail = {
    ...input,
    classification: {
      ...input.classification,
      results: input.classification.results.filter((result) => result.kind !== 'rail_eticket'),
    },
    built: {
      ...input.built,
      events: input.built.events.filter((event) => event.kind !== 'rail_eticket'),
      lineItems: input.lines.filter((line) => line.kind !== 'rail_eticket'),
    },
    lines: input.lines.filter((line) => line.kind !== 'rail_eticket'),
  };
  noRail.selection = {
    ...input.selection,
    linesDigest: linesDigest({ lineItems: noRail.lines }),
    projects: Object.fromEntries(noRail.lines.map((line) => [line.lineId, 'P1'])),
  };
  noRail.catalog = { ...input.catalog, linesDigest: noRail.selection.linesDigest };
  const passenger = noRail.classification.results.find((result) => result.kind === 'passenger_transport');
  const ordinary = { ...passenger, kind: 'vat_common' };
  noRail.classification = {
    ...noRail.classification,
    results: noRail.classification.results.map((result) => result.materialId === passenger.materialId
      ? ordinary : result),
  };
  noRail.lines = noRail.lines.map((line, index) => index === 0
    ? { ...line, kind: 'vat_common', invoiceType: null, invoiceTypeSource: null,
      fieldSources: { ...line.fieldSources, invoiceType: null } } : line);
  noRail.built = { ...noRail.built, lineItems: noRail.lines };
  noRail.selection = { ...noRail.selection, linesDigest: linesDigest({ lineItems: noRail.lines }) };
  noRail.catalog = { ...noRail.catalog, linesDigest: noRail.selection.linesDigest };
  const unmapped = buildPreparation({ ...noRail, classifiedConfirmed: true,
    projectCandidates: [{ number: 'P1', name: '测试项目' }] });
  assert.equal(unmapped.ready, false);
  assert.ok(unmapped.problems.some((problem) => problem.code === 'invoice_type_mapping_missing'));
  const draft = await generatePreparation({ ...noRail, preparation: unmapped });
  assert.equal(inspectPreparation({ task: noRail.task, preparation: draft }).status, 'valid');
  assert.equal(draft.ready, false);
});

test('source changes, symlink escapes, and missing confirmation cannot silently reuse preparation facts', async () => {
  const input = await realCase();
  const preparation = buildPreparation({ ...input, classifiedConfirmed: true,
    projectCandidates: [{ number: 'P1', name: '测试项目' }] });
  const changed = buildPreparation({ ...input, classifiedConfirmed: true,
    projectCandidates: [{ number: 'P1', name: '测试项目' }],
    selection: { ...input.selection, purpose: 'changed purpose' },
  });
  assert.notEqual(changed.digest, preparation.digest);
  assert.equal(buildPreparation({ ...input, classifiedConfirmed: false,
    projectCandidates: [{ number: 'P1', name: '测试项目' }] }).ready, false);

  const recoveryTask = { ...input.task, taskId: 'preparation-recovery-task' };
  const recoveryInput = { ...input, task: recoveryTask };
  const recoveryPreparation = buildPreparation({ ...recoveryInput, classifiedConfirmed: true,
    projectCandidates: [{ number: 'P1', name: '测试项目' }] });
  const recovery = await generatePreparation({ ...recoveryInput, preparation: recoveryPreparation });
  const invoiceTarget = recovery.files.invoices[0];
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'baox-preparation-outside-'));
  const secret = path.join(outside, 'secret.pdf');
  await fsp.writeFile(secret, Buffer.from('%PDF-SECRET'));
  await fsp.rm(invoiceTarget);
  await fsp.symlink(secret, invoiceTarget);
  const broken = inspectPreparation({ task: recoveryTask, preparation: recovery });
  assert.equal(broken.ok, false);
  assert.ok(broken.problems.some((problem) => problem.code === 'bundle_symlink_present'));
  const repaired = await generatePreparation({ ...recoveryInput, preparation: recoveryPreparation });
  assert.equal(inspectPreparation({ task: recoveryTask, preparation: repaired }).status, 'valid');
  const quarantined = (await fsp.readdir(path.dirname(repaired.directory)))
    .filter((name) => name.startsWith(`.invalid-${recoveryPreparation.digest}-`));
  assert.equal(quarantined.length, 1);

  const copiedSource = await fsp.mkdtemp(path.join(os.tmpdir(), 'baox-preparation-source-copy-'));
  await fsp.cp(resources, copiedSource, { recursive: true });
  const sourceChangeTask = { ...input.task, taskId: 'preparation-source-change-task' };
  const sourceChangeInput = { ...input, task: sourceChangeTask, sourceDir: copiedSource };
  const sourceChangePreparation = buildPreparation({ ...sourceChangeInput, classifiedConfirmed: true,
    projectCandidates: [{ number: 'P1', name: '测试项目' }] });
  await generatePreparation({ ...sourceChangeInput, preparation: sourceChangePreparation });
  const changedSource = path.join(copiedSource, sourceChangePreparation.document.invoices[0].sourceRelPath);
  await fsp.appendFile(changedSource, Buffer.from('changed'));
  await assert.rejects(() => generatePreparation({ ...sourceChangeInput,
    preparation: sourceChangePreparation }), /source changed since inventory|source changed since preparation build/);
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
