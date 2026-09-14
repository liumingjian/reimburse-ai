import { useState } from 'react';
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableExpandedRow,
  TableExpandHeader,
  TableExpandRow,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import { CheckmarkFilled, InProgress } from '@carbon/icons-react';
import { MATERIAL_ROLE_LABELS, type ExpenseEvent, type Material, type TaskSnapshot } from '../contract/snapshot';
import { formatDateTime } from '../format';
import { taskHash } from '../router';
import { PageHeader } from '../shell/PageHeader';
import { StatusTag } from '../shell/StatusTag';
import { DuplicateBlockers } from './DuplicateBlockers';
import { PAGE_COPY } from './page-copy';

// 材料盘点页：只有盘点进度与材料清单。盘点进行中显示分阶段进度；结束后是一张 Carbon 可展开表格，
// 每行一个费用事件组（同一主要报销凭证的相邻事件），展开后是该组的材料证据关联结论与材料小表。
// 不展示读出的字段及其来源（Skill 没有盘点结果表，内核不许把规则名给员工看）。
// 跨任务重复发票命中时整批停，显示重复发票表。页面只渲染快照，不做配对、不算金额。
// 版式：含待确认材料的组默认展开，其余默认收起；用户点过的记在界面状态里；表头有「全部展开 / 全部收起」。
// 只标记例外：通过的材料不带标签；需要注意的材料只用 warm-gray 加警示图标的标签标出，不给整行上底色。
// 没有归入任何费用事件的材料单独一节，放在表格下方。
// 标题下是和整单明细确认同一种摘要条，计数全部取服务端的 inventory.summary。

// 需要注意的「待确认」用共用的状态标签（图标加文字）；已排除、待盘点是中性灰标签。
function StatusMark({ status }: { status: Material['status'] | null }) {
  if (status === 'pending') return <StatusTag tone="warning">待确认</StatusTag>;
  if (status === 'excluded') return <Tag type="gray">已排除</Tag>;
  if (status === 'uploaded') return <Tag type="gray">待盘点</Tag>;
  return null;
}

// 收起的组行显示组内最严重的状态：待确认 > 待盘点 > 已排除 > 无。这只是把服务端给的状态排个显示先后，不做判定。
const STATUS_SEVERITY: ReadonlyArray<Material['status']> = ['pending', 'uploaded', 'excluded'];

function groupStatus(materials: readonly Material[]): Material['status'] | null {
  return STATUS_SEVERITY.find((status) => materials.some((material) => material.status === status)) ?? null;
}

const GROUP_COLUMNS = ['费用事件', '日期', '金额', '份数', '状态'] as const;
const MATERIAL_COLUMNS = ['文件', '识别为', '校验', '状态'] as const;

type Group = { voucher: Material; events: ExpenseEvent[]; references: Material[] };

// 服务端已按统一业务序号排好，同一主要报销凭证的事件相邻；这里只把相邻、同一凭证的事件收拢成一组显示，
// 组内的参考材料照各事件列出的 id 显示。没有归入任何事件的材料由服务端在 inventory.ungroupedMaterialIds 里给出。
function groupEvents(snapshot: TaskSnapshot, byId: ReadonlyMap<string, Material>): Group[] {
  const groups: Group[] = [];
  for (const event of snapshot.events) {
    const voucher = byId.get(event.voucherMaterialId);
    if (!voucher) continue;
    const last = groups[groups.length - 1];
    const group = last && last.voucher.materialId === voucher.materialId ? last : { voucher, events: [], references: [] };
    if (group !== last) groups.push(group);
    group.events.push(event);
    for (const referenceId of event.referenceMaterialIds) {
      const reference = byId.get(referenceId);
      if (reference && !group.references.includes(reference)) group.references.push(reference);
    }
  }
  return groups;
}

// 组的各部分：序号区间、日期、类别、金额。金额照服务端给的每个事件的价税合计列出，不求和。
function groupParts(group: Group) {
  const first = group.events[0];
  const last = group.events[group.events.length - 1];
  if (!first || !last) return null;
  const day = (date: string) => date.slice(5);
  const nos = first.no === last.no ? `${first.no}` : `${first.no}-${last.no}`;
  const dates = first.endDate
    ? `${day(first.date)} 至 ${day(first.endDate)}`
    : first.date === last.date
      ? day(first.date)
      : `${day(first.date)} 至 ${day(last.date)}`;
  const gross = group.events.map((event) => event.grossAmount).join(' + ');
  return { nos, dates, category: first.category.label, gross };
}

// 材料小表：文件名（下面一行是角色）、识别为、校验、状态。
// 校验文本已被材料证据关联结论完整说过时（如参考材料的「26.69 + 20.85 + 21.65 = 69.19，按分守恒」），
// 不再重复一遍，改写「见材料证据关联」。只是比较两段服务端原文，不改写、不判定。
function MaterialTable({ label, materials, note }: { label: string; materials: readonly Material[]; note: string | null }) {
  return (
    <Table size="sm" aria-label={label} className="app-material-table">
      <TableHead>
        <TableRow>
          {MATERIAL_COLUMNS.map((column) => (
            <TableHeader key={column}>{column}</TableHeader>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {materials.map((material) => (
          <TableRow key={material.materialId}>
            <TableCell>
              <span className="app-file-name">{material.fileName}</span>
              <div className="app-caption">{MATERIAL_ROLE_LABELS[material.role]}</div>
            </TableCell>
            <TableCell>
              {material.kindLabel}
              {material.categoryLabel ? <div className="app-caption">{material.categoryLabel}</div> : null}
            </TableCell>
            <TableCell>
              {!material.checkText ? (
                <span className="app-muted">无</span>
              ) : note && note.includes(material.checkText) ? (
                <span className="app-muted">见材料证据关联</span>
              ) : (
                material.checkText
              )}
            </TableCell>
            <TableCell>
              <StatusMark status={material.status} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function GroupDetail({ group, title }: { group: Group; title: string }) {
  const note = group.events.map((event) => event.evidenceNote).find((text) => text) ?? null;
  return (
    <>
      {note ? (
        <p className="app-evidence-note">
          <span className="app-evidence-label">材料证据关联</span>
          <span>{note}</span>
        </p>
      ) : null}
      {/* 单个事件的组不再列自己的事件行：组行已经说过了。 */}
      {group.events.length > 1 ? (
        <ul className="app-event-lines" aria-label={`${title} 的明细`}>
          {group.events.map((event) => (
            <li key={event.eventId}>
              <span className="app-muted">No.{event.no}</span> {event.summary} <span className="app-amount">{event.grossAmount}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <MaterialTable label={`${title} 的材料`} materials={[group.voucher, ...group.references]} note={note} />
    </>
  );
}

function SummaryField({ label, value, grow = false }: { label: string; value: string; grow?: boolean }) {
  return (
    <div className={grow ? 'app-summary-field app-grow' : 'app-summary-field'}>
      <span className="app-summary-key">{label}</span>
      <span className="app-summary-value">{value}</span>
    </div>
  );
}

// 盘点进度：竖排的步骤清单，状态用图标加文字（颜色只是第二通道）。
function PhaseMark({ status, index }: { status: string; index: number }) {
  if (status === 'done') return <CheckmarkFilled />;
  if (status === 'running') return <InProgress />;
  return <>{index + 1}</>;
}

function Progress({ snapshot }: { snapshot: TaskSnapshot }) {
  const running = snapshot.inventory.phases.find((phase) => phase.status === 'running');
  return (
    <section className="app-block" aria-label="盘点进度">
      <p className="app-progress-lead" role="status">
        {running ? `正在盘点：${running.label}` : '正在准备盘点'}
      </p>
      <ol className="app-steps">
        {snapshot.inventory.phases.map((phase, index) => (
          <li key={phase.key} className={`is-${phase.status}`}>
            <span className="app-step-dot" aria-hidden="true">
              <PhaseMark status={phase.status} index={index} />
            </span>
            <span>{phase.label}</span>
            <span className="status">{phase.status === 'done' ? '完成' : phase.status === 'running' ? '进行中' : ''}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function InventoryPage({ snapshot }: { snapshot: TaskSnapshot }) {
  const copy = PAGE_COPY.inventory;
  const taskId = snapshot.task.taskId;
  // 盘点结果的计数来自服务端（inventory.summary），页面不自己数。
  const summary = snapshot.inventory.status === 'done' ? snapshot.inventory.summary : null;
  const blocked = snapshot.blockers.length > 0;
  const byId = new Map(snapshot.materials.map((material) => [material.materialId, material]));
  const groups = groupEvents(snapshot, byId);
  const ungrouped = snapshot.inventory.ungroupedMaterialIds.flatMap((id) => byId.get(id) ?? []);
  // 展开与否是纯界面状态：记下用户对各组的选择（含全部展开 / 全部收起），没选过的组由「组里有没有待确认材料」决定。
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const rows = groups.map((group) => {
    const key = group.voucher.materialId;
    const materials = [group.voucher, ...group.references];
    const status = groupStatus(materials);
    return { key, group, status, expanded: chosen.get(key) ?? status === 'pending' };
  });
  const allExpanded = rows.length > 0 && rows.every((row) => row.expanded);
  const setExpanded = (key: string, expanded: boolean) => setChosen((previous) => new Map(previous).set(key, expanded));
  const setAll = (expanded: boolean) => setChosen(new Map(rows.map((row) => [row.key, expanded])));

  const version = snapshot.inventory.versionId;
  const finishedAt = snapshot.inventory.finishedAt;
  const lead = !summary ? copy.lead : blocked ? '发现重复发票，整批暂停。' : copy.lead;

  return (
    <>
      <PageHeader
        title={copy.title}
        lead={lead}
        actions={
          summary && !blocked ? (
            summary.openPendingItemCount > 0 ? (
              <Button href={taskHash(taskId, 'pending')}>处理 {summary.openPendingItemCount} 个待确认项</Button>
            ) : (
              <Button href={taskHash(taskId, 'project')}>进入项目归属</Button>
            )
          ) : null
        }
      />

      {!summary ? (
        <Progress snapshot={snapshot} />
      ) : (
        <>
          {/* 摘要条：写法同整单明细确认；数字全部来自服务端的 inventory.summary，页面不数。 */}
          <div className="app-summary bleed" role="group" aria-label="盘点摘要">
            <SummaryField label="材料" value={`${summary.materialCount} 份`} />
            <SummaryField label="通过" value={`${summary.okCount} 份`} />
            <SummaryField label="需处理" value={`${summary.pendingMaterialCount} 份`} />
            <SummaryField label={MATERIAL_ROLE_LABELS.primary_voucher} value={`${summary.voucherCount} 份`} />
            <SummaryField label={MATERIAL_ROLE_LABELS.reference} value={`${summary.referenceCount} 份`} />
            <SummaryField label="盘点版本" value={version ?? '无'} grow />
            {finishedAt ? <SummaryField label="盘点时间" value={formatDateTime(finishedAt)} /> : null}
          </div>
          <DuplicateBlockers snapshot={snapshot} />
          {rows.length > 0 ? (
            <section className="bleed app-table app-inventory" aria-label="盘点结果">
              <Table size="md" aria-label="费用事件">
                <TableHead>
                  <TableRow>
                    <TableExpandHeader
                      enableToggle
                      isExpanded={allExpanded}
                      onExpand={() => setAll(!allExpanded)}
                      aria-label={allExpanded ? '全部收起' : '全部展开'}
                      expandIconDescription={allExpanded ? '全部收起' : '全部展开'}
                    />
                    {GROUP_COLUMNS.map((column) => (
                      <TableHeader key={column}>{column}</TableHeader>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map(({ key, group, status, expanded }) => {
                    const parts = groupParts(group);
                    const title = parts ? `费用事件 No.${parts.nos}` : '费用事件';
                    const detailId = `inventory-group-${key}`;
                    return [
                      <TableExpandRow
                        key={key}
                        isExpanded={expanded}
                        onExpand={() => setExpanded(key, !expanded)}
                        aria-label={title}
                        aria-controls={expanded ? detailId : undefined}
                        expandIconDescription={expanded ? '收起' : '展开'}
                      >
                        <TableCell>
                          <span className="app-group-no">No.{parts?.nos}</span> <span className="app-group-category">{parts?.category}</span>
                        </TableCell>
                        <TableCell className="app-nowrap">{parts?.dates}</TableCell>
                        <TableCell className="app-amount-cell">{parts?.gross}</TableCell>
                        <TableCell className="app-nowrap">{1 + group.references.length} 份</TableCell>
                        <TableCell>
                          <StatusMark status={status} />
                        </TableCell>
                      </TableExpandRow>,
                      expanded ? (
                        <TableExpandedRow key={`${key}-detail`} id={detailId} colSpan={GROUP_COLUMNS.length + 1} aria-label={title}>
                          <GroupDetail group={group} title={title} />
                        </TableExpandedRow>
                      ) : null,
                    ];
                  })}
                </TableBody>
              </Table>
            </section>
          ) : null}
          {ungrouped.length > 0 ? (
            <section className="app-ungrouped" aria-label="未归入费用事件">
              <h3 className="app-subhead">未归入费用事件</h3>
              <p className="app-caption">{blocked ? '整批暂停，还没有划分费用事件。' : '没有形成费用事件的材料：待确认或已排除。'}</p>
              <div className="bleed app-table">
                <MaterialTable label="未归入费用事件的材料" materials={ungrouped} note={null} />
              </div>
            </section>
          ) : null}
        </>
      )}
    </>
  );
}
