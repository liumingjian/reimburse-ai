/**
 * Employee-facing interaction contract.
 *
 * The state machine still owns the actual work. This module gives its output
 * one stable vocabulary for progress, response templates, and user actions.
 * Template metadata is for logs and tests; it is not employee-facing text.
 */

export const INTERACTION_VERSION = 1;

export const PROGRESS = Object.freeze({
  environment: Object.freeze({ phase: 1, of: 10, label: '环境准备' }),
  identity: Object.freeze({ phase: 2, of: 10, label: '身份与常驻城市' }),
  intake: Object.freeze({ phase: 3, of: 10, label: '材料盘点' }),
  materials: Object.freeze({ phase: 4, of: 10, label: '材料整理' }),
  events: Object.freeze({ phase: 5, of: 10, label: '划分费用事件' }),
  projects: Object.freeze({ phase: 6, of: 10, label: '项目归属' }),
  catalog: Object.freeze({ phase: 7, of: 10, label: '报销信息核对' }),
  preparation: Object.freeze({ phase: 8, of: 10, label: '报销材料准备' }),
  save: Object.freeze({ phase: 9, of: 10, label: '保存报销草稿' }),
  handoff: Object.freeze({ phase: 10, of: 10, label: '草稿交接' }),
});

const TEMPLATE_BY_STATE = Object.freeze({
  schema_too_new: 'system.temporarily_unavailable',
  env_node_unsupported: 'system.temporarily_unavailable',
  env_runtime_missing: 'system.processing',
  env_chrome_down: 'system.temporarily_unavailable',
  env_not_logged_in: 'account.login',
  env_identity_unknown: 'account.login',
  env_identity_unbound: 'account.identity_confirmation',
  env_identity_mismatched: 'account.identity_mismatch',
  handed_off_recover: 'recovery.human_review',
  home_city_required: 'profile.home_city',
  profile_confirmation: 'profile.confirmation',
  task_none: 'materials.processing',
  inventory_stale: 'materials.processing',
  pdf_markdown_conversion_required: 'materials.processing',
  pdf_markdown_conversion_empty: 'materials.user_adjustment',
  pdf_markdown_conversion_failed: 'system.temporarily_unavailable',
  pdf_markdown_candidate_required: 'materials.processing',
  pdf_markdown_candidate_review: 'materials.processing',
  intake_open_items: 'materials.user_adjustment',
  classify_pending: 'materials.processing',
  image_awaiting_reading: 'materials.processing',
  reading_rejected: 'materials.processing',
  reading_stale: 'materials.processing',
  reading_awaiting_confirmation: 'materials.confirmation',
  reading_disputed: 'materials.user_adjustment',
  duplicate_blocked: 'materials.user_adjustment',
  events_pending: 'events.processing',
  allocation_required: 'events.user_input',
  allocation_stale: 'events.user_input',
  classified_detail_confirmation: 'materials.confirmation',
  project_book_empty: 'project.user_adjustment',
  project_unassigned: 'project.user_input',
  catalog_unverified: 'catalog.processing',
  catalog_mismatch: 'catalog.user_adjustment',
  recovery_write_blocked: 'recovery.human_review',
  preparation_package_pending: 'preparation.processing',
  preparation_blocked: 'preparation.user_adjustment',
  preparation_confirmation: 'preparation.confirmation',
  preparation_complete: 'preparation.completed',
  env_ready: 'workflow.ready',
});

const STATUS_BY_TEMPLATE = Object.freeze({
  'system.temporarily_unavailable': 'temporarily_unavailable',
  'system.processing': 'processing',
  'account.login': 'needs_user_action',
  'account.identity_confirmation': 'needs_confirmation',
  'account.identity_mismatch': 'temporarily_unavailable',
  'profile.home_city': 'needs_user_action',
  'profile.confirmation': 'needs_confirmation',
  'materials.processing': 'processing',
  'materials.user_adjustment': 'needs_adjustment',
  'materials.confirmation': 'needs_confirmation',
  'events.processing': 'processing',
  'events.user_input': 'needs_user_action',
  'project.user_adjustment': 'needs_adjustment',
  'project.user_input': 'needs_user_action',
  'catalog.processing': 'processing',
  'catalog.user_adjustment': 'needs_adjustment',
  'recovery.human_review': 'human_review',
  'preparation.processing': 'processing',
  'preparation.user_adjustment': 'needs_adjustment',
  'preparation.confirmation': 'needs_confirmation',
  'preparation.completed': 'completed',
  'workflow.ready': 'completed',
});

export const FORBIDDEN_USER_TERMS = Object.freeze([
  '内核',
  '模型',
  'OCR',
  'MarkItDown',
  'Markdown',
  'Node',
  'CDP',
  'AppleEvents',
  'ego-browser',
  'task space',
  'BAOX_HOME',
  'stepToken',
  'step.argv',
  'blockedBy',
  'resolvableBy',
  'upload_dispatched',
  'manifestHash',
  'bundleHash',
  'ERP',
  '候选',
  '原生票种',
  '手动 QA',
  '子 Agent',
  '机器',
  'reextract',
  'schema',
  'hash',
  '数据库',
  '解析器',
  '置信度',
  '字段映射',
]);

export const TEMPLATE_STATES = Object.freeze(Object.keys(TEMPLATE_BY_STATE));

const USER_TERM_REPLACEMENTS = Object.freeze([
  [/extract-reimbursement-images/gi, '图片读取组件'],
  [/MarkItDown/gi, '材料读取'],
  [/Markdown/gi, '材料内容'],
  [/OCR/gi, '图片读取'],
  [/tesseract|mdls|easyocr|paddleocr/gi, '外部读取工具'],
  [/AppleEvents/gi, '浏览器权限'],
  [/system browser transport/gi, '浏览器读取能力'],
  [/ego-browser/gi, '浏览器'],
  [/task space/gi, '浏览器空间'],
  [/BAOX_EGO_TASK_SPACE/gi, '浏览器空间设置'],
  [/stepToken/gi, '当前步骤凭据'],
  [/step\.argv/gi, '系统指令'],
  [/\bargv\b/gi, '系统指令'],
  [/blockedBy/gi, '待处理事项'],
  [/resolvableBy/gi, '处理人'],
  [/upload_dispatched/gi, '保存处理中'],
  [/manifestHash/gi, '材料清单版本'],
  [/bundleHash/gi, '核对材料版本'],
  [/reextract/gi, '重新核对'],
  [/candidatePath|templatePath/gi, '读取结果'],
  [/materialId/gi, '材料编号'],
  [/contentHash|markdownHash/gi, '材料版本'],
  [/schema/gi, '数据格式'],
  [/hash/gi, '材料版本'],
  [/Node/gi, '运行环境'],
  [/CDP/gi, '浏览器能力'],
  [/Chrome/gi, '浏览器'],
  [/Python/gi, '处理组件'],
  [/ERP/g, '报销系统'],
  [/原生票种/g, '票据类型'],
  [/候选/g, '参考'],
  [/手动 QA/g, '人工核对'],
  [/子 Agent/g, '系统处理'],
  [/机器/g, '系统'],
  [/数据库/g, '数据存储'],
  [/内核/g, '系统'],
  [/模型/g, '系统'],
  [/解析器/g, '读取组件'],
  [/置信度/g, '读取结果'],
  [/字段映射/g, '信息对应关系'],
]);

export function sanitizeUserText(value) {
  return USER_TERM_REPLACEMENTS.reduce((text, [pattern, replacement]) =>
    text.replace(pattern, replacement), String(value ?? ''));
}

export function templateIdForState(state) {
  const templateId = TEMPLATE_BY_STATE[state];
  if (!templateId) throw new Error(`状态 ${state} 没有用户话术模板`);
  return templateId;
}

export function interactionStatus(state) {
  const templateId = templateIdForState(state);
  return STATUS_BY_TEMPLATE[templateId] ?? 'processing';
}

export function decorateStep(state, shaped) {
  const interaction = Object.freeze({
    templateId: templateIdForState(state),
    version: INTERACTION_VERSION,
    status: interactionStatus(state),
  });
  return {
    ...shaped,
    interaction,
    ...(shaped.stepMeta ? {
      stepMeta: { ...shaped.stepMeta, interaction },
    } : {}),
  };
}
