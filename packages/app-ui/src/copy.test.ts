// @vitest-environment node
// 员工可见文案遵守内核 FORBIDDEN_USER_TERMS（kernel/src/interaction.mjs）：页面文案常量与源码里的中文文案都不许含禁用词。
// 只读文件系统与常量，不碰 DOM。
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import * as actions from './contract/actions';
import * as projectBook from './contract/project-book';
import * as snapshot from './contract/snapshot';
import * as stage from './contract/stage';
import * as taskList from './contract/task-list';
import { ERP_STEP_DEFS, handedOffBanner, loginNotDetected, mismatchReason, MISMATCH_ABORT_REASON, SAVE_ABORT_REASON } from './mock/fixtures/erp';
import { t1Snapshot, t2Snapshot, t3Snapshot } from './mock/fixtures/tasks';
import { PAGE_COPY } from './pages/page-copy';
import { STARTUP_COPY } from './pages/StartupPage';

// 照抄内核 interaction.mjs:99-131（员工可见内容里一律不出现）。
const FORBIDDEN_USER_TERMS = [
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
] as const;

function hits(text: string): string[] {
  return FORBIDDEN_USER_TERMS.filter((term) => text.includes(term));
}

// 把常量（对象、数组、字符串、带参数的文案函数）里的全部字符串收出来；函数用示例参数调用一次。
function strings(value: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof value === 'string') out.push([path, value]);
  else if (typeof value === 'function') {
    let sample: unknown = null;
    try {
      sample = (value as (...args: unknown[]) => unknown)('P-5108', '示例', 2, 3);
    } catch {
      // 不是文案函数（如校验函数），跳过。
    }
    if (typeof sample === 'string') out.push([path, sample]);
  } else if (Array.isArray(value)) value.forEach((item, index) => strings(item, `${path}[${index}]`, out));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) strings(item, `${path}.${key}`, out);
}

// 页面文案常量：名字全大写且以 COPY / ERRORS / NOTES / NOTICE / LABELS / COLUMNS 结尾的导出。
const COPY_NAME = /^[A-Z_]+(COPY|ERRORS|NOTES|NOTICE|LABELS|COLUMNS|PHASES)$/;

describe('员工可见文案不含内核禁用词', () => {
  test('契约里的文案常量', () => {
    const out: Array<[string, string]> = [];
    for (const [moduleName, module] of Object.entries({ actions, projectBook, snapshot, stage, taskList })) {
      for (const [name, value] of Object.entries(module)) if (COPY_NAME.test(name)) strings(value, `${moduleName}.${name}`, out);
    }
    strings(PAGE_COPY, 'PAGE_COPY', out);
    strings(STARTUP_COPY, 'STARTUP_COPY', out);
    expect(out.length).toBeGreaterThan(50);
    for (const [path, text] of out) expect(hits(text), `${path}：${text}`).toEqual([]);
  });

  test('mock 服务端给出的文字（写入步骤、中止原因、对账横幅、原因句、夹具快照）', () => {
    const out: Array<[string, string]> = [];
    strings(ERP_STEP_DEFS, 'ERP_STEP_DEFS', out);
    for (const text of [SAVE_ABORT_REASON, MISMATCH_ABORT_REASON, mismatchReason(6), loginNotDetected(1), handedOffBanner('BX1'), handedOffBanner(null)]) out.push(['erp', text]);
    for (const [name, make] of [
      ['t1-reconcile', () => t1Snapshot('reconcile')],
      ['t1-done', () => t1Snapshot('done')],
      ['t2', t2Snapshot],
      ['t3', t3Snapshot],
    ] as const) {
      const snap = make();
      strings({ erp: snap.erp, readback: snap.readback, reconcile: snap.reconcile, lines: snap.lines.map((line) => line.description) }, name, out);
    }
    for (const [path, text] of out) expect(hits(text), `${path}：${text}`).toEqual([]);
  });

  test('源码里的中文文案（字符串字面量与 JSX 文本，注释与测试除外）', () => {
    const srcDir = fileURLToPath(new URL('.', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && entry.name !== 'setup.ts') files.push(full);
      }
    };
    walk(srcDir);
    const cjk = /[一-鿿]/;
    const problems: string[] = [];
    for (const file of files) {
      // 去掉块注释、JSX 注释与行注释（行注释只认行首或空白之后的 //，避免吃掉 URL）。
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)\/\/.*$/gm, '$1');
      const pieces = [
        ...code.matchAll(/'(?:[^'\\\n]|\\.)*'/g),
        ...code.matchAll(/"(?:[^"\\\n]|\\.)*"/g),
        ...code.matchAll(/`(?:[^`\\]|\\.)*`/g),
        // JSX 文本：夹在 > 或 } 与 < 或 { 之间的一段（紧挨着 {表达式} 的文字也算），例如「报销事由：{purpose}。项目归属…」。
        ...code.matchAll(/[>}]([^<>{}]+)[<{]/g),
      ].map((match) => match[0]);
      for (const piece of pieces) {
        if (!cjk.test(piece)) continue;
        const found = hits(piece);
        if (found.length > 0) problems.push(`${relative(srcDir, file)}：${found.join('、')}：${piece.slice(0, 80)}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
