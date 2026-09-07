import { loadIndex, loadInvoiceSightings, taskDir, ARCHIVED } from './workspace.mjs';
import { maskNumber } from './parse.mjs';

// 跨任务历史发票的重复检查。
//
// 任务内重复在分流那一层（classify）就判掉了；这一层管的是另一件事：
// **这张发票在另一个报销任务里也躺着**。同一张发票报两次是这个领域里最贵的错误之一，
// 而它最常见的成因恰恰不是恶意，是同一批材料被复制到了两个目录、分两次整理。
//
// 这一层的边界必须说清楚，否则它比没有更危险：
//
//   - 它查的是 **baox 在这台电脑上跑过的任务**，靠每个任务的 `invoices.json` 摘要。
//   - 它查不到：直接在 ERP 里录入的报销、同事报过的、换了电脑之前报的、
//     以及这台电脑上把 baox 数据目录删掉之前的一切。那要靠 ERP 只读查询，还没有实现。
//
// 所以这一层通过**不等于**这张发票没被报销过，只等于 baox 自己的账上没见过第二回。
// 这句话必须一直跟着结果走（`history_scope_local`），不能等用户自己去想。

/** 这个任务持有的发票，是否还占着位置。 */
export function holdsInvoices(task) {
  // 动过 ERP 的任务一律算占用 —— 包括写入结果未知：不知道有没有落进去，
  // 就必须当成落进去了，这是契约里对"ERP 写入结果未知"的一贯处理。
  if (task.erpWriteState) return true;
  // 存档任务照样占用。它是 0.9.x 迁过来的在途任务，只是不再往下走 ——
  // 「不再往下走」和「那些票没人报」是两回事，把它当成后者就会放过一张真重复的票。
  return task.status === 'open' || task.status === ARCHIVED;
}

const statusNote = (task) => {
  if (task.erpWriteState) return `另一个任务动过 ERP（${task.erpWriteState}）`;
  if (task.status === ARCHIVED) {
    return '另一个任务是 0.9.x 留下的，已存档只读，但它占着这张票；确认不再报销就把它作废';
  }
  return '另一个任务还在进行中';
};

/**
 * 拿当前分流结果去比对其他任务持有的发票身份。
 * 命中一律阻塞：重复发票不能"确认后继续"，只能移除材料，或者把另一个任务作废。
 */
export function crossTaskDuplicates(task, classification) {
  const others = loadIndex().tasks.filter((t) => t.taskId !== task.taskId);
  const held = new Map(); // identityKey -> [{ task, invoice }]
  let scanned = 0;
  for (const t of others) {
    if (!holdsInvoices(t)) continue;
    const digest = loadInvoiceSightings(t);
    if (!digest) continue;
    scanned += 1;
    for (const inv of digest.invoices) {
      if (!held.has(inv.identityKey)) held.set(inv.identityKey, []);
      held.get(inv.identityKey).push({ task: t, invoice: inv });
    }
  }

  const hits = [];
  for (const r of classification.results) {
    if (!r.identity) continue;
    for (const h of held.get(r.identity.key) ?? []) {
      hits.push({
        materialId: r.materialId,
        fileName: r.fileName,
        // 完整发票号码不出现在输出里，任何一侧都不。
        maskedNumber: maskNumber(r.identity.number),
        otherTask: {
          taskId: h.task.taskId,
          status: h.task.status,
          sourceLabel: h.task.sourceLabel,
          createdAt: h.task.createdAt,
          workspace: taskDir(h.task),
          fileName: h.invoice.fileName,
        },
        why: statusNote(h.task),
      });
    }
  }
  return { hits, scannedTasks: scanned, checkedInvoices: classification.results.filter((r) => r.identity).length };
}

/** 跨任务重复检查这一层的待确认项。范围声明始终跟着结果走。 */
export function historyOpenItems(result) {
  const items = result.hits.map((h) => ({
    kind: 'duplicate_across_tasks',
    blocking: true,
    materialId: h.materialId,
    fileName: h.fileName,
    maskedNumber: h.maskedNumber,
    otherTaskId: h.otherTask.taskId,
    note: `这张发票在任务 ${h.otherTask.taskId}（材料目录 ${h.otherTask.sourceLabel}，`
      + `文件 ${h.otherTask.fileName}）里也在。${h.why}，所以它还占着这张发票。`
      + '同一张发票不能报两次：要么把它从本次材料里移除，'
      + `要么确认那个任务确实不报了，用 abandon-task --task ${h.otherTask.taskId} 把它作废`,
  }));
  items.push({
    kind: 'history_scope_local',
    blocking: false,
    note: `这次只比对了 baox 在本机记过的 ${result.scannedTasks} 个仍占用发票的任务。`
      + '直接在 ERP 里录入的、同事报过的、或者换电脑之前报过的，这里查不到 —— '
      + 'ERP 外部既有记录的只读查询还没有实现，所以"检查通过"不等于这些发票没被报销过',
  });
  return items;
}
