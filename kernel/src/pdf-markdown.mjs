import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const PDF_MARKDOWN_SCHEMA_VERSION = 1;
export const MARKITDOWN_VERSION = '0.1.7';
export const MARKITDOWN_CONVERTER = 'markitdown';
export const MARKDOWN_SOURCE = 'agent_from_markdown';
export const PDF_MARKDOWN_RUNTIME_DIR = path.join(MODULE_DIR, 'pdf-markdown-runtime');
export const PDF_MARKDOWN_RUNNER = path.join(PDF_MARKDOWN_RUNTIME_DIR, 'runner.py');
export const PDF_MARKDOWN_LOCK_PATH = path.join(PDF_MARKDOWN_RUNTIME_DIR, 'uv.lock');
export const PDF_MARKDOWN_SCHEMA_PATH = path.join(MODULE_DIR, 'pdf-markdown-schema.json');
export const PDF_MARKDOWN_TEMPLATE_PATH = path.join(MODULE_DIR, 'pdf-markdown-template.json');

export function defaultMarkItDownPython(home = process.env.BAOX_HOME ?? path.join(os.homedir(), '.baox')) {
  return path.join(path.resolve(home), 'runtimes', 'markitdown', 'v1', 'bin', 'python');
}

const HASH_RE = /^[a-f0-9]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONEY_RE = /^-?\d{1,12}\.\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const EVIDENCE_STATUSES = new Set(['explicit', 'derived', 'ambiguous', 'missing', 'unreadable']);
const CANDIDATE_STATUSES = new Set(['accepted', 'accepted_with_issues']);
const TOP_LEVEL_KEYS = new Set([
  'schemaVersion', 'materialId', 'contentHash', 'source', 'documentType', 'kind',
  'fields', 'segments', 'kindEvidence', 'fieldEvidence', 'fieldStatus', 'fieldBasis', 'unreadable',
  'issues', 'status',
]);
const REQUIRED_CANDIDATE_KEYS = [
  'source', 'documentType', 'kind', 'fields', 'segments', 'kindEvidence', 'fieldEvidence',
  'fieldStatus', 'fieldBasis', 'unreadable', 'issues',
];
const ARTIFACT_KEYS = new Set([
  'schemaVersion', 'status', 'materialId', 'contentHash', 'source', 'markdown',
  'numberedMarkdown', 'title', 'error', 'pages',
]);
const ARTIFACT_SOURCE_KEYS = new Set([
  'kind', 'converter', 'converterVersion', 'runtimeLockHash', 'markdownHash', 'numberedMarkdownHash',
  'lineCount', 'status',
]);
const EVIDENCE_KEYS = new Set(['lineStart', 'lineEnd', 'page', 'quote']);
const ISSUE_KEYS = new Set(['code', 'field', 'index', 'note']);
const SEGMENT_KEYS = new Set([
  'index', 'travelDate', 'time', 'city', 'origin', 'destination', 'amount',
  'fieldEvidence', 'fieldStatus', 'fieldBasis', 'unreadable',
]);

const FIELD_SPECS = Object.freeze({
  invoiceCode: { type: 'invoiceCode' },
  invoiceNumber: { type: 'invoiceNumber' },
  issueDate: { type: 'date' },
  netAmount: { type: 'money' },
  taxAmount: { type: 'money' },
  totalAmount: { type: 'money' },
  sellerName: { type: 'text' },
  buyerName: { type: 'text' },
  itemName: { type: 'text' },
  travelDate: { type: 'date' },
  city: { type: 'text' },
  origin: { type: 'text' },
  destination: { type: 'text' },
  railTrain: { type: 'text' },
  railFrom: { type: 'text' },
  railTo: { type: 'text' },
  checkIn: { type: 'date' },
  checkOut: { type: 'date' },
  folioTotal: { type: 'money' },
  segmentCount: { type: 'integer' },
});

const SEGMENT_FIELD_SPECS = Object.freeze({
  travelDate: { type: 'date' },
  time: { type: 'time' },
  city: { type: 'text' },
  origin: { type: 'text' },
  destination: { type: 'text' },
  amount: { type: 'money' },
});

const KIND_META = Object.freeze({
  vat_common: { documentType: 'invoice', role: 'primary_voucher', label: '电子普通发票' },
  vat_special: { documentType: 'invoice', role: 'primary_voucher', label: '增值税专用发票' },
  passenger_transport: { documentType: 'invoice', role: 'primary_voucher', label: '旅客运输服务电子普通发票' },
  rail_eticket: { documentType: 'invoice', role: 'primary_voucher', label: '铁路电子客票' },
  ride_itinerary: { documentType: 'ride_itinerary', role: 'reference', label: '网约车行程单' },
  hotel_folio: { documentType: 'hotel_folio', role: 'reference', label: '酒店结账单' },
});

const FIELDS_BY_KIND = Object.freeze({
  vat_common: new Set(['invoiceCode', 'invoiceNumber', 'issueDate', 'netAmount', 'taxAmount', 'totalAmount',
    'sellerName', 'buyerName', 'itemName', 'travelDate', 'city', 'origin', 'destination']),
  vat_special: new Set(['invoiceCode', 'invoiceNumber', 'issueDate', 'netAmount', 'taxAmount', 'totalAmount',
    'sellerName', 'buyerName', 'itemName', 'travelDate', 'city', 'origin', 'destination']),
  passenger_transport: new Set(['invoiceCode', 'invoiceNumber', 'issueDate', 'netAmount', 'taxAmount', 'totalAmount',
    'sellerName', 'buyerName', 'itemName', 'travelDate', 'city', 'origin', 'destination']),
  rail_eticket: new Set(['invoiceCode', 'invoiceNumber', 'issueDate', 'netAmount', 'taxAmount', 'totalAmount',
    'sellerName', 'buyerName', 'itemName', 'travelDate', 'city', 'railTrain', 'railFrom', 'railTo']),
  ride_itinerary: new Set(['travelDate', 'city', 'origin', 'destination', 'totalAmount', 'segmentCount']),
  hotel_folio: new Set(['checkIn', 'checkOut', 'folioTotal', 'city']),
});

const clone = (value) => JSON.parse(JSON.stringify(value));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sha256File = (filePath) => sha256(fs.readFileSync(filePath));
const runtimeLockHash = () => {
  try { return sha256File(PDF_MARKDOWN_LOCK_PATH); } catch { return null; }
};
const normalizeLf = (value) => String(value ?? '').replace(/\r\n?/g, '\n');
const compact = (value) => String(value ?? '').replace(/\s+/g, '').normalize('NFKC');
const normalizedText = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const padLine = (line, width) => String(line).padStart(width, '0');

export class PdfMarkdownError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PdfMarkdownError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new PdfMarkdownError(code, message, details);
}

function assertObject(value, code, message) {
  if (!isObject(value)) fail(code, message);
}

function ensureHash(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !HASH_RE.test(value)) fail('INVALID_HASH', `${name} must be a SHA-256 hex string`);
}

export function hashMarkdown(markdown) {
  return sha256(Buffer.from(normalizeLf(markdown), 'utf8'));
}

export function numberMarkdown(markdown) {
  const text = normalizeLf(markdown);
  const lines = text.split('\n');
  const width = Math.max(1, String(lines.length).length);
  return lines.map((line, index) => `${padLine(index + 1, width)} | ${line}`).join('\n');
}

export const numberedMarkdown = numberMarkdown;

export function hashNumberedMarkdown(markdown) {
  return sha256(Buffer.from(numberMarkdown(markdown), 'utf8'));
}

function sourceMetadata(markdown, status = 'converted') {
  const normalized = normalizeLf(markdown);
  return {
    kind: MARKDOWN_SOURCE,
    converter: MARKITDOWN_CONVERTER,
    converterVersion: MARKITDOWN_VERSION,
    runtimeLockHash: runtimeLockHash(),
    markdownHash: hashMarkdown(normalized),
    numberedMarkdownHash: hashNumberedMarkdown(normalized),
    lineCount: normalized.split('\n').length,
    status,
  };
}

function sourceError(code, message, extra = {}) {
  return { code, message, ...extra };
}

function fileMaterial(sourcePath, materialId) {
  let bytes;
  try { bytes = fs.readFileSync(sourcePath); }
  catch (error) {
    return {
      status: 'failed',
      materialId: materialId ?? null,
      contentHash: null,
      source: sourceMetadata('', 'failed'),
      markdown: '',
      numberedMarkdown: numberMarkdown(''),
      title: null,
      error: sourceError('SOURCE_READ_ERROR', error.message),
    };
  }
  const contentHash = sha256(bytes);
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    return {
      status: 'unsupported',
      materialId: materialId ?? null,
      contentHash,
      source: sourceMetadata('', 'unsupported'),
      markdown: '',
      numberedMarkdown: numberMarkdown(''),
      title: null,
      error: sourceError('NOT_PDF', 'source file does not have a PDF header'),
    };
  }
  return { sourcePath, sourceBytes: bytes, contentHash, materialId: materialId ?? null };
}

function makeArtifact(material, markdown = '', status = 'failed', title = null, error = null, pages = []) {
  const normalized = normalizeLf(markdown);
  const source = sourceMetadata(normalized, status);
  return {
    schemaVersion: PDF_MARKDOWN_SCHEMA_VERSION,
    status,
    materialId: material.materialId ?? null,
    contentHash: material.contentHash ?? null,
    source,
    markdown: normalized,
    numberedMarkdown: numberMarkdown(normalized),
    title: typeof title === 'string' ? title : null,
    error: error ?? null,
    pages: Array.isArray(pages) ? pages : [],
  };
}

function commandResult({ pythonPath, runnerPath, sourcePath, timeoutMs, env, extraArgs = [] }) {
  return new Promise((resolve) => {
    const child = spawn(pythonPath, [
      runnerPath, '--input', sourcePath, ...extraArgs,
    ], {
      cwd: path.dirname(runnerPath),
      env: { ...process.env, ...(env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ ok: false, error }));
    child.on('close', (code, signal) => {
      if (code !== 0) {
        finish({ ok: false, error: new Error(`MarkItDown runner exited ${code ?? signal ?? 'unknown'}${stderr ? `: ${stderr.trim()}` : ''}`) });
        return;
      }
      let payload;
      try { payload = JSON.parse(stdout.trim().split('\n').at(-1) ?? ''); }
      catch (error) {
        finish({ ok: false, error: new Error(`MarkItDown runner returned invalid JSON: ${error.message}`) });
        return;
      }
      finish({ ok: true, payload });
    });
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ ok: false, error: new Error(`MarkItDown runner timed out after ${timeoutMs}ms`) });
    }, timeoutMs);
  });
}

export async function runMarkItDown(sourcePath, {
  pythonPath = process.env.BAOX_MARKITDOWN_PYTHON ?? defaultMarkItDownPython(),
  runnerPath = PDF_MARKDOWN_RUNNER,
  timeoutMs = 120000,
  env = {},
} = {}) {
  const result = await commandResult({
    pythonPath, runnerPath, sourcePath: path.resolve(sourcePath), timeoutMs, env,
  });
  if (!result.ok) return { status: 'failed', markdown: '', title: null, error: sourceError('CONVERTER_FAILED', result.error.message) };
  const payload = result.payload;
  if (!isObject(payload) || !['converted', 'empty', 'failed'].includes(payload.status)) {
    return { status: 'failed', markdown: '', title: null, error: sourceError('CONVERTER_PROTOCOL', 'invalid converter status') };
  }
  return {
    status: payload.status,
    markdown: typeof payload.markdown === 'string' ? payload.markdown : '',
    title: typeof payload.title === 'string' ? payload.title : null,
    error: payload.status === 'failed'
      ? sourceError('CONVERTER_FAILED', payload.error?.message ?? 'MarkItDown failed', payload.error ?? {})
      : null,
  };
}

export async function convertPdf({
  sourcePath,
  materialId = null,
  converter = null,
  converterOptions = {},
} = {}) {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
    return makeArtifact({ materialId, contentHash: null }, '', 'failed', null,
      sourceError('SOURCE_PATH_REQUIRED', 'sourcePath is required'));
  }
  const material = fileMaterial(sourcePath, materialId);
  if (material.status) return makeArtifact(material, material.markdown, material.status, material.title, material.error);

  let result;
  try {
    result = typeof converter === 'function'
      ? await converter(sourcePath, converterOptions)
      : await runMarkItDown(sourcePath, converterOptions);
  } catch (error) {
    result = { status: 'failed', markdown: '', title: null, error: sourceError('CONVERTER_FAILED', error.message) };
  }
  const status = result?.status === 'failed'
    ? 'failed'
    : result?.status === 'converted' && String(result.markdown ?? '').trim()
      ? 'converted'
      : result?.status === 'empty' || (result?.status === 'converted' && !String(result.markdown ?? '').trim())
        ? 'empty'
        : 'failed';
  return makeArtifact(material, status === 'failed' ? '' : result?.markdown ?? '', status, result?.title ?? null,
    status === 'failed'
      ? (result?.error ?? sourceError('CONVERTER_PROTOCOL', 'MarkItDown returned an unknown status'))
      : status === 'empty'
        ? sourceError('MARKDOWN_EMPTY', 'MarkItDown produced no Markdown')
        : null);
}

function validatePageManifest(pages) {
  if (!Array.isArray(pages)) fail('ARTIFACT_PAGES', 'artifact pages must be an array');
  const seen = new Set();
  for (const [position, page] of pages.entries()) {
    if (!isObject(page)) fail('ARTIFACT_PAGES', `artifact.pages[${position}] must be an object`);
    const unknown = unknownKeys(page, new Set(['page', 'path', 'contentHash', 'width', 'height']), `artifact.pages[${position}]`);
    if (unknown.length) fail('ARTIFACT_PAGES', `unknown page keys: ${unknown.join(', ')}`);
    if (page.page !== position + 1 || seen.has(page.page)) fail('ARTIFACT_PAGES', 'artifact page numbers must be contiguous');
    seen.add(page.page);
    if (typeof page.path !== 'string' || !path.isAbsolute(page.path)) fail('ARTIFACT_PAGES', 'artifact page paths must be absolute');
    ensureHash(page.contentHash, `artifact.pages[${position}].contentHash`);
    if (!Number.isInteger(page.width) || page.width < 1 || !Number.isInteger(page.height) || page.height < 1) fail('ARTIFACT_PAGES', 'artifact page dimensions are invalid');
    let bytes;
    try { bytes = fs.readFileSync(page.path); }
    catch (error) { fail('ARTIFACT_PAGE_READ', error.message); }
    if (sha256(bytes) !== page.contentHash) fail('ARTIFACT_PAGE_HASH', `artifact page ${page.page} hash does not match the PNG`);
  }
  return pages;
}

function assertArtifactShape(artifact) {
  assertObject(artifact, 'INVALID_ARTIFACT', 'conversion artifact must be an object');
  const unknownArtifactKeys = unknownKeys(artifact, ARTIFACT_KEYS, 'artifact');
  if (unknownArtifactKeys.length) fail('ARTIFACT_KEYS', `unknown artifact keys: ${unknownArtifactKeys.join(', ')}`);
  if (artifact.schemaVersion !== PDF_MARKDOWN_SCHEMA_VERSION) fail('ARTIFACT_VERSION', 'unsupported conversion artifact version');
  if (!['converted', 'empty', 'failed', 'unsupported'].includes(artifact.status)) fail('ARTIFACT_STATUS', 'invalid conversion artifact status');
  if (artifact.materialId !== null && typeof artifact.materialId !== 'string') fail('ARTIFACT_MATERIAL_ID', 'materialId must be a string or null');
  if (artifact.contentHash !== null) ensureHash(artifact.contentHash, 'contentHash', { nullable: true });
  assertObject(artifact.source, 'ARTIFACT_SOURCE', 'conversion artifact source is required');
  const unknownSourceKeys = unknownKeys(artifact.source, ARTIFACT_SOURCE_KEYS, 'artifact.source');
  if (unknownSourceKeys.length) fail('ARTIFACT_SOURCE_KEYS', `unknown source keys: ${unknownSourceKeys.join(', ')}`);
  if (artifact.source.kind !== MARKDOWN_SOURCE || artifact.source.converter !== MARKITDOWN_CONVERTER
      || artifact.source.converterVersion !== MARKITDOWN_VERSION) {
    fail('ARTIFACT_CONVERTER', 'conversion artifact was not created by the pinned MarkItDown runtime');
  }
  ensureHash(artifact.source.markdownHash, 'source.markdownHash');
  ensureHash(artifact.source.numberedMarkdownHash, 'source.numberedMarkdownHash');
  ensureHash(artifact.source.runtimeLockHash, 'source.runtimeLockHash');
  const currentLockHash = runtimeLockHash();
  if (!currentLockHash) fail('RUNTIME_LOCK_MISSING', 'the pinned uv.lock is missing');
  if (artifact.source.runtimeLockHash !== currentLockHash) fail('RUNTIME_LOCK_HASH', 'artifact was created with a different uv.lock');
  if (!Number.isInteger(artifact.source.lineCount) || artifact.source.lineCount < 1) fail('ARTIFACT_LINES', 'invalid numbered Markdown line count');
  if (artifact.source.status !== artifact.status) fail('ARTIFACT_SOURCE_STATUS', 'source status does not match artifact status');
  if (typeof artifact.markdown !== 'string' || typeof artifact.numberedMarkdown !== 'string') fail('ARTIFACT_MARKDOWN', 'artifact Markdown must be strings');
  if (normalizeLf(artifact.markdown) !== artifact.markdown) fail('ARTIFACT_MARKDOWN_EOL', 'artifact Markdown must use LF line endings');
  if (artifact.numberedMarkdown !== numberMarkdown(artifact.markdown)) fail('ARTIFACT_NUMBERING', 'numbered Markdown does not match Markdown');
  if (artifact.source.markdownHash !== hashMarkdown(artifact.markdown)) fail('ARTIFACT_MARKDOWN_HASH', 'Markdown hash does not match content');
  if (artifact.source.numberedMarkdownHash !== hashNumberedMarkdown(artifact.markdown)) fail('ARTIFACT_NUMBERED_HASH', 'numbered Markdown hash does not match content');
  if (artifact.source.lineCount !== artifact.markdown.split('\n').length) fail('ARTIFACT_LINE_COUNT', 'Markdown line count does not match source metadata');
  if (artifact.status === 'converted' && !artifact.markdown.trim()) fail('ARTIFACT_EMPTY', 'converted artifact cannot have empty Markdown');
  if (artifact.status !== 'converted' && artifact.markdown.trim()) fail('ARTIFACT_STATUS_CONTENT', 'non-converted artifact cannot contain Markdown');
  if (artifact.title !== null && typeof artifact.title !== 'string') fail('ARTIFACT_TITLE', 'artifact title must be a string or null');
  if (artifact.error !== null && !isObject(artifact.error)) fail('ARTIFACT_ERROR', 'artifact error must be an object or null');
  if (artifact.status !== 'converted' && artifact.error === null) fail('ARTIFACT_ERROR_REQUIRED', 'failed or empty artifact must explain its status');
  validatePageManifest(artifact.pages);
  return artifact;
}

export function validateArtifact(artifact, { sourcePath = null, materialId = null } = {}) {
  try {
    assertArtifactShape(artifact);
    if (sourcePath !== null) {
      const material = fileMaterial(sourcePath, materialId);
      if (material.contentHash === null || artifact.contentHash !== material.contentHash) {
        fail('ARTIFACT_SOURCE_HASH', 'artifact does not match the source PDF');
      }
      if (material.status === 'unsupported') fail('ARTIFACT_SOURCE_TYPE', 'source is not a PDF');
    }
    if (materialId !== null && artifact.materialId !== materialId) fail('ARTIFACT_MATERIAL_ID', 'artifact materialId does not match expected material');
    return { valid: true, artifact };
  } catch (error) {
    if (error instanceof PdfMarkdownError) return { valid: false, error };
    return { valid: false, error: new PdfMarkdownError('ARTIFACT_INVALID', error.message) };
  }
}

function writeJson(pathname, value, { overwrite = false } = {}) {
  if (!overwrite && fs.existsSync(pathname)) fail('OUTPUT_EXISTS', `refusing to overwrite ${pathname}`);
  fs.mkdirSync(path.dirname(pathname), { recursive: true, mode: 0o700 });
  const temporary = `${pathname}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, pathname);
}

export async function prepare({
  sourcePath,
  materialId = null,
  outputPath,
  overwrite = false,
  converter = null,
  converterOptions = {},
} = {}) {
  if (typeof outputPath !== 'string' || outputPath.length === 0) fail('OUTPUT_PATH_REQUIRED', 'prepare requires an explicit outputPath');
  let artifact = await convertPdf({ sourcePath, materialId, converter, converterOptions });
  writeJson(outputPath, artifact, { overwrite });
  return { artifact, outputPath };
}

export function load(artifactPath, { sourcePath = null, materialId = null } = {}) {
  if (typeof artifactPath !== 'string' || artifactPath.length === 0) fail('ARTIFACT_PATH_REQUIRED', 'artifact path is required');
  let artifact;
  try { artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')); }
  catch (error) { fail('ARTIFACT_READ_ERROR', error.message); }
  const result = validateArtifact(artifact, { sourcePath, materialId });
  if (!result.valid) throw result.error;
  return result.artifact;
}

function allowedFields(kind, { segment = false } = {}) {
  return segment ? new Set(Object.keys(SEGMENT_FIELD_SPECS)) : (FIELDS_BY_KIND[kind] ?? new Set());
}

function unknownKeys(object, allowed, label) {
  return Object.keys(object).filter((key) => !allowed.has(key)).map((key) => `${label}.${key}`);
}

function validDate(value) {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function fieldValueError(value, spec) {
  if (value === null) return null;
  if (typeof value !== 'string' && spec.type !== 'integer') return 'must be a string or null';
  if (spec.type === 'date' && (!DATE_RE.test(value) || !validDate(value))) return 'must be a real ISO date';
  if (spec.type === 'money' && !MONEY_RE.test(value)) return 'must be a signed decimal with exactly two places';
  if (spec.type === 'invoiceCode' && !/^(?:\d{10}|\d{12})$/.test(value)) return 'must be a 10 or 12 digit invoice code';
  if (spec.type === 'invoiceNumber' && !/^(?:\d{8}|\d{20})$/.test(value)) return 'must be an 8 or 20 digit invoice number';
  if (spec.type === 'time' && !TIME_RE.test(value)) return 'must be a 24-hour time';
  if (spec.type === 'integer' && (!Number.isInteger(value) || value < 0)) return 'must be a non-negative integer';
  if (spec.type === 'text' && (typeof value !== 'string' || !normalizedText(value) || value.length > 300)) return 'must be non-empty text of at most 300 characters';
  return null;
}

function dateTokens(value) {
  const out = [];
  const source = String(value).normalize('NFKC');
  const patterns = [
    /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/g,
    /(\d{4})年(\d{1,2})月(\d{1,2})日?/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const candidate = `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
      if (validDate(candidate)) out.push(candidate);
    }
  }
  return out;
}

function moneyTokens(value) {
  const out = [];
  const source = String(value).normalize('NFKC');
  for (const match of source.matchAll(/-?\d{1,12}(?:,\d{3})*\.\d{2}/g)) out.push(match[0].replace(/,/g, ''));
  return out;
}

function numberSupported(value, quotes) {
  const compactQuotes = quotes.map((quote) => compact(quote));
  const compactValue = compact(value);
  return compactQuotes.some((quote) => {
    if (/^\d+$/.test(compactValue)) {
      const escaped = compactValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?<!\\d)${escaped}(?!\\d)`).test(quote);
    }
    return quote.includes(compactValue);
  });
}

function textSupported(value, quotes) {
  const compactValue = compact(value);
  const joined = quotes.map((quote) => compact(quote)).join('');
  return joined.includes(compactValue);
}

function evidenceValueSupported(value, spec, quotes) {
  if (spec.type === 'date') return dateTokens(quotes.join('\n')).includes(value);
  if (spec.type === 'money') return moneyTokens(quotes.join('\n')).includes(value);
  if (spec.type === 'integer') return numberSupported(String(value), quotes);
  if (spec.type === 'invoiceCode' || spec.type === 'invoiceNumber') return numberSupported(value, quotes);
  return textSupported(value, quotes);
}

function tableCells(line) {
  if (!line.includes('|')) return [];
  const pipes = [...line.matchAll(/\|/g)].map((match) => match.index);
  if (pipes.length < 2) return [];
  return pipes.slice(0, -1).map((start, index) => {
    const end = pipes[index + 1];
    return { index, start: start + 1, end, text: line.slice(start + 1, end) };
  });
}

function tableHeaderRoles(lines, rowIndex) {
  for (let index = rowIndex - 1; index >= Math.max(0, rowIndex - 20); index -= 1) {
    const cells = tableCells(lines[index]);
    if (!cells.length || cells.every((cell) => /^[-:\s]+$/.test(cell.text))) continue;
    const roles = new Map();
    for (const cell of cells) {
      const header = compact(cell.text);
      if (header.includes('税额')) roles.set(cell.index, 'tax');
      else if (header.includes('金额')) roles.set(cell.index, 'net');
    }
    if ([...roles.values()].includes('net') && [...roles.values()].includes('tax')) {
      const roleIndices = [...roles.keys()].sort((left, right) => left - right);
      const rowMoneyCells = tableCells(lines[rowIndex])
        .filter((cell) => moneyTokens(cell.text).length > 0)
        .map((cell) => cell.index);
      const offsets = roleIndices.length === rowMoneyCells.length
        ? roleIndices.map((roleIndex, position) => rowMoneyCells[position] - roleIndex)
        : [];
      const offset = offsets.length && offsets.every((value) => value === offsets[0]) ? offsets[0] : 0;
      return { roles, offset };
    }
  }
  return null;
}

function evidenceCellRoles(evidence, lines) {
  if (evidence.lineStart !== evidence.lineEnd) return [];
  const lineIndex = evidence.lineStart - 1;
  const line = lines[lineIndex];
  const cells = tableCells(line);
  if (!cells.length) return [];
  const header = tableHeaderRoles(lines, lineIndex);
  if (!header) return [];
  const matches = [];
  let offset = 0;
  while (offset <= line.length) {
    const at = line.indexOf(evidence.quote, offset);
    if (at < 0) break;
    const end = at + evidence.quote.length;
    for (const cell of cells) {
      const headerIndex = cell.index - header.offset;
      if (at >= cell.start && end <= cell.end && header.roles.has(headerIndex)) matches.push({
        role: header.roles.get(headerIndex), text: cell.text,
      });
    }
    offset = at + 1;
  }
  return matches;
}

function labeledMoneyEvidenceSupported(value, field, evidence, artifact) {
  const lines = artifact.markdown.split('\n');
  const desiredRole = field === 'taxAmount' ? 'tax' : 'net';
  for (const item of evidence) {
    const roles = evidenceCellRoles(item, lines);
    if (roles.some((entry) => entry.role === desiredRole && moneyTokens(entry.text).includes(value)
      && moneyTokens(item.quote).length === 1)) return true;

    if (roles.length) continue;
    const actual = lines.slice(item.lineStart - 1, item.lineEnd).join('\n');
    if (moneyTokens(actual).length !== 1 || !moneyTokens(actual).includes(value)) continue;
    const compactActual = compact(actual);
    if (desiredRole === 'tax' && compactActual.includes('税额')) return true;
    if (desiredRole === 'net' && /不含税(?:金额|额)?|净额/.test(compactActual)) return true;
  }
  return false;
}

function evidenceText(evidence) {
  return compact(evidence.map((item) => item.quote).join('\n'));
}

function hasCommonInvoiceMarker(text) {
  return text.includes('电子发票(普通发票)')
    || text.includes('电子发票（普通发票）')
    || text.includes('增值税电子普通发票');
}

function hasPassengerMarker(text) {
  return text.includes('旅客运输服务')
    || (text.includes('旅游服务') && text.includes('代订车服务费'));
}

function nativeKindEvidenceSupported(kind, evidence) {
  const text = evidenceText(evidence);
  if (kind === 'vat_common') return hasCommonInvoiceMarker(text) && !hasPassengerMarker(text);
  if (kind === 'vat_special') return text.includes('增值税专用发票');
  if (kind === 'passenger_transport') return hasCommonInvoiceMarker(text) && hasPassengerMarker(text);
  if (kind === 'rail_eticket') return text.includes('铁路电子客票');
  if (kind === 'ride_itinerary') return text.includes('行程单')
    && (text.includes('AMAPITINERARY') || text.includes('高德地图'));
  if (kind === 'hotel_folio') return text.includes('结账单');
  return false;
}

function evidenceObject(value, artifact, fieldLabel) {
  if (!Array.isArray(value) || value.length === 0) return { error: `${fieldLabel} needs at least one evidence range` };
  const lines = artifact.markdown.split('\n');
  const normalized = [];
  let previousStart = 0;
  for (const [index, evidence] of value.entries()) {
    if (!isObject(evidence)) return { error: `${fieldLabel}[${index}] must be an object` };
    const keys = unknownKeys(evidence, EVIDENCE_KEYS, `${fieldLabel}[${index}]`);
    if (keys.length) return { error: `unknown evidence keys: ${keys.join(', ')}` };
    if (!Number.isInteger(evidence.lineStart) || !Number.isInteger(evidence.lineEnd)
      || evidence.lineStart < 1 || evidence.lineEnd < evidence.lineStart || evidence.lineEnd > lines.length) {
      return { error: `${fieldLabel} evidence line range is outside Markdown` };
    }
    if (evidence.lineStart < previousStart) return { error: `${fieldLabel} evidence ranges must be in source order` };
    if (evidence.page !== undefined && evidence.page !== null) {
      if (!Number.isInteger(evidence.page) || evidence.page < 1
        || !artifact.pages.some((page) => page.page === evidence.page)) {
        return { error: `${fieldLabel} page has no verified rendered source page` };
      }
    }
    if (typeof evidence.quote !== 'string' || !evidence.quote) return { error: `${fieldLabel} evidence quote is required` };
    const actual = lines.slice(evidence.lineStart - 1, evidence.lineEnd).join('\n');
    if (!actual.includes(evidence.quote)) return { error: `${fieldLabel} evidence quote is not an exact substring of its lines` };
    normalized.push({ ...evidence, quote: evidence.quote });
    previousStart = evidence.lineStart;
  }
  return { evidence: normalized, quotes: normalized.map((item) => item.quote) };
}

function normalizeEvidenceList(raw, artifact, label) {
  const result = evidenceObject(raw, artifact, label);
  if (result.error) return { errors: [result.error], value: [], quotes: [] };
  return { errors: [], value: result.evidence, quotes: result.quotes };
}

function normalizeEvidenceMap(raw, artifact, allowed, label) {
  if (!isObject(raw)) return { errors: [`${label} must be an object`], value: {} };
  const errors = unknownKeys(raw, allowed, label).map((key) => `unknown field: ${key}`);
  const value = {};
  for (const key of Object.keys(raw)) {
    const result = evidenceObject(raw[key], artifact, `${label}.${key}`);
    if (result.error) errors.push(result.error);
    else value[key] = result.evidence;
  }
  return { errors, value };
}

function issue(code, field = null, note = null, extra = {}) {
  return { code, ...(field ? { field } : {}), ...(note ? { note } : {}), ...extra };
}

function normalizeDeclaredIssues(raw) {
  if (raw === undefined) return { errors: [], issues: [] };
  if (!Array.isArray(raw)) return { errors: ['candidate.issues must be an array'], issues: [] };
  const errors = [];
  const issues = [];
  for (const [index, value] of raw.entries()) {
    if (!isObject(value)) {
      errors.push(`candidate.issues[${index}] must be an object`);
      continue;
    }
    const unknown = unknownKeys(value, ISSUE_KEYS, `candidate.issues[${index}]`);
    if (unknown.length) errors.push(`unknown issue keys: ${unknown.join(', ')}`);
    if (typeof value.code !== 'string' || !value.code.trim()) errors.push(`candidate.issues[${index}].code is required`);
    if (value.field !== undefined && (typeof value.field !== 'string' || !value.field.trim())) {
      errors.push(`candidate.issues[${index}].field must be non-empty text`);
    }
    if (value.index !== undefined && (!Number.isInteger(value.index) || value.index < 1)) errors.push(`candidate.issues[${index}].index must be positive integer`);
    if (value.note !== undefined && (typeof value.note !== 'string' || !value.note.trim())) {
      errors.push(`candidate.issues[${index}].note must be non-empty text`);
    }
    issues.push(value);
  }
  return { errors, issues };
}

function normalizeStatusMap(raw, allowed, label) {
  if (raw === undefined) return { errors: [], value: {} };
  if (!isObject(raw)) return { errors: [`${label} must be an object`], value: {} };
  const errors = unknownKeys(raw, allowed, label).map((key) => `unknown field: ${key}`);
  const value = {};
  for (const [key, status] of Object.entries(raw)) {
    if (!EVIDENCE_STATUSES.has(status)) errors.push(`${label}.${key} has invalid status`);
    else value[key] = status;
  }
  return { errors, value };
}

function normalizeBasisMap(raw, allowed, label) {
  if (raw === undefined) return { errors: [], value: {} };
  if (!isObject(raw)) return { errors: [`${label} must be an object`], value: {} };
  const errors = unknownKeys(raw, allowed, label).map((key) => `unknown field: ${key}`);
  const value = {};
  for (const [key, basis] of Object.entries(raw)) {
    if (typeof basis !== 'string' || !basis.trim()) errors.push(`${label}.${key} must be non-empty text`);
    else value[key] = basis;
  }
  return { errors, value };
}

function validateValueEvidence({ value, status, basis, field, spec, evidence, artifact, errors, issues }) {
  if (value === null) {
    if (status === 'explicit' || status === 'derived') errors.push(`${field} is marked ${status} but has no value`);
    if (status === 'ambiguous') issues.push(issue('field_ambiguous', field));
    return;
  }
  if (!['explicit', 'derived'].includes(status)) {
    errors.push(`${field} has value but status is ${status}`);
    return;
  }
  if (status === 'derived' && !basis) errors.push(`${field} is derived but fieldBasis is missing`);
  if (!evidence?.length) {
    errors.push(`${field} has value but fieldEvidence is missing`);
    return;
  }
  if (!evidenceValueSupported(value, spec, evidence.map((item) => item.quote))) {
    errors.push(`${field} value is not supported by its exact evidence quote`);
  }
  const fieldName = field.split('.').at(-1);
  if (['netAmount', 'taxAmount'].includes(fieldName)
    && !labeledMoneyEvidenceSupported(value, fieldName, evidence, artifact)) {
    errors.push(`${field} evidence does not identify its labeled amount column`);
  }
}

function validateSegments(raw, artifact, fieldStatus, fieldBasis, fieldEvidence, unreadable, kind) {
  const errors = [];
  const issues = [];
  if (!Array.isArray(raw)) return { errors: ['segments must be an array'], segments: [], issues };
  if (kind !== 'ride_itinerary' && raw.length) errors.push('only ride_itinerary candidates may contain segments');
  const segments = [];
  const seen = new Set();
  for (const [position, segment] of raw.entries()) {
    if (!isObject(segment)) { errors.push(`segments[${position}] must be an object`); continue; }
    const unknown = unknownKeys(segment, SEGMENT_KEYS, `segments[${position}]`);
    if (unknown.length) errors.push(`unknown segment keys: ${unknown.join(', ')}`);
    if (!Number.isInteger(segment.index) || segment.index < 1 || seen.has(segment.index)) {
      errors.push(`segments[${position}].index must be unique positive integer`);
    }
    seen.add(segment.index);
    const normalized = { index: segment.index };
    for (const [field, spec] of Object.entries(SEGMENT_FIELD_SPECS)) {
      if (!(field in segment)) errors.push(`segments[${position}].${field} is required`);
      const value = segment[field] === undefined ? null : segment[field];
      const error = fieldValueError(value, spec);
      if (error) errors.push(`segments[${position}].${field} ${error}`);
      normalized[field] = value;
    }
    const allowed = new Set(Object.keys(SEGMENT_FIELD_SPECS));
    if (!('fieldEvidence' in segment)) errors.push(`segments[${position}].fieldEvidence is required`);
    if (!('fieldStatus' in segment)) errors.push(`segments[${position}].fieldStatus is required`);
    if (!('unreadable' in segment)) errors.push(`segments[${position}].unreadable is required`);
    const evidenceResult = normalizeEvidenceMap(segment.fieldEvidence, artifact, allowed, `segments[${position}].fieldEvidence`);
    const statusResult = normalizeStatusMap(segment.fieldStatus, allowed, `segments[${position}].fieldStatus`);
    const basisResult = normalizeBasisMap(segment.fieldBasis, allowed, `segments[${position}].fieldBasis`);
    errors.push(...evidenceResult.errors, ...statusResult.errors, ...basisResult.errors);
    const segmentUnreadable = segment.unreadable;
    if (!Array.isArray(segmentUnreadable) || segmentUnreadable.some((field) => !allowed.has(field))) {
      errors.push(`segments[${position}].unreadable contains an unknown field`);
    }
    if (Array.isArray(segmentUnreadable) && new Set(segmentUnreadable).size !== segmentUnreadable.length) {
      errors.push(`segments[${position}].unreadable must not contain duplicates`);
    }
    const statuses = { ...statusResult.value };
    const unreadSet = new Set(Array.isArray(segmentUnreadable) ? segmentUnreadable : []);
    const normalizedEvidence = evidenceResult.value;
    const normalizedBasis = basisResult.value;
    for (const field of allowed) {
      const value = normalized[field];
      const status = statuses[field] ?? (unreadSet.has(field) ? 'unreadable' : value === null ? 'missing' : 'explicit');
      statuses[field] = status;
      validateValueEvidence({ value, status, basis: normalizedBasis[field], field: `segments[${position}].${field}`,
        spec: SEGMENT_FIELD_SPECS[field], evidence: normalizedEvidence[field], artifact, errors, issues });
      if (status === 'unreadable' && value !== null) errors.push(`segments[${position}].${field} is unreadable but has a value`);
      if (status === 'unreadable' && !unreadSet.has(field)) errors.push(`segments[${position}].${field} is unreadable but not listed in unreadable`);
    }
    segments.push({ ...normalized, fieldEvidence: normalizedEvidence, fieldStatus: statuses,
      fieldBasis: normalizedBasis, unreadable: [...unreadSet] });
  }
  const expected = segments.map((segment) => segment.index);
  if (expected.some((value, index) => value !== index + 1)) errors.push('segments.index must be contiguous starting at 1');
  return { errors, segments, issues };
}

function metadataErrors(candidate, artifact, kind) {
  const errors = [];
  const keys = unknownKeys(candidate, TOP_LEVEL_KEYS, 'candidate');
  if (keys.length) errors.push(`unknown candidate keys: ${keys.join(', ')}`);
  for (const key of REQUIRED_CANDIDATE_KEYS) {
    if (!(key in candidate)) errors.push(`candidate.${key} is required`);
  }
  if (candidate.schemaVersion !== PDF_MARKDOWN_SCHEMA_VERSION) errors.push('candidate.schemaVersion must be 1');
  if (candidate.materialId === undefined) errors.push('candidate.materialId is required');
  else if (candidate.materialId !== null && candidate.materialId !== artifact.materialId) errors.push('candidate.materialId does not match artifact');
  if (candidate.contentHash === undefined) errors.push('candidate.contentHash is required');
  else if (candidate.contentHash !== artifact.contentHash) errors.push('candidate.contentHash does not match artifact');
  if (candidate.source === undefined) errors.push('candidate.source is required');
  else if (!isObject(candidate.source)) errors.push('candidate.source must be an object');
  else {
    if (candidate.source.kind !== MARKDOWN_SOURCE) errors.push('candidate.source.kind must be agent_from_markdown');
    if (candidate.source.converter !== MARKITDOWN_CONVERTER) errors.push('candidate.source.converter must be markitdown');
    if (candidate.source.converterVersion !== MARKITDOWN_VERSION) errors.push('candidate.source.converterVersion must be 0.1.7');
    if (candidate.source.runtimeLockHash !== artifact.source.runtimeLockHash) errors.push('candidate.source.runtimeLockHash does not match artifact');
    if (candidate.source.markdownHash !== artifact.source.markdownHash) errors.push('candidate.source.markdownHash does not match artifact');
    const sourceKeys = unknownKeys(candidate.source, new Set(['kind', 'converter', 'converterVersion', 'runtimeLockHash', 'markdownHash']), 'candidate.source');
    if (sourceKeys.length) errors.push(`unknown source keys: ${sourceKeys.join(', ')}`);
  }
  if (!KIND_META[kind]) errors.push('candidate.kind is not a supported closed kind');
  if (KIND_META[kind] && candidate.documentType !== undefined && candidate.documentType !== KIND_META[kind].documentType) errors.push('candidate.documentType does not match kind');
  if (candidate.status !== undefined) errors.push('candidate.status is not accepted from a model submission');
  return errors;
}

function normalizeCandidate(candidate, artifact) {
  assertArtifactShape(artifact);
  assertObject(candidate, 'CANDIDATE_INVALID', 'candidate must be an object');
  if (artifact.status !== 'converted') return { errors: ['candidate requires a converted Markdown artifact'], record: null };
  const kind = candidate.kind;
  const errors = metadataErrors(candidate, artifact, kind);
  if (!KIND_META[kind]) return { errors, record: null };
  const allowed = allowedFields(kind);
  const rawFields = isObject(candidate.fields) ? candidate.fields : {};
  if (!isObject(candidate.fields)) errors.push('candidate.fields must be an object');
  errors.push(...unknownKeys(rawFields, allowed, 'candidate.fields').map((key) => `unknown field: ${key}`));
  const fields = {};
  for (const field of allowed) fields[field] = rawFields[field] === undefined ? null : rawFields[field];
  for (const [field, value] of Object.entries(fields)) {
    const valueError = fieldValueError(value, FIELD_SPECS[field]);
    if (valueError) errors.push(`candidate.fields.${field} ${valueError}`);
  }

  const kindEvidenceResult = normalizeEvidenceList(candidate.kindEvidence, artifact, 'candidate.kindEvidence');
  const evidenceResult = normalizeEvidenceMap(candidate.fieldEvidence, artifact, allowed, 'candidate.fieldEvidence');
  const statusResult = normalizeStatusMap(candidate.fieldStatus, allowed, 'candidate.fieldStatus');
  const basisResult = normalizeBasisMap(candidate.fieldBasis, allowed, 'candidate.fieldBasis');
  const declaredIssuesResult = normalizeDeclaredIssues(candidate.issues);
  errors.push(...kindEvidenceResult.errors, ...evidenceResult.errors, ...statusResult.errors,
    ...basisResult.errors, ...declaredIssuesResult.errors);
  if (!kindEvidenceResult.errors.length && !nativeKindEvidenceSupported(kind, kindEvidenceResult.value)) {
    errors.push(`candidate.kind ${kind} is not supported by its native kindEvidence`);
  }
  const rawUnreadable = candidate.unreadable;
  if (!Array.isArray(rawUnreadable) || rawUnreadable.some((field) => !allowed.has(field))) errors.push('candidate.unreadable contains an unknown field');
  if (Array.isArray(rawUnreadable) && new Set(rawUnreadable).size !== rawUnreadable.length) {
    errors.push('candidate.unreadable must not contain duplicates');
  }
  const unreadable = [...new Set(Array.isArray(rawUnreadable) ? rawUnreadable : [])];
  const fieldStatus = {};
  const issues = [];
  for (const field of allowed) {
    const value = fields[field];
    const status = statusResult.value[field] ?? (unreadable.includes(field) ? 'unreadable' : value === null ? 'missing' : 'explicit');
    fieldStatus[field] = status;
    validateValueEvidence({ value, status, basis: basisResult.value[field], field: `candidate.fields.${field}`,
      spec: FIELD_SPECS[field], evidence: evidenceResult.value[field], artifact, errors, issues });
    if (status === 'unreadable' && !unreadable.includes(field)) errors.push(`candidate.fields.${field} is unreadable but not listed in unreadable`);
    if (status === 'missing' && value !== null) errors.push(`candidate.fields.${field} is missing but has a value`);
    if (status === 'ambiguous' && value !== null) errors.push(`candidate.fields.${field} is ambiguous but has a value`);
  }
  const segmentsResult = validateSegments(candidate.segments, artifact, fieldStatus, basisResult.value,
    evidenceResult.value, unreadable, kind);
  errors.push(...segmentsResult.errors);
  issues.push(...segmentsResult.issues);
  const segmentCount = fields.segmentCount ?? null;
  if (kind === 'ride_itinerary') {
    if (segmentCount !== null && segmentsResult.segments.length !== segmentCount) {
      errors.push(`segmentCount ${segmentCount} does not match ${segmentsResult.segments.length} segment rows`);
    }
    if (segmentsResult.segments.length > 0 && segmentCount === null) errors.push('segment rows require fields.segmentCount');
  } else if (segmentCount !== null) errors.push('segmentCount is only valid for ride_itinerary');

  const money = (field) => fields[field] == null ? null : Math.round(Number(fields[field].replace(/,/g, '')) * 100);
  const net = money('netAmount');
  const tax = money('taxAmount');
  const total = money('totalAmount');
  if (net !== null && tax !== null && total !== null && net + tax !== total) errors.push('netAmount + taxAmount must equal totalAmount');
  if (kind === 'ride_itinerary') {
    const segmentMoney = segmentsResult.segments.map((segment) => segment.amount === null ? null : Math.round(Number(segment.amount) * 100));
    if (segmentMoney.length > 0 && segmentMoney.every((value) => value !== null) && total !== null
      && segmentMoney.reduce((sum, value) => sum + value, 0) !== total) errors.push('segment amounts must equal totalAmount exactly');
  }
  if (kind === 'rail_eticket' && fields.invoiceNumber !== null && !/^\d{20}$/.test(fields.invoiceNumber)) errors.push('rail_eticket requires a 20 digit invoiceNumber');
  if (kind !== 'rail_eticket' && fields.invoiceNumber !== null && /^\d{8}$/.test(fields.invoiceNumber)
    && fields.invoiceCode !== null && !/^(?:\d{10}|\d{12})$/.test(fields.invoiceCode)) errors.push('legacy invoiceNumber requires a valid invoiceCode');
  if (kind === 'rail_eticket' && fields.netAmount === null && fields.taxAmount === null) issues.push(issue('amount_not_on_face'));
  for (const field of allowed) if (fieldStatus[field] === 'missing') issues.push(issue('field_missing', field));
  for (const field of allowed) if (fieldStatus[field] === 'ambiguous') issues.push(issue('field_ambiguous', field));
  for (const field of unreadable) issues.push(issue('field_unreadable', field));

  const record = {
    schemaVersion: PDF_MARKDOWN_SCHEMA_VERSION,
    status: errors.length ? 'rejected' : issues.length ? 'accepted_with_issues' : 'accepted',
    materialId: artifact.materialId,
    contentHash: artifact.contentHash,
    source: {
      kind: MARKDOWN_SOURCE,
      converter: MARKITDOWN_CONVERTER,
      converterVersion: MARKITDOWN_VERSION,
      runtimeLockHash: artifact.source.runtimeLockHash,
      markdownHash: artifact.source.markdownHash,
    },
    documentType: KIND_META[kind].documentType,
    kind,
    kindEvidence: kindEvidenceResult.value,
    fields,
    segments: segmentsResult.segments,
    fieldEvidence: evidenceResult.value,
    fieldStatus,
    fieldBasis: basisResult.value,
    unreadable,
    issues: [...declaredIssuesResult.issues, ...issues],
  };
  return { errors, record };
}

export function validateCandidate(artifact, candidate) {
  try {
    const result = normalizeCandidate(candidate, artifact);
    return { verdict: result.errors.length ? 'rejected' : 'accepted', errors: result.errors, record: result.record };
  } catch (error) {
    const wrapped = error instanceof PdfMarkdownError ? error : new PdfMarkdownError('CANDIDATE_INVALID', error.message);
    return { verdict: 'rejected', errors: [wrapped.message], error: wrapped, record: null };
  }
}

export async function ingest({ artifact, artifactPath = null, submission, outputPath, overwrite = false } = {}) {
  const loaded = typeof artifactPath === 'string' ? load(artifactPath) : artifact;
  const result = validateCandidate(loaded, typeof submission === 'string' ? JSON.parse(fs.readFileSync(submission, 'utf8')) : submission);
  if (result.verdict === 'rejected') return result;
  if (typeof outputPath !== 'string' || outputPath.length === 0) fail('OUTPUT_PATH_REQUIRED', 'ingest requires an explicit outputPath');
  writeJson(outputPath, result.record, { overwrite });
  return { ...result, outputPath };
}

export function loadCandidate(candidatePath, { artifact = null, artifactPath = null } = {}) {
  let candidate;
  try { candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8')); }
  catch (error) { fail('CANDIDATE_READ_ERROR', error.message); }
  const loadedArtifact = artifactPath ? load(artifactPath) : artifact;
  if (!loadedArtifact) fail('ARTIFACT_REQUIRED', 'loading a candidate requires its conversion artifact for revalidation');
  {
    const submission = { ...candidate };
    delete submission.status;
    const result = validateCandidate(loadedArtifact, submission);
    if (result.verdict === 'rejected') fail('CANDIDATE_INVALID', result.errors.join('; '), { errors: result.errors });
    return result.record;
  }
}

function fieldText(record, field) {
  return (record.fieldEvidence?.[field] ?? []).map((item) => item.quote).join('\n') || null;
}

function moneyObject(value) {
  if (value === null || value === undefined) return null;
  return { text: value, cents: Math.round(Number(value) * 100) };
}

function candidateEvidence(record, field) {
  const evidence = record.fieldEvidence?.[field] ?? [];
  return evidence.length ? evidence.map((item) => item.quote).join('\n') : null;
}

export function project(record) {
  if (!isObject(record) || !KIND_META[record.kind]) fail('CANDIDATE_INVALID', 'accepted candidate record is required');
  if (!CANDIDATE_STATUSES.has(record.status)) fail('CANDIDATE_INVALID', 'candidate must be accepted before projection');
  const meta = KIND_META[record.kind];
  const fields = {};
  for (const [field, spec] of Object.entries(FIELD_SPECS)) {
    const value = record.fields?.[field];
    if (value === null || value === undefined) continue;
    fields[field] = spec.type === 'money' ? moneyObject(value) : value;
  }
  const candidates = [];
  const addCandidate = (field, value, evidence = null, note = null) => {
    if (value === null || value === undefined) return;
    candidates.push({ field, value, note, evidence });
  };
  if (record.kind === 'ride_itinerary') {
    addCandidate('segmentCount', record.fields.segmentCount, candidateEvidence(record, 'segmentCount'), 'Markdown candidate row count');
    addCandidate('itineraryTotal', record.fields.totalAmount, candidateEvidence(record, 'totalAmount'), 'Markdown candidate total; not an invoice face amount');
    if (record.segments.length) {
      addCandidate('segments', record.segments.map((segment) => ({
        index: segment.index,
        date: segment.travelDate,
        time: segment.time,
        city: segment.city,
        origin: segment.origin,
        destination: segment.destination,
        route: segment.origin && segment.destination ? `${segment.origin} → ${segment.destination}` : null,
        routeComplete: !!(segment.origin && segment.destination),
        amount: segment.amount,
      })), null, 'Markdown candidate segments; amount is not a user allocation');
    }
  } else if (record.kind === 'hotel_folio') {
    addCandidate('checkIn', record.fields.checkIn, candidateEvidence(record, 'checkIn'), 'Markdown candidate check-in date');
    addCandidate('checkOut', record.fields.checkOut, candidateEvidence(record, 'checkOut'), 'Markdown candidate check-out date');
    addCandidate('folioTotal', record.fields.folioTotal, candidateEvidence(record, 'folioTotal'), 'Markdown candidate folio total');
  }
  for (const field of Object.keys(record.fields ?? {})) {
    if (record.fields[field] === null || ['segmentCount', 'totalAmount', 'checkIn', 'checkOut', 'folioTotal'].includes(field)) continue;
    if (record.kind === 'ride_itinerary' && ['travelDate', 'city', 'origin', 'destination'].includes(field)) {
      addCandidate(field, record.fields[field], candidateEvidence(record, field), 'Markdown candidate itinerary fact');
    }
  }
  const evidence = Object.fromEntries(Object.entries(record.fieldEvidence ?? {}).map(([field, ranges]) => [
    field, ranges.map((range) => range.quote).join('\n'),
  ]));
  const fieldSources = Object.fromEntries(Object.entries(record.fields ?? {})
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([field]) => [field, MARKDOWN_SOURCE]));
  return {
    parseStatus: 'parsed',
    pageCount: null,
    kind: record.kind,
    kindLabel: meta.label,
    role: meta.role,
    fields,
    candidates,
    evidence,
    fieldSources,
    candidateSources: {
      source: MARKDOWN_SOURCE,
      contentHash: record.contentHash,
      markdownHash: record.source.markdownHash,
      converter: record.source.converter,
      converterVersion: record.source.converterVersion,
      runtimeLockHash: record.source.runtimeLockHash,
      fieldEvidence: clone(record.fieldEvidence ?? {}),
      fieldStatus: clone(record.fieldStatus ?? {}),
      fieldBasis: clone(record.fieldBasis ?? {}),
      kindEvidence: clone(record.kindEvidence ?? []),
    },
    candidateStatus: record.status,
    unreadable: clone(record.unreadable ?? []),
    issues: clone(record.issues ?? []),
    contentHash: record.contentHash,
    source: MARKDOWN_SOURCE,
  };
}

function workOrder(artifact) {
  return {
    schemaVersion: PDF_MARKDOWN_SCHEMA_VERSION,
    materialId: artifact.materialId,
    contentHash: artifact.contentHash,
    source: {
      kind: MARKDOWN_SOURCE,
      converter: MARKITDOWN_CONVERTER,
      converterVersion: MARKITDOWN_VERSION,
      runtimeLockHash: artifact.source.runtimeLockHash,
      markdownHash: artifact.source.markdownHash,
    },
    numberedMarkdown: artifact.numberedMarkdown,
    lineCount: artifact.source.lineCount,
    candidateTemplate: {
      schemaVersion: PDF_MARKDOWN_SCHEMA_VERSION,
      materialId: artifact.materialId,
      contentHash: artifact.contentHash,
      source: {
        kind: MARKDOWN_SOURCE,
        converter: MARKITDOWN_CONVERTER,
        converterVersion: MARKITDOWN_VERSION,
        runtimeLockHash: artifact.source.runtimeLockHash,
        markdownHash: artifact.source.markdownHash,
      },
      documentType: null,
      kind: null,
      kindEvidence: [],
      fields: {},
      segments: [],
      fieldEvidence: {},
      fieldStatus: {},
      fieldBasis: {},
      unreadable: [],
      issues: [],
    },
    instructions: {
      evidence: 'Use exact quote text and 1-based numbered Markdown lines for every non-null value.',
      missing: 'Use null and status missing or unreadable; do not invent dates, amounts, tax, or segment rows.',
      derived: 'A derived value requires fieldBasis and evidence that supports the derivation.',
      kind: 'Choose one closed kind from the candidate schema; do not use a generic invoice kind.',
      fields: Object.fromEntries(Object.entries(FIELDS_BY_KIND).map(([kind, fields]) => [kind, [...fields].sort()])),
      segmentFields: Object.keys(SEGMENT_FIELD_SPECS),
    },
  };
}

export function pendingWorkOrder(artifactOrPath, options = {}) {
  const artifact = typeof artifactOrPath === 'string' ? load(artifactOrPath, options) : artifactOrPath;
  assertArtifactShape(artifact);
  if (artifact.status !== 'converted') {
    return {
      status: 'blocked',
      reason: artifact.error ?? sourceError('MARKDOWN_UNAVAILABLE', `conversion status is ${artifact.status}`),
      materialId: artifact.materialId,
      contentHash: artifact.contentHash,
    };
  }
  return { status: 'ready', ...workOrder(artifact) };
}

export const projectCandidate = project;
