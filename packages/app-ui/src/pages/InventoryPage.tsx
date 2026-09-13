import { useState } from 'react';
import { MATERIAL_ROLE_LABELS, type ExpenseEvent, type Material, type TaskSnapshot } from '../contract/snapshot';
import { formatDateTime } from '../format';
import { taskHash } from '../router';
import { Icon } from '../shell/Icon';
import { DuplicateBlockers } from './DuplicateBlockers';
import { PAGE_COPY } from './page-copy';

// 材料盘点页：只有盘点进度与材料清单。盘点进行中显示分阶段进度；结束后按费用事件归组列出主要报销凭证与参考材料、
// 材料证据关联结论和每份材料的校验结果。不展示读出的字段及其来源（Skill 没有盘点结果表，内核不许把规则名给员工看）。
// 跨任务重复发票命中时整批停，显示重复发票表。页面只渲染快照，不做配对、不算金额。
// 版式（DESIGN.md「版式规则」）：一句结论打头；全部通过的事件默认收成一行，点开才看文件与校验；
// 含待确认材料的事件默认展开并加标记；只标记例外，通过的材料不带标签。
// 收起的事件行按表头的四列排开（序号与类别 | 日期 | 金额 | 材料数），和展开后的材料行、表头对齐。

function StatusTag({ material }: { material: Material }) {
  if (material.status === 'pending')
    return (
      <span className="tag tag-warning">
        <Icon name="warning--alt--filled" />
        待确认
      </span>
    );
  if (material.status === 'excluded') return <span className="tag tag-neutral">已排除</span>;
  if (material.status === 'uploaded') return <span className="tag tag-neutral">待盘点</span>;
  return null;
}

const COLUMNS = ['文件', '识别为', '校验', '状态'] as const;

function Columns() {
  return (
    <colgroup>
      <col className="col-file" />
      <col className="col-kind" />
      <col className="col-check" />
      <col className="col-status" />
    </colgroup>
  );
}

function MaterialRow({ material, roleLabel }: { material: Material; roleLabel: string }) {
  return (
    <tr className={material.status === 'pending' ? 'row-warn' : undefined}>
      <td>
        <span className="file-name">{material.fileName}</span>
        <div className="caption">{roleLabel}</div>
      </td>
      <td>
        {material.kindLabel}
        {material.categoryLabel ? <div className="caption">{material.categoryLabel}</div> : null}
      </td>
      <td>{material.checkText || <span className="muted">无</span>}</td>
      <td>
        <StatusTag material={material} />
      </td>
    </tr>
  );
}

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
function groupParts(group: Group, shortDate: boolean) {
  const first = group.events[0];
  const last = group.events[group.events.length - 1];
  if (!first || !last) return null;
  const day = (date: string) => (shortDate ? date.slice(5) : date);
  const nos = first.no === last.no ? `${first.no}` : `${first.no}-${last.no}`;
  const dates = first.endDate
    ? `${day(first.date)} 至 ${day(first.endDate)}`
    : first.date === last.date
      ? day(first.date)
      : `${day(first.date)} 至 ${day(last.date)}`;
  const gross = group.events.map((event) => event.grossAmount).join(' + ');
  return { nos, dates, category: first.category.label, gross };
}

function eventTitle(group: Group): string {
  const parts = groupParts(group, false);
  return parts ? `费用事件 ${parts.nos} · ${parts.dates} · ${parts.category} · ${parts.gross}` : '';
}

function EventGroup({ group, expanded, onToggle }: { group: Group; expanded: boolean; onToggle: () => void }) {
  const note = group.events.map((event) => event.evidenceNote).find((text) => text);
  const parts = groupParts(group, true);
  const hasPending = [group.voucher, ...group.references].some((material) => material.status === 'pending');
  const className = ['event-group', hasPending ? 'has-pending' : '', expanded ? 'is-open' : ''].filter(Boolean).join(' ');
  return (
    <tbody className={className} aria-label={eventTitle(group)}>
      <tr className="group-head">
        <td colSpan={COLUMNS.length}>
          <button className="group-toggle" type="button" aria-expanded={expanded} onClick={onToggle}>
            {parts ? (
              <>
                <span className="gcol gcol-first">
                  <Icon name="chevron--right" className="chevron" />
                  <span className="group-no">No.{parts.nos}</span> <span className="group-category">{parts.category}</span>
                </span>{' '}
                <span className="gcol group-dates">{parts.dates}</span> <span className="gcol group-gross">{parts.gross}</span>{' '}
                <span className="gcol group-count">{1 + group.references.length} 份材料</span>
              </>
            ) : null}
          </button>
        </td>
      </tr>
      {expanded ? (
        <>
          <tr className="group-detail">
            <td colSpan={COLUMNS.length}>
              <ul className="event-lines">
                {group.events.map((event) => (
                  <li key={event.eventId}>
                    <span className="muted">No.{event.no}</span> {event.summary} <span className="amount">{event.grossAmount}</span>
                  </li>
                ))}
              </ul>
              {note ? (
                <div className="evidence-note">
                  <span className="muted">材料证据关联</span> {note}
                </div>
              ) : null}
            </td>
          </tr>
          <MaterialRow material={group.voucher} roleLabel={MATERIAL_ROLE_LABELS.primary_voucher} />
          {group.references.map((reference) => (
            <MaterialRow key={reference.materialId} material={reference} roleLabel={MATERIAL_ROLE_LABELS.reference} />
          ))}
        </>
      ) : null}
    </tbody>
  );
}

// 盘点进度：Carbon 进度指示的竖排形式，状态用图标加文字。
function PhaseMark({ status, index }: { status: string; index: number }) {
  if (status === 'done') return <Icon name="checkmark--filled" />;
  if (status === 'running') return <Icon name="in-progress" />;
  return <>{index + 1}</>;
}

function Progress({ snapshot }: { snapshot: TaskSnapshot }) {
  const running = snapshot.inventory.phases.find((phase) => phase.status === 'running');
  return (
    <section className="block" aria-label="盘点进度">
      <p className="progress-lead" role="status">
        {running ? `正在盘点：${running.label}` : '正在准备盘点'}
      </p>
      <ol className="steps">
        {snapshot.inventory.phases.map((phase, index) => (
          <li key={phase.key} className={phase.status}>
            <span className="dot" aria-hidden="true">
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
  // 展开与否是纯界面状态：记下用户点过的组，默认值由「组里有没有待确认材料」决定。
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setToggled((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const headline = !summary
    ? copy.lead
    : blocked
      ? `${summary.materialCount} 份材料，发现重复发票，整批暂停。`
      : summary.pendingMaterialCount > 0
        ? `${summary.materialCount} 份材料，${summary.okCount} 份通过，${summary.pendingMaterialCount} 份需要你处理`
        : `${summary.materialCount} 份材料，${summary.okCount} 份通过`;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{copy.title}</h1>
          <p className={summary ? 'headline' : 'lead'} title={summary ? copy.lead : undefined}>
            {headline}
          </p>
          {summary ? (
            <p className="caption meta-line">
              {MATERIAL_ROLE_LABELS.primary_voucher} {summary.voucherCount} · {MATERIAL_ROLE_LABELS.reference} {summary.referenceCount} · 盘点版本{' '}
              {snapshot.inventory.versionId ?? '?'}
              {snapshot.inventory.finishedAt ? ` · ${formatDateTime(snapshot.inventory.finishedAt)}` : ''}
            </p>
          ) : null}
        </div>
        {summary && !blocked ? (
          <div className="actions">
            {summary.openPendingItemCount > 0 ? (
              <a className="btn btn-primary" href={taskHash(taskId, 'pending')}>
                处理 {summary.openPendingItemCount} 个待确认项
              </a>
            ) : (
              <a className="btn btn-primary" href={taskHash(taskId, 'project')}>
                进入项目归属
              </a>
            )}
          </div>
        ) : null}
      </div>

      {!summary ? (
        <Progress snapshot={snapshot} />
      ) : (
        <>
          <DuplicateBlockers snapshot={snapshot} />
          <section className="table-scroll bleed inventory-table" aria-label="盘点结果">
            <table className="data inventory">
              <Columns />
              <thead>
                <tr>
                  {COLUMNS.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              {groups.map((group) => {
                const key = group.voucher.materialId;
                const pending = [group.voucher, ...group.references].some((material) => material.status === 'pending');
                return <EventGroup key={key} group={group} expanded={pending !== toggled.has(key)} onToggle={() => toggle(key)} />;
              })}
              {ungrouped.length > 0 ? (
                <tbody className="event-group is-open has-pending" aria-label="未归入费用事件">
                  <tr className="group-head">
                    <td colSpan={COLUMNS.length} className="ungrouped-head">
                      <div className="group-title">未归入费用事件</div>
                      <div className="evidence-note">
                        <span className="muted">材料证据关联</span> {blocked ? '整批暂停，还没有划分费用事件。' : '没有形成费用事件的材料：待确认或已排除。'}
                      </div>
                    </td>
                  </tr>
                  {ungrouped.map((material) => (
                    <MaterialRow key={material.materialId} material={material} roleLabel={MATERIAL_ROLE_LABELS[material.role]} />
                  ))}
                </tbody>
              ) : null}
            </table>
          </section>
        </>
      )}
    </>
  );
}
