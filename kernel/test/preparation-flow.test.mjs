import test from 'node:test';
import assert from 'node:assert/strict';

import { determineState } from '../src/state.mjs';
import { stepFor } from '../src/next.mjs';

const identity = { account: 'fixture.user', tenant: 'fixture-tenant', displayName: '测试员工' };

const observation = (over = {}) => ({
  schemaVersion: 1,
  nodeVersion: '22.14.0',
  nodeMajor: 22,
  cdpUp: true,
  probe: { status: 'matched', identity },
  binding: identity,
  taskObserved: true,
  task: {
    taskId: 'preparation-flow',
    sourceLabel: '材料',
    sourceDir: '/tmp/材料',
    workspace: '/tmp/baox/tasks/preparation-flow',
    currentVersionId: 'version-1',
    identity,
    erpWriteState: null,
  },
  sourceDir: '/tmp/材料',
  inventoryStale: false,
  classificationRecorded: true,
  homeCityRequired: false,
  events: { versionId: 'version-1' },
  eventsRecorded: true,
  openItems: [],
  allocationRound: null,
  classifiedDetailComplete: true,
  classifiedDetailConfirmed: true,
  selectionApplied: true,
  lines: [{ lineId: 'line-1', project: 'P1', totalAmount: '10.00' }],
  projectBook: { empty: false, selectableCount: 1 },
  catalogFresh: true,
  catalogProblems: [],
  preparation: {
    digest: 'preparation-digest-1',
    ready: true,
    problems: [],
    document: {
      phase: 'preparation',
      status: 'ready_for_preparation',
      task: { taskId: 'preparation-flow', versionId: 'version-1' },
      identity,
      lines: [],
      invoices: [],
      evidence: [],
      excluded: [],
      problems: [],
      digest: 'preparation-digest-1',
    },
  },
  preparationPackageCurrent: true,
  preparationPackage: {
    directory: '/tmp/baox/tasks/preparation-flow/preparation/preparation-digest-1',
    files: { detailJson: '/tmp/detail.json', detailMarkdown: '/tmp/detail.md', manifest: '/tmp/manifest.json' },
    manifestHash: 'manifest-hash-1',
    bundleHash: 'bundle-hash-1',
  },
  preparationConfirmed: false,
  ...over,
});

test('缺少当前准备包时先发 prepare run step', () => {
  const result = determineState(observation({ preparationPackageCurrent: false }));
  assert.equal(result.state, 'preparation_package_pending');
  assert.equal(result.actor, 'kernel');
  assert.equal(result.blockedBy[0].kind, 'preparation_package_required');

  const step = stepFor(result.state, observation({ preparationPackageCurrent: false }), result.blockedBy);
  assert.equal(step.step.kind, 'run');
  assert.ok(step.step.argv.includes('prepare'));
  assert.ok(step.step.argv.includes('--dir'));
  assert.equal(step.exit, 0);
});

test('准备包即使有缺项也先停在可审阅的 blocked 状态', () => {
  const result = determineState(observation({
    preparation: {
      ...observation().preparation,
      ready: false,
      problems: [{ code: 'rail_net_tax_missing', message: '铁路票面未提供净额和税额' }],
    },
  }));
  assert.equal(result.state, 'preparation_blocked');
  assert.equal(result.blockedBy[0].kind, 'rail_net_tax_missing');
  const step = stepFor(result.state, observation({
    preparation: { ...observation().preparation, ready: false,
      problems: [{ code: 'rail_net_tax_missing', message: '铁路票面未提供净额和税额' }] },
  }), result.blockedBy);
  assert.equal(step.step.kind, 'tell_user');
  assert.equal(step.exit, 2);
  assert.match(step.speak, /发票目录和填写明细已经生成/);
});

test('完整准备只进入独立确认，旧 writeApproved 不会代替它', () => {
  const input = observation({ writeApproved: true });
  const result = determineState(input);
  assert.equal(result.state, 'preparation_confirmation');
  const step = stepFor(result.state, input, result.blockedBy);
  assert.equal(step.step.kind, 'confirm_table');
  assert.equal(step.step.acceptsCorrection, false);
  assert.ok(step.stepMeta.preparationDigest);
  assert.equal(step.stepMeta.packageManifestHash, 'manifest-hash-1');
  assert.equal(step.stepMeta.packageBundleHash, 'bundle-hash-1');
  assert.match(step.speak, /发票目录和填写明细已经完整/);
});

test('准备确认后的终点明确停在手动 QA', () => {
  const input = observation({ preparationConfirmed: true });
  const result = determineState(input);
  assert.equal(result.state, 'preparation_complete');
  const step = stepFor(result.state, input, result.blockedBy);
  assert.equal(step.step.kind, 'done');
  assert.match(step.speak, /未导入发票、填写或保存 ERP 单据/);
});
