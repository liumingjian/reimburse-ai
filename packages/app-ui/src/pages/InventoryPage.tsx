import { MATERIAL_ROLE_LABELS, type ExpenseEvent, type Material, type TaskSnapshot } from '../contract/snapshot';
import { formatDateTime } from '../format';
import { taskHash } from '../router';
import { DuplicateBlockers } from './DuplicateBlockers';
import { PAGE_COPY } from './page-copy';

// 材料盘点页：只有盘点进度与材料清单。盘点进行中显示分阶段进度；结束后按费用事件归组列出主要报销凭证与参考材料、
// 材料证据关联结论和每份材料的校验结果。不展示读出的字段及其来源（Skill 没有盘点结果表，内核不许把规则名给员工看）。
// 跨任务重复发票命中时整批停，显示重复发票表。页面只渲染快照，不做配对、不算金额。

function StatusBadge({ material }: { material: Material }) {
  if (material.status === 'ok') return <span className="badge badge-ok">通过</span>;
  if (material.status === 'pending') return <span className="badge badge-warn">待确认</span>;
  if (material.status === 'excluded') return <span className="badge">已排除</span>;
  return <span className="badge">待盘点</span>;
}

const COLUMNS = ['文件', '识别为', '校验', '状态'] as const;

function MaterialRow({ material, roleLabel }: { material: Material; roleLabel: string }) {
  return (
    <tr className={material.status === 'pending' ? 'row-warn' : undefined}>
      <td>
        <span className="mono">{material.fileName}</span>
        <div className="caption">{roleLabel}</div>
      </td>
      <td>
        {material.kindLabel}
        {material.categoryLabel ? <div className="caption">{material.categoryLabel}</div> : null}
      </td>
      <td>{material.checkText || <span className="muted">无</span>}</td>
      <td>
        <StatusBadge material={material} />
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

function eventTitle(group: Group): string {
  const first = group.events[0];
  const last = group.events[group.events.length - 1];
  if (!first || !last) return '';
  const nos = first.no === last.no ? `费用事件 ${first.no}` : `费用事件 ${first.no}-${last.no}`;
  const dates = first.endDate ? `${first.date} 至 ${first.endDate}` : first.date === last.date ? first.date : `${first.date} 至 ${last.date}`;
  const gross = group.events.length === 1 ? first.grossAmount : group.events.map((event) => event.grossAmount).join(' + ');
  return `${nos} · ${dates} · ${first.category.label} · ${gross}`;
}

function EventGroup({ group }: { group: Group }) {
  const note = group.events.map((event) => event.evidenceNote).find((text) => text);
  return (
    <tbody className="event-group" aria-label={eventTitle(group)}>
      <tr className="group-head">
        <td colSpan={COLUMNS.length}>
          <div className="group-title">{eventTitle(group)}</div>
          <ul className="event-lines">
            {group.events.map((event) => (
              <li key={event.eventId}>
                <span className="mono">No.{event.no}</span> {event.summary} <span className="mono">{event.grossAmount}</span>
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
    </tbody>
  );
}

function Progress({ snapshot }: { snapshot: TaskSnapshot }) {
  const running = snapshot.inventory.phases.find((phase) => phase.status === 'running');
  return (
    <section className="panel" aria-label="盘点进度">
      <p className="lead" role="status">
        {running ? `正在盘点：${running.label}` : '正在准备盘点'}
      </p>
      <ol className="steps">
        {snapshot.inventory.phases.map((phase, index) => (
          <li key={phase.key} className={phase.status}>
            <span className="dot">{phase.status === 'done' ? '✓' : index + 1}</span>
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

  const lead = !summary
    ? copy.lead
    : blocked
      ? `上传批次的 ${summary.materialCount} 份材料已盘点，发现重复发票，这批材料整批暂停。`
      : `上传批次的 ${summary.materialCount} 份材料已盘点完。${copy.lead}`;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{copy.title}</h1>
          <p className="lead">{lead}</p>
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
          <div className="badge-row">
            <span className="badge badge-ok">通过 {summary.okCount}</span>
            <span className={summary.pendingMaterialCount > 0 ? 'badge badge-warn' : 'badge'}>待确认 {summary.pendingMaterialCount}</span>
            <span className="badge">{MATERIAL_ROLE_LABELS.primary_voucher} {summary.voucherCount}</span>
            <span className="badge">{MATERIAL_ROLE_LABELS.reference} {summary.referenceCount}</span>
            <span className="caption">
              盘点版本 {snapshot.inventory.versionId ?? '?'}
              {snapshot.inventory.finishedAt ? ` · ${formatDateTime(snapshot.inventory.finishedAt)}` : ''}
            </span>
          </div>
          <DuplicateBlockers snapshot={snapshot} />
          <section className="panel table" aria-label="盘点结果">
            <table className="data inventory">
              <thead>
                <tr>
                  {COLUMNS.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              {groups.map((group) => (
                <EventGroup key={group.voucher.materialId} group={group} />
              ))}
              {ungrouped.length > 0 ? (
                <tbody className="event-group" aria-label="未归入费用事件">
                  <tr className="group-head">
                    <td colSpan={COLUMNS.length}>
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
