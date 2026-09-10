import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BAOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-catalog-freshness-'));

const { catalogFreshFor } = await import('../src/observe.mjs');
const { linesDigest } = await import('../src/selection.mjs');

const identity = { account: 'alice', tenant: 'tenant-a' };
const built = {
  versionId: 'version-1',
  lineItems: [{ lineId: 'line-1', voucherMaterialId: 'invoice-1', date: '2026-09-01',
    endDate: null, city: '广州', totalAmount: '10.00', expenseItemCode: 'E-1',
    expenseItemName: '交通' }],
};
const selection = {
  linesDigest: linesDigest(built),
  versionId: built.versionId,
  projects: { 'line-1': 'P-1' },
  projectSource: 'erp_catalog_confirmed',
  projectsFrom: 'project_book',
  identity,
};
const candidates = [{ number: 'P-1', name: '项目一' }];
const lines = [{ lineId: 'line-1', project: 'P-1', expenseItemCode: 'E-1', expenseItemName: '交通' }];
const catalog = {
  catalogSchemaVersion: 2,
  linesDigest: selection.linesDigest,
  versionId: built.versionId,
  identity,
  projects: { 'P-1': { verdict: 'confirmed', name: '项目一' } },
  expenseItems: [{ code: 'E-1', name: '交通', verdict: 'confirmed' }],
  selectionSnapshot: {
    projects: { 'line-1': 'P-1' },
    projectBook: [{ number: 'P-1', name: '项目一' }],
  },
};

const input = (over = {}) => ({ catalog, built, selection, candidates, identity, lines, ...over });

test('catalog freshness is scoped to the task identity and selected project facts', () => {
  assert.equal(catalogFreshFor(input()), true);
  assert.equal(catalogFreshFor(input({ identity: { account: 'bob', tenant: 'tenant-a' } })), false);
  assert.equal(catalogFreshFor(input({ catalog: {
    ...catalog, identity: { account: 'bob', tenant: 'tenant-a' },
  } })), false);
  assert.equal(catalogFreshFor(input({ catalog: {
    ...catalog, projects: { 'P-1': { verdict: 'name_mismatch', name: '旧项目名' } },
  } })), true);
  assert.equal(catalogFreshFor(input({ catalog: {
    ...catalog, projects: { 'P-1': { verdict: 'missing', name: null } },
  } })), true);
  assert.equal(catalogFreshFor(input({ candidates: [{ number: 'P-1', name: '当前项目名' }] })), false);
  assert.equal(catalogFreshFor(input({ catalog: { ...catalog, expenseItems: null } })), false);
});

test('a complete negative ERP result is fresh enough to expose catalog mismatch', () => {
  assert.equal(catalogFreshFor(input({ catalog: {
    ...catalog,
    projects: { 'P-1': { verdict: 'not_found', name: null } },
    expenseItems: [{ code: 'E-1', name: '交通', verdict: 'not_found' }],
  } })), true);
});

test('ERP rename remains a fresh business mismatch until the project book changes', () => {
  assert.equal(catalogFreshFor(input({ catalog: {
    ...catalog,
    projects: { 'P-1': { verdict: 'name_mismatch', name: 'ERP 新名称' } },
  } })), true);
  assert.equal(catalogFreshFor(input({ catalog: {
    ...catalog,
    projects: { 'P-1': { verdict: 'confirmed', name: 'ERP 新名称' } },
  }, candidates: [{ number: 'P-1', name: '项目二' }] })), false);
});
