import test from 'node:test';
import assert from 'node:assert/strict';

import { stepFor } from '../src/next.mjs';
import {
  FORBIDDEN_USER_TERMS,
  INTERACTION_VERSION,
  PROGRESS,
  TEMPLATE_STATES,
  interactionStatus,
  sanitizeUserText,
  templateIdForState,
} from '../src/interaction.mjs';

const identity = { displayName: '张三', account: 'zhang.san', tenant: 'tenant-1' };
const base = {
  sourceDir: '/tmp/materials',
  probe: { identity },
  binding: identity,
  employeeHomeCity: '广州市',
  homeCity: '广州市',
  task: { taskId: 'task-1', sourceLabel: '材料', workspace: '/tmp/task' },
  preparation: { ready: true, digest: 'digest-1', document: { lines: [] } },
  preparationPackage: { files: { detailJson: '/tmp/detail.json' } },
};

test('业务进度固定为十个阶段，且没有重复阶段', () => {
  assert.deepEqual(Object.values(PROGRESS).map(({ phase, of }) => [phase, of]), [
    [1, 10], [2, 10], [3, 10], [4, 10], [5, 10],
    [6, 10], [7, 10], [8, 10], [9, 10], [10, 10],
  ]);
  assert.equal(new Set(Object.values(PROGRESS).map(({ phase }) => phase)).size, 10);
});

test('每个状态都有版本化模板和状态类别', () => {
  assert.equal(TEMPLATE_STATES.length, 40);
  for (const state of TEMPLATE_STATES) {
    assert.match(templateIdForState(state), /^[a-z]+\.[a-z_]+$/);
    assert.ok(interactionStatus(state));
  }
});

test('首次常驻城市支持候选确认，错误时直接输入城市', () => {
  const suggested = stepFor('home_city_required', {
    probe: { identity },
    homeCitySuggestion: '深圳市',
  });
  assert.equal(suggested.interaction.templateId, 'profile.home_city');
  assert.equal(suggested.interaction.version, INTERACTION_VERSION);
  assert.equal(suggested.progress.phase, 2);
  assert.match(suggested.step.prompt, /深圳市/);
  assert.match(suggested.step.prompt, /回复「确认」/);
  assert.match(suggested.step.prompt, /直接输入/);
  assert.equal(suggested.step.suggestedHomeCity, '深圳市');

  const direct = stepFor('home_city_required', { probe: { identity } });
  assert.match(direct.speak, /直接输入你的常驻城市/);
  assert.doesNotMatch(direct.speak, /二次确认|候选/);
});

test('再次新建报销先展示报销人和常驻城市，确认或直接改城市都只需一步', () => {
  const shaped = stepFor('profile_confirmation', {
    probe: { identity },
    employeeHomeCity: '广州市',
  });
  assert.equal(shaped.step.kind, 'ask_user');
  assert.match(shaped.step.prompt, /报销人/);
  assert.match(shaped.step.prompt, /常驻城市/);
  assert.match(shaped.step.prompt, /回复「确认」/);
  assert.match(shaped.step.prompt, /直接输入新的城市名称/);
  assert.match(shaped.speak, /当前会话中回复「确认」/);
  assert.equal(shaped.progress.phase, 2);
  assert.equal(shaped.interaction.status, 'needs_confirmation');
});

test('代表性员工话术不暴露内部处理名词', () => {
  const cases = [
    ['schema_too_new', { schemaVersion: 2 }],
    ['env_node_unsupported', { nodeMajor: 20 }],
    ['env_runtime_missing', { runtimeDependencies: { ready: false, missing: ['runtime'] } }],
    ['env_chrome_down', { browserMode: 'ego', cdpUp: false }],
    ['env_not_logged_in', { probe: { status: 'not_logged_in' } }],
    ['env_identity_unknown', { probe: { status: 'unknown' } }],
    ['env_identity_unbound', { binding: null }],
    ['env_identity_mismatched', { probe: { identity: { ...identity, account: 'other' } } }],
    ['home_city_required', {}],
    ['profile_confirmation', {}],
    ['task_none', {}],
    ['inventory_stale', {}],
    ['pdf_markdown_conversion_required', {}],
    ['pdf_markdown_conversion_empty', {}],
    ['pdf_markdown_conversion_failed', {}],
    ['pdf_markdown_candidate_required', {}],
    ['intake_open_items', {}],
    ['classify_pending', {}],
    ['image_awaiting_reading', { pendingImages: [] }],
    ['reading_rejected', { pendingImages: [] }],
    ['reading_stale', { pendingImages: [] }],
    ['reading_awaiting_confirmation', { pendingReadings: [] }],
    ['duplicate_blocked', {}],
    ['events_pending', {}],
    ['classified_detail_confirmation', { classifiedPreview: { lines: [], evidence: [], homeCity: '广州市' } }],
    ['project_unassigned', { lines: [] }],
    ['project_book_empty', { projectBook: { empty: true } }],
    ['catalog_unverified', {}],
    ['catalog_mismatch', {}],
    ['preparation_package_pending', {}],
    ['preparation_blocked', { preparation: { ready: false, problems: [] } }],
    ['preparation_confirmation', {}],
    ['preparation_complete', { preparationConfirmed: true }],
    ['handed_off_recover', { task: { ...base.task, erpWriteState: 'unknown' } }],
    ['recovery_write_blocked', { task: { ...base.task, erpWriteState: 'known' } }],
    ['env_ready', {}],
  ];
  for (const [state, observation] of cases) {
    const speak = stepFor(state, { ...base, ...observation }).speak;
    for (const term of FORBIDDEN_USER_TERMS) {
      assert.doesNotMatch(speak, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `${state} 不应出现 ${term}`);
    }
  }
});

test('用户追问时的说明也只保留业务表达', () => {
  const safe = sanitizeUserText(
    'Node/CDP 读取 ERP 的 MarkItDown OCR 结果，step.argv 和 contentHash 由内核检查。',
  );
  for (const term of FORBIDDEN_USER_TERMS) {
    assert.doesNotMatch(safe, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `说明不应出现 ${term}`);
  }
  assert.match(safe, /运行环境|浏览器能力|报销系统|材料版本/);
});
