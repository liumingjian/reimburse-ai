import path from 'node:path';
import { parseMaterial, invoiceIdentity, checkAmounts, maskNumber } from './parse.mjs';
import { loadReading, projectReading } from './vision.mjs';
import { READING_KINDS } from './state.mjs';

// 材料角色分流：把盘点出来的材料判成主要报销凭证还是参考材料，
// 顺带把票面事实和发票身份提出来，并做**任务内**重复发票检测。
//
// 跨任务重复（历史任务里已经用过的发票身份）不在这一层，属于后面的检查；
// 这里少判一层就少一层，宁可让它显式缺席，也不假装已经查过。

/**
 * 对一次盘点版本里的材料逐份解析。
 * `sourceDir` 只在本次进程内用来读文件，不写进任何产物。
 */
export function classifyInventory(sourceDir, inventory, task = null) {
  const results = [];
  for (const m of inventory.materials) {
    if (m.disposition !== 'pending_classification') {
      // 盘点阶段已经判为范围外或待处理的材料，这一层不再碰它。
      results.push({ materialId: m.materialId, fileName: m.fileName, format: m.format ?? null,
        parseStatus: 'skipped', role: null, kind: null, fields: {}, candidates: [], evidence: {} });
      continue;
    }
    let parsed = parseMaterial(path.join(path.resolve(sourceDir), m.relPath), m.format);

    // 图片取不出文字，但可能已经有一次**已确认**的看图读取。
    // 只有确认过的读数才顶替解析结果；读过没确认的仍然停在待确认项里。
    if (parsed.parseStatus === 'needs_ocr' && task) {
      const reading = loadReading(task, m.materialId);
      const fresh = reading && reading.contentHash === m.contentHash;
      const projected = fresh ? projectReading(reading) : null;
      if (projected) parsed = projected;
      else parsed = { ...parsed, readingState: !fresh && reading ? 'stale' : reading ? 'unconfirmed' : 'none' };
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

  return { versionId: inventory.versionId, classifiedAt: new Date().toISOString(), results, duplicates };
}

/** 分流与解析这一层能产生的待确认项。 */
export function classifyOpenItems(classification) {
  const items = [];
  const add = (kind, blocking, extra) => items.push({ kind, blocking, ...extra });

  for (const r of classification.results) {
    if (r.parseStatus === 'skipped') continue;
    const at = { materialId: r.materialId, fileName: r.fileName };

    if (r.parseStatus === 'needs_ocr') {
      const state = r.readingState ?? 'none';
      if (state === 'unconfirmed') {
        add('reading_awaiting_confirmation', true, { ...at,
          note: '这张图已经读过，但读数还没有被确认。看图读出来的字段只是候选，'
            + '必须由用户在本地确认页面上核对后提交才能算数' });
      } else if (state === 'stale') {
        add('reading_stale', true, { ...at,
          note: '图片内容变了，之前那次读取已经作废，需要重新看图' });
      } else {
        add('image_awaiting_reading', true, { ...at,
          note: '图片材料需要看图读取票面信息；跑 ocr-request 拿到读取工单' });
      }
      continue;
    }
    if (r.parseStatus === 'no_text') {
      add('no_text_in_pdf', true, { ...at, note: 'PDF 里没有可提取的文字，通常是扫描件；请提供电子发票原件' });
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

    if (r.role === 'primary_voucher') {
      if (!r.identity) {
        add('identity_incomplete', true, { ...at,
          note: '识别为发票但取不到 20 位发票号码，无法做重复检查；发票身份不能由对话补录' });
      }
      if (!r.fields.issueDate) add('issue_date_missing', true, { ...at, note: '取不到开票日期' });

      const a = r.amounts;
      if (a?.status === 'mismatch') {
        add('amount_mismatch', true, { ...at,
          note: `票面不含税 + 税额 ≠ 价税合计（${a.netCents / 100} + ${a.taxCents / 100} ≠ ${a.totalCents / 100}）` });
      } else if (a?.status === 'missing') {
        add('amount_missing', true, { ...at, note: '取不到价税合计' });
      } else if (a?.status === 'partial') {
        // 铁路电子客票票面本来就只有票价，不含税金额和税额要等 ERP 收票回读，
        // 这是票面事实而不是解析失败，所以不阻塞。
        const onFace = r.kind === 'rail_eticket';
        add(onFace ? 'amount_not_on_face' : 'amount_missing', !onFace, { ...at,
          note: onFace
            ? '铁路电子客票票面只有票价，不含税金额和税额需在 ERP 收票回读后确认'
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
  const primaries = classification.results.filter((r) => r.role === 'primary_voucher');
  if (primaries.length === 0 && !awaitingReading) {
    add('no_primary_voucher', true, { note: '没有识别到任何主要报销凭证，这个目录还不能构成一次报销' });
  }
  return items;
}

/** 给用户看的摘要：发票号码脱敏，金额按分还原成元。 */
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
      invoiceNumber: maskNumber(r.fields?.invoiceNumber),
      issueDate: r.fields?.issueDate ?? null,
      netAmount: yuan(r.fields?.netAmount),
      taxAmount: yuan(r.fields?.taxAmount),
      totalAmount: yuan(r.fields?.totalAmount),
      amountCheck: r.amounts?.status ?? null,
      candidates: r.candidates.map((c) => c.field),
    }));
}
