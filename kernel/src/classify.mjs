import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseMaterial, invoiceIdentity, checkAmounts, maskNumber } from './parse.mjs';
import { loadReading, loadRejection, loadUnreadable, projectReading, MAX_SIGHT_FAILURES,
  MAX_EMPTY_READINGS, FIELD_LABELS, INVOICE_BUSINESS_FIELDS, SEGMENT_RULES } from './vision.mjs';
import { shapeOfFile } from './imageshape.mjs';
import { extractPdfText } from './pdftext.mjs';
import { READING_KINDS } from './state.mjs';
import { taskDir } from './workspace.mjs';
import { load as loadMarkdownArtifact, loadCandidate, project as projectMarkdownCandidate,
  pendingWorkOrder } from './pdf-markdown.mjs';

// 材料角色分流：把盘点出来的材料判成主要报销凭证还是参考材料，
// 顺带把票面事实和发票身份提出来，并做**任务内**重复发票检测。
//
// 跨任务重复（历史任务里已经用过的发票身份）不在这一层，属于后面的检查；
// 这里少判一层就少一层，宁可让它显式缺席，也不假装已经查过。

/**
 * 对一次盘点版本里的材料逐份解析。
 * `sourceDir` 只在本次进程内用来读文件，不写进任何产物。
 */
export function markdownMaterialPaths(task, versionId, materialId) {
  if (!task?.taskId || !versionId || !materialId) return null;
  const root = path.join(taskDir(task), 'pdf-markdown', versionId);
  const stem = String(materialId);
  return {
    root,
    artifactPath: path.join(root, `${stem}.artifact.json`),
    markdownPath: path.join(root, `${stem}.md`),
    numberedMarkdownPath: path.join(root, `${stem}.numbered.md`),
    pagesDir: path.join(root, `${stem}.pages`),
    templatePath: path.join(root, `${stem}.candidate.template.json`),
    candidatePath: path.join(root, `${stem}.candidate.json`),
    candidateRecordPath: path.join(root, `${stem}.candidate.record.json`),
    reextractPath: path.join(root, `${stem}.reextract.json`),
  };
}

const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

function pdfPageCount(sourcePath) {
  try {
    const count = extractPdfText(fs.readFileSync(sourcePath)).pageCount;
    return Number.isInteger(count) && count > 0 ? count : null;
  } catch {
    return null;
  }
}

export function validateMarkdownSidecars(artifact, paths) {
  if (!artifact || !paths?.markdownPath || !paths?.numberedMarkdownPath) {
    return { ok: false, reason: 'Markdown sidecar 路径缺失' };
  }
  try {
    const markdown = fs.readFileSync(paths.markdownPath, 'utf8');
    const numberedMarkdown = fs.readFileSync(paths.numberedMarkdownPath, 'utf8');
    if (markdown !== artifact.markdown) return { ok: false, reason: 'Markdown sidecar 与 artifact 内嵌文字不一致' };
    if (numberedMarkdown !== artifact.numberedMarkdown) {
      return { ok: false, reason: '带编号 Markdown sidecar 与 artifact 内嵌文字不一致' };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `Markdown sidecar 不可读：${error.message}` };
  }
}

function markdownResult(sourceDir, inventory, task, material) {
  const sourcePath = path.join(path.resolve(sourceDir), material.relPath);
  const paths = markdownMaterialPaths(task, inventory.versionId, material.materialId);
  const base = { materialId: material.materialId, fileName: material.fileName, relPath: material.relPath,
    format: material.format,
    contentHash: material.contentHash, role: null, kind: null, fields: {}, candidates: [], evidence: {},
    fieldSources: {}, candidateSources: null, source: null, markdownHash: null, sourcePages: [],
    pageCount: pdfPageCount(sourcePath) };
  if (!paths) {
    return { ...base, parseStatus: 'markdown_conversion_required',
      note: 'PDF 必须先经过固定版本 MarkItDown 转换；当前分类没有任务工作区，不能读取候选' };
  }

  let artifact;
  try {
    artifact = loadMarkdownArtifact(paths.artifactPath, { sourcePath, materialId: material.materialId });
  } catch (error) {
    return { ...base, parseStatus: 'markdown_conversion_required', paths,
      note: `没有找到与当前 PDF hash 匹配的 MarkItDown artifact：${error.message}` };
  }
  if (artifact.status !== 'converted') {
    const pending = pendingWorkOrder(artifact);
    const kind = artifact.status === 'empty' ? 'markdown_conversion_empty' : 'markdown_conversion_failed';
    return { ...base, parseStatus: kind, paths, artifactStatus: artifact.status,
      artifactError: artifact.error ?? null,
      note: pending.reason?.message ?? artifact.error?.message ?? 'MarkItDown 转换没有产出可用 Markdown' };
  }
  const sidecars = validateMarkdownSidecars(artifact, paths);
  if (!sidecars.ok) {
    return { ...base, parseStatus: 'markdown_conversion_required', paths,
      markdownHash: artifact.source.markdownHash, sourcePages: artifact.pages ?? [],
      note: `${sidecars.reason}；请重新运行 markdown-convert 恢复受 hash 绑定的副本` };
  }
  if (!fs.existsSync(paths.candidateRecordPath)) {
    return { ...base, parseStatus: 'markdown_candidate_required', paths,
      markdownHash: artifact.source.markdownHash,
      sourcePages: artifact.pages ?? [],
      note: 'Markdown 已转换；请仅依据带编号 Markdown 和封闭 schema 提取候选，再运行 markdown-ingest' };
  }

  let reextract = null;
  try { reextract = JSON.parse(fs.readFileSync(paths.reextractPath, 'utf8')); } catch { /* no request */ }
  if (reextract?.taskId === task.taskId && reextract.materialId === material.materialId
    && reextract.contentHash === material.contentHash
    && reextract.markdownHash === artifact.source.markdownHash) {
    return { ...base, parseStatus: 'markdown_candidate_required', paths,
      markdownHash: artifact.source.markdownHash,
      sourcePages: artifact.pages ?? [],
      note: '已按用户纠正要求使当前候选失效；请重新依据同 hash 的带编号 Markdown 提取候选，再运行 markdown-ingest' };
  }

  let record;
  try {
    record = loadCandidate(paths.candidateRecordPath, { artifactPath: paths.artifactPath });
  } catch (error) {
    return { ...base, parseStatus: 'markdown_candidate_invalid', paths,
      markdownHash: artifact.source.markdownHash,
      sourcePages: artifact.pages ?? [],
      note: `候选未通过内核校验：${error.message}` };
  }
  const projected = projectMarkdownCandidate(record);
  const candidateSources = {
    ...(projected.candidateSources ?? {}),
    // project() 把逐段值投影成 candidates；分类摘要还要保留每个 segment 的原始 evidence。
    segments: (record.segments ?? []).map((segment) => ({
      index: segment.index,
      fieldEvidence: segment.fieldEvidence ?? {},
      fieldStatus: segment.fieldStatus ?? {},
      fieldBasis: segment.fieldBasis ?? {},
      unreadable: segment.unreadable ?? [],
    })),
  };
  if ((base.pageCount ?? 0) > 1 && projected.role === 'primary_voucher') {
    return {
      ...base,
      ...projected,
      pageCount: base.pageCount,
      parseStatus: 'multi_page_invoice',
      contentHash: material.contentHash,
      paths,
      markdownHash: candidateSources.markdownHash,
      sourcePages: artifact.pages ?? [],
      fieldEvidence: candidateSources.fieldEvidence,
      fieldStatus: candidateSources.fieldStatus,
      segments: record.segments ?? [],
      unreadable: projected.unreadable ?? [],
      issues: projected.issues ?? [],
      candidateSources,
      note: 'V1 只支持单页发票；请将这份多页发票排除或替换为单页发票',
    };
  }
  return {
    ...base,
    ...projected,
    pageCount: base.pageCount,
    parseStatus: 'parsed',
    contentHash: material.contentHash,
    paths,
    markdownHash: candidateSources.markdownHash,
    sourcePages: artifact.pages ?? [],
    fieldEvidence: candidateSources.fieldEvidence,
    fieldStatus: candidateSources.fieldStatus,
    segments: record.segments ?? [],
    unreadable: projected.unreadable ?? [],
    issues: projected.issues ?? [],
    candidateSources,
  };
}

export function classifyInventory(sourceDir, inventory, task = null, { mode = 'markdown' } = {}) {
  const results = [];
  for (const m of inventory.materials) {
    if (m.disposition !== 'pending_classification') {
      // 盘点阶段已经判为范围外或待处理的材料，这一层不再碰它。
      results.push({ materialId: m.materialId, fileName: m.fileName, format: m.format ?? null,
        parseStatus: 'skipped', role: null, kind: null, fields: {}, candidates: [], evidence: {} });
      continue;
    }
    let parsed = m.format === 'pdf' && mode !== 'legacy'
      ? markdownResult(sourceDir, inventory, task, m)
      : parseMaterial(path.join(path.resolve(sourceDir), m.relPath), m.format);

    // 图片取不出文字，但可能已经有一次绑定当前字节的看图读取。
    // 候选先进入分类明细；只有整单确认后，读数才成为最终事实。
    if (parsed.parseStatus === 'needs_ocr') {
      // 这个文件到底是不是一张显示得出来的图，由**内核**说了算，不由模型说了算。
      // 解不开图像头的，模型压根不会被派去看它 —— 于是「图片显示不出来」这句话
      // 只可能出自内核，出自模型时它必然是假的。
      const shape = shapeOfFile(path.join(path.resolve(sourceDir), m.relPath));
      parsed = { ...parsed, imageDecodable: !!shape, imageShape: shape?.shape ?? null };
    }
    if (parsed.parseStatus === 'needs_ocr' && parsed.imageDecodable && task) {
      const reading = loadReading(task, m.materialId);
      const fresh = reading && reading.contentHash === m.contentHash;
      const projected = fresh ? projectReading(reading, { provisional: true }) : null;
      const rejection = loadRejection(task, m.materialId);
      const freshRejection = rejection && rejection.contentHash === m.contentHash;
      const parkedRec = loadUnreadable(task, m.materialId);
      const parked = parkedRec && parkedRec.contentHash === m.contentHash ? parkedRec : null;
      if (projected) parsed = projected;
      // 争议排在普通驳回前面：两者都是「读过了但没落库」，处置却完全不同 ——
      // 驳回是重读整张票，争议是只重读争的那一个字段（干净上下文）。
      // 塌成同一种的话，模型会带着刚吵完的上下文重抄一整张，第二次读数就不独立了。
      else if (freshRejection && !fresh && (rejection.disputed?.length ?? 0) > 0) {
        parsed = { ...parsed, readingState: 'disputed', rejection };
      } else if (parked) parsed = { ...parsed, readingState: 'unreadable', parked };
      // 驳回排在「没读过」前面：这张图确实还没有可用的读数，但**为什么**没有
      // 是下一次读取唯一有用的输入，把它塌成「还没读」就等于把理由丢掉。
      else if (freshRejection && !fresh) parsed = { ...parsed, readingState: 'rejected', rejection };
      else parsed = { ...parsed, readingState: !fresh && reading ? 'stale' : reading ? 'unconfirmed' : 'none' };
    }

    // 每个字段带来源。PDF 那条路上的字段是内核自己从文字层解出来的 —— 记 `kernel`；
    // 看图那条路上的来源已经跟着读数投影过来了（vision / user），不覆盖它。
    if (parsed.fields && !parsed.fieldSources) {
      parsed = { ...parsed,
        fieldSources: Object.fromEntries(Object.keys(parsed.fields).map((k) => [k,
          parsed.source === 'agent_from_markdown' ? 'agent_from_markdown' : 'kernel'])) };
    }

    const identity = invoiceIdentity(parsed);
    results.push({
      materialId: m.materialId,
      fileName: m.fileName,
      format: m.format,
      contentHash: m.contentHash,
      ...parsed,
      identity,
      amounts: parsed.role === 'primary_voucher' ? checkAmounts(parsed.fields) : null,
    });
  }

  // 任务内重复发票：按发票身份判定，与内容哈希无关。
  // 两个字节不同的 PDF 只要是同一张法定发票，照样是重复；
  // 反过来同一份文件被复制到两个路径，只在这里算一次身份冲突。
  const byIdentity = new Map();
  for (const r of results) {
    if (!r.identity) continue;
    if (!byIdentity.has(r.identity.key)) byIdentity.set(r.identity.key, []);
    byIdentity.get(r.identity.key).push(r);
  }
  const duplicates = [...byIdentity.entries()]
    .filter(([, rs]) => rs.length > 1)
    .map(([key, rs]) => ({
      identityKey: key,
      maskedNumber: maskNumber(rs[0].identity.number),
      materialIds: rs.map((r) => r.materialId),
      // 同一张发票的两个副本字节是否也相同，只是解释原因用，不改变判定。
      sameBytes: new Set(rs.map((r) => r.contentHash)).size === 1,
    }));

  const candidateDigest = digest(results.filter((r) => r.format === 'pdf').map((r) => ({
    materialId: r.materialId,
    contentHash: r.contentHash,
    parseStatus: r.parseStatus,
    markdownHash: r.markdownHash ?? null,
    candidateSources: r.candidateSources ?? null,
    fields: r.fields,
    candidates: r.candidates,
  })));
  return { versionId: inventory.versionId, classifiedAt: new Date().toISOString(), candidateDigest,
    results, duplicates };
}

/** 分流与解析这一层能产生的待确认项。 */
export function classifyOpenItems(classification) {
  const items = [];
  const add = (kind, blocking, extra) => items.push({ kind, blocking, ...extra });

  for (const r of classification.results) {
    if (r.parseStatus === 'skipped') continue;
    const at = { materialId: r.materialId, fileName: r.fileName, relPath: r.relPath ?? null };

    if (r.parseStatus === 'needs_ocr') {
      if (r.imageDecodable === false) {
        // 内核自己解不开的图。它到不了模型手上 —— 只有人能换一份能看的原件。
        add('image_file_broken', true, { ...at,
          note: '这个文件的扩展名说它是图片，但内核解不开它的图像头，它不是一张完整的 png / jpg；'
            + '请重新导出或重新拍一份' });
        continue;
      }
      if ((r.rejection?.sightFailures ?? 0) >= MAX_SIGHT_FAILURES) {
        // 接连答不出「看过的凭据」。再让模型读下去只是让它接着试，
        // 而试出来的那一次和真看过的那一次，内核分辨不了。
        add('sight_unproven', true, { ...at,
          note: `我连着 ${r.rejection.sightFailures} 次答不出这张图长什么样，`
            + '没法证明我真的打开过它。这张图的读数我不再往下交 ——'
            + '请你看一眼这个文件，或者换一份能正常显示的原件' });
        continue;
      }
      if ((r.rejection?.emptyReadings ?? 0) >= MAX_EMPTY_READINGS) {
        // 接连交空读数。图是好的，字一个都没抄下来 —— 再派模型读一遍只是再空一次。
        add('vision_unavailable', true, { ...at,
          note: `我连着 ${r.rejection.emptyReadings} 次从这张图上一个字段都没读出来，`
            + '而这张图在我这边是完好的。看图这一步靠的是我自己的视觉，'
            + '不接外部识图工具（那种结果我不收）—— 所以多半是当前这个模型看不到图片。'
            + '两条路：换一个能看图的模型来跑这一步，或者把这份材料换成 PDF 原件（PDF 我自己取字，不用看图）' });
        continue;
      }
      const state = r.readingState ?? 'none';
      if (state === 'unreadable') {
        // 争议收不了场，整条读数已经退回待办。它挡在「再读一遍」前面 ——
        // 用户已经说过他对着原件也认不出，再派模型去读一遍是在原地转圈。
        add('reading_unreadable', true, { ...at,
          note: `${r.parked?.reason ?? '这条读数已经退回待办'}。`
            + `读不出的是：${(r.parked?.fields ?? []).map((f) => FIELD_LABELS[f] ?? f).join('、') || '这份读数'}。`
            + '请换一份看得清的原件（重新导出或重新拍一张），换了我就重新看图',
          fields: r.parked?.fields ?? [] });
        continue;
      }
      if (state === 'disputed') {
        const d = r.rejection?.disputed ?? [];
        add('reading_disputed', true, { ...at,
          note: `用户对着原件说这几个字段和我读到的不一样：${d.map((x) => x.label).join('、')}。`
            + '他给的值我没有直接落库 —— 两边都可能错，先摆证据、再独立重读、最后请他拍板',
          fields: d.map((x) => x.field) });
        continue;
      }
      if (state === 'unconfirmed') {
        add('reading_awaiting_confirmation', false, { ...at,
          note: '这张图的候选会带入整单分类明细，用户在最终 ERP 明细清单中统一核对' });
      } else if (state === 'rejected') {
        add('reading_rejected', true, { ...at,
          note: `上一次读数没有过关：${(r.rejection?.reasons ?? []).join('；')}`,
          reasons: r.rejection?.reasons ?? [] });
      } else if (state === 'stale') {
        add('reading_stale', true, { ...at,
          note: '图片内容变了，之前那次读取已经作废，需要重新看图' });
      } else {
        add('image_awaiting_reading', true, { ...at,
          note: '图片材料需要逐张打开看图，抄录票面信息' });
      }
      continue;
    }
    if (r.parseStatus === 'no_text') {
      add('no_text_in_pdf', true, { ...at, note: 'PDF 里没有可提取的文字，通常是扫描件；请提供电子发票原件' });
      continue;
    }
    if (r.parseStatus === 'multi_page_invoice') {
      add('multi_page_invoice', true, { ...at, pageCount: r.pageCount ?? null, sourcePages: r.sourcePages ?? [],
        note: r.note ?? 'V1 只支持单页发票；请将这份多页发票排除或替换为单页发票' });
      continue;
    }
    if (r.parseStatus === 'markdown_conversion_required' || r.parseStatus === 'markdown_conversion_failed'
      || r.parseStatus === 'markdown_conversion_empty') {
      add(r.parseStatus, true, { ...at, ...(r.paths ?? {}), markdownHash: r.markdownHash ?? null,
        sourcePages: r.sourcePages ?? [],
        error: r.artifactError ?? null,
        note: r.note ?? 'PDF 还没有可用的 MarkItDown Markdown artifact' });
      continue;
    }
    if (r.parseStatus === 'markdown_candidate_required' || r.parseStatus === 'markdown_candidate_invalid') {
      add(r.parseStatus, true, { ...at, ...(r.paths ?? {}), markdownHash: r.markdownHash ?? null,
        sourcePages: r.sourcePages ?? [],
        note: r.note ?? '需要依据带编号 Markdown 提交候选，并由内核校验' });
      continue;
    }
    if (r.parseStatus === 'read_error') { add('read_error', true, { ...at, note: r.note ?? null }); continue; }
    if (r.parseStatus === 'unrecognized') {
      add('kind_unrecognized', true, { ...at,
        note: '认得出是 PDF、取得到文字，但不是 v1 支持的票种；请确认它是否属于本次报销' });
      continue;
    }

    if (r.kind === 'unreadable') {
      add('image_unreadable', true, { ...at, note: '这张图看不清，读不出票面信息；请提供更清晰的原件' });
      continue;
    }
    if (r.kind === 'other') {
      add('kind_unrecognized', true, { ...at, note: '看图读取判定它不是发票，也不是已知的参考材料；请确认它是否属于本次报销' });
      continue;
    }

    if (r.source === 'agent_from_markdown') {
      const statuses = r.candidateSources?.fieldStatus ?? r.fieldStatus ?? {};
      for (const field of ['invoiceNumber', ...INVOICE_BUSINESS_FIELDS]) {
        if (['ambiguous', 'unreadable'].includes(statuses[field])) {
          add('markdown_field_unresolved', true, { ...at, field,
            note: `Markdown 候选的 ${FIELD_LABELS[field] ?? field} 被标成 ${statuses[field]}，不能进入费用事件；请重新抽取并提供明确原文证据` });
        }
      }
      for (const [field, status] of Object.entries(statuses)) {
        if (status === 'derived') {
          add('markdown_derived_field', false, { ...at, field,
            note: `${FIELD_LABELS[field] ?? field} 是基于候选证据推导的值；确认表会保留其 fieldBasis 和 quote` });
        }
      }
      for (const segment of r.candidateSources?.segments ?? []) {
        const unresolved = Object.entries(segment.fieldStatus ?? {})
          .filter(([field, status]) => ['ambiguous', 'unreadable'].includes(status)
            || (status === 'missing' && SEGMENT_RULES[field]?.required))
          .map(([field]) => field);
        if (unresolved.length) {
          add('markdown_segment_unresolved', true, { ...at, index: segment.index,
            fields: unresolved,
            note: `Markdown 行程第 ${segment.index} 段存在未解决字段：${unresolved.join('、')}；不能用半截路线或金额推断` });
        }
      }
      for (const issue of r.issues ?? []) {
        if (!issue || ['amount_not_on_face', 'field_missing', 'field_ambiguous', 'field_unreadable'].includes(issue.code)) continue;
        add('markdown_candidate_issue', true, { ...at, code: issue.code, field: issue.field ?? null,
          index: issue.index ?? null,
          note: `Markdown 候选声明了未解决问题 ${issue.code}${issue.field ? `（${issue.field}）` : ''}；请重新抽取或回看原件` });
      }
    }

    if (r.role === 'primary_voucher') {
      if (!r.identity) {
        add('identity_incomplete', true, { ...at,
          note: '识别为发票但取不到该票种完整的原生发票身份，无法做重复检查；发票身份不能由对话补录' });
      }
      const a = r.amounts;
      if (a?.status === 'mismatch') {
        add('amount_mismatch', true, { ...at,
          note: `票面不含税 + 税额 ≠ 价税合计（${a.netCents / 100} + ${a.taxCents / 100} ≠ ${a.totalCents / 100}）` });
      } else if (a?.status === 'missing') {
        add('amount_missing', true, { ...at, note: '取不到价税合计' });
      } else if (a?.status === 'partial') {
        // 铁路电子客票票面本来就只有票价。费用明细按业务规则使用票价总额，
        // 税额固定为零；票面没有净额字段仍如实保留，不把业务默认写成票面事实。
        const onFace = r.kind === 'rail_eticket';
        add(onFace ? 'amount_not_on_face' : 'amount_missing', !onFace, { ...at,
          note: onFace
            ? '铁路电子客票按票面票价作为费用总额，税额按业务规则默认为 0.00，无需等待 ERP 回读净税额'
            : `取不到 ${a.missing.join('、')}` });
      }
    }
  }

  for (const d of classification.duplicates) {
    add('duplicate_invoice', true, {
      materialIds: d.materialIds,
      maskedNumber: d.maskedNumber,
      note: d.sameBytes
        ? '同一份文件出现在多个位置，指向同一张法定发票；请只保留一份'
        : '多份不同的文件指向同一张法定发票；重复发票不能确认后继续，只能移除或替换材料',
    });
  }

  // 「一张凭证都没有」只有在**该读的都读完之后**才说得出口。
  // 图还没看就下这个结论是抢答：一目录的发票照片，读之前一张凭证也认不出来，
  // 而这句话会把用户支去检查目录选对没有 —— 目录没选错，是我们还没看。
  const awaitingReading = items.some((i) => READING_KINDS.has(i.kind));
  const awaitingMarkdown = items.some((i) => i.kind.startsWith('markdown_'));
  const primaries = classification.results.filter((r) => r.role === 'primary_voucher');
  if (primaries.length === 0 && !awaitingReading && !awaitingMarkdown) {
    add('no_primary_voucher', true, { note: '没有识别到任何主要报销凭证，这个目录还不能构成一次报销' });
  }
  return items;
}

/** 给用户看的摘要：只保留最终业务需要核对的材料和金额字段。 */
export function summarize(classification) {
  const yuan = (m) => (m ? (m.cents / 100).toFixed(2) : null);
  return classification.results
    .filter((r) => r.parseStatus !== 'skipped')
    .map((r) => ({
      materialId: r.materialId,
      fileName: r.fileName,
      role: r.role,
      kind: r.kind,
      kindLabel: r.kindLabel ?? null,
      parseStatus: r.parseStatus,
      netAmount: yuan(r.fields?.netAmount),
      taxAmount: yuan(r.fields?.taxAmount),
      totalAmount: yuan(r.fields?.totalAmount),
      amountCheck: r.amounts?.status ?? null,
      candidates: r.candidates.map((c) => c.field),
    }));
}
