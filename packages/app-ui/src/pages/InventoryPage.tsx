import { MATERIAL_ROLE_LABELS, type ExpenseEvent, type Material, type TaskSnapshot } from '../contract/snapshot';
import { formatDateTime } from '../format';
import { taskHash } from '../router';
import { PAGE_COPY } from './page-copy';

// 材料盘点页：盘点进行中显示分阶段进度；结束后按费用事件归组显示主要报销凭证、参考材料、材料证据关联结论，
// 以及每份材料的字段候选与来源（规则名或 user）。页面只渲染快照，不做配对、不算金额。

const EVIDENCE_LABELS: Readonly<Record<Material['fields'][number]['evidence'], string>> = {
  explicit: '',
  derived: '推导',
  ambiguous: '存疑',
  missing: '缺失',
};

function StatusBadge({ material }: { material: Material }) {
  if (material.status === 'ok') return <span className="badge badge-ok">通过</span>;
  if (material.status === 'pending') return <span className="badge badge-warn">待确认</span>;
  if (material.status === 'excluded') return <span className="badge">已排除</span>;
  return <span className="badge">待盘点</span>;
}

function FieldList({ material }: { material: Material }) {
  if (material.fields.length === 0) return <span className="muted">无</span>;
  return (
    <dl className="kv compact">
      {material.fields.map((candidate) => (
        <div key={candidate.key} className="kv-row">
          <dt>{candidate.label}</dt>
          <dd>
            <span className="mono">{candidate.value || <span className="muted">未填</span>}</span>
            <span className="caption source">
              {candidate.source}
              {EVIDENCE_LABELS[candidate.evidence] ? ` · ${EVIDENCE_LABELS[candidate.evidence]}` : ''}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

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
      <td>
        <FieldList material={material} />
      </td>
      <td>{material.checkText || <span className="muted">无</span>}</td>
      <td>
        <StatusBadge material={material} />
      </td>
    </tr>
  );
}

type Group = { voucher: Material; events: ExpenseEvent[]; references: Material[] };

// 同一主要报销凭证的事件相邻（服务端已按统一业务序号排好），这里只是把它们收拢成组来显示。
function groupEvents(snapshot: TaskSnapshot): { groups: Group[]; ungrouped: Material[] } {
  const byId = new Map(snapshot.materials.map((material) => [material.materialId, material]));
  const groups: Group[] = [];
  const grouped = new Set<string>();
  for (const event of snapshot.events) {
    const voucher = byId.get(event.voucherMaterialId);
    if (!voucher) continue;
    let group = groups.find((candidate) => candidate.voucher.materialId === voucher.materialId);
    if (!group) {
      group = { voucher, events: [], references: [] };
      groups.push(group);
      grouped.add(voucher.materialId);
    }
    group.events.push(event);
    for (const referenceId of event.referenceMaterialIds) {
      const reference = byId.get(referenceId);
      if (reference && !group.references.some((existing) => existing.materialId === referenceId)) {
        group.references.push(reference);
        grouped.add(referenceId);
      }
    }
  }
  const ungrouped = snapshot.materials.filter((material) => !grouped.has(material.materialId));
  return { groups, ungrouped };
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
        <td colSpan={5}>
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
  const done = snapshot.inventory.status === 'done';
  const openCount = snapshot.pendingItems.filter((item) => item.status === 'open').length;
  const counts = {
    ok: snapshot.materials.filter((material) => material.status === 'ok').length,
    pending: snapshot.materials.filter((material) => material.status === 'pending').length,
    vouchers: snapshot.materials.filter((material) => material.role === 'primary_voucher').length,
    references: snapshot.materials.filter((material) => material.role === 'reference').length,
  };
  const { groups, ungrouped } = groupEvents(snapshot);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{copy.title}</h1>
          <p className="lead">{done ? `上传批次的 ${snapshot.materials.length} 份材料已分别由对应规则认领。${copy.lead}` : copy.lead}</p>
        </div>
        {done ? (
          <div className="actions">
            {openCount > 0 ? (
              <a className="btn btn-primary" href={taskHash(taskId, 'pending')}>
                处理 {openCount} 个待确认项
              </a>
            ) : (
              <a className="btn btn-primary" href={taskHash(taskId, 'review')}>
                进入整单明细确认
              </a>
            )}
          </div>
        ) : null}
      </div>

      {!done ? (
        <Progress snapshot={snapshot} />
      ) : (
        <>
          <div className="badge-row">
            <span className="badge badge-ok">通过 {counts.ok}</span>
            <span className={counts.pending > 0 ? 'badge badge-warn' : 'badge'}>待确认 {counts.pending}</span>
            <span className="badge">{MATERIAL_ROLE_LABELS.primary_voucher} {counts.vouchers}</span>
            <span className="badge">{MATERIAL_ROLE_LABELS.reference} {counts.references}</span>
            <span className="caption">
              盘点版本 {snapshot.inventory.versionId ?? '?'}
              {snapshot.inventory.finishedAt ? ` · ${formatDateTime(snapshot.inventory.finishedAt)}` : ''}
            </span>
          </div>
          <section className="panel table" aria-label="盘点结果">
            <table className="data inventory">
              <thead>
                <tr>
                  <th>文件</th>
                  <th>识别为</th>
                  <th>字段候选 · 来源</th>
                  <th>校验</th>
                  <th>状态</th>
                </tr>
              </thead>
              {groups.map((group) => (
                <EventGroup key={group.voucher.materialId} group={group} />
              ))}
              {ungrouped.length > 0 ? (
                <tbody className="event-group" aria-label="未归入费用事件">
                  <tr className="group-head">
                    <td colSpan={5}>
                      <div className="group-title">未归入费用事件</div>
                      <div className="evidence-note">
                        <span className="muted">材料证据关联</span> 没有形成费用事件的材料：待确认或已排除。
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
