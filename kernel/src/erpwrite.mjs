/**
 * 写入前的那一次点头。
 *
 * 这是整条链子上**唯一不可撤销的分界线**：越过它，ERP 里就多了一张单据，
 * 而 baox 撤不回来。所以这一步的判据比前面每一步都硬 ——
 *
 *  1. 点头**只对它看见的那一份内容**有效。摆出去的每一行、每一个金额、
 *     每一个项目号一起算一个指纹；其中任何一个字变了，上次的点头当场作废。
 *     指纹不能只覆盖金额和日期：换个项目号照样是换了一张要写进 ERP 的单。
 *  2. 点头**要有内核此刻挂着的那个一次性凭据**（闸在 confirm.mjs 里）。
 *     聊天里飘过的一句"可以写了"不带凭据，永远变不成这份记录。
 *  3. 记下的是**用户看过的那份内容本身**，不只是一个"同意"标记：
 *     事后要答得出"他当时点头的是哪一版"，答不出就等于没有点过头。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { taskDir } from './workspace.mjs';

const approvalFile = (task) => path.join(taskDir(task), 'write-approval.json');

/**
 * 待写内容的指纹。覆盖用户在那张表上看得见的每一样东西 ——
 * 看得见却没进指纹的字段，等于用户没为它点过头。
 */
export function writePreviewDigest({ lines, homeCity, purpose, versionId }) {
  const shape = {
    versionId: versionId ?? null,
    homeCity: homeCity ?? null,
    purpose: purpose ?? null,
    lines: (lines ?? []).map((l) => [l.lineId, l.voucherMaterialId, l.maskedNumber, l.date, l.city,
      l.netAmount, l.taxAmount, l.totalAmount, l.category, l.expenseItemCode, l.project]),
  };
  return crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 32);
}

export function recordWriteApproval(task, preview) {
  const record = {
    digest: writePreviewDigest(preview),
    versionId: preview.versionId ?? null,
    lineCount: preview.lines?.length ?? 0,
    totalCents: (preview.lines ?? []).reduce((a, l) => a + Math.round(Number(l.totalAmount ?? 0) * 100), 0),
    approvedAt: new Date().toISOString(),
    approvedVia: 'terminal',
  };
  const p = approvalFile(task);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.renameSync(`${p}.tmp`, p);
  return record;
}

export function loadWriteApproval(task) {
  if (!task?.createdAt) return null;
  try { return JSON.parse(fs.readFileSync(approvalFile(task), 'utf8')); } catch { return null; }
}

/** 这份点头是不是正对着现在要写的这份内容。差一个字段就不是。 */
export const approvalCovers = (approval, preview) =>
  !!approval && approval.digest === writePreviewDigest(preview);
