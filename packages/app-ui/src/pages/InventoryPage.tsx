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
import { ActionBar } from '../shell/ActionBar';
import { PageHeader } from '../shell/PageHeader';
import { StatusTag } from '../shell/StatusTag';
import { DuplicateBlockers } from './DuplicateBlockers';
import { PAGE_COPY } from './page-copy';

// Material inventory (材料盘点) page: inventory progress and the material list only. While inventory runs it shows
// phased progress; afterwards a Carbon expandable table with one row per expense event (费用事件) group (adjacent
// events sharing one primary voucher). Expanding a row shows the evidence conclusion and a material sub-table.
// Extracted fields and their sources are not shown (the kernel forbids exposing rule names to employees).
// A cross-task duplicate-invoice hit pauses the whole batch and shows the duplicate table instead.
// The page renders the snapshot only: no pairing, no amount arithmetic.
// Layout: groups containing a pending (待确认) material open by default, others start collapsed; user toggles live in
// UI state; the header has expand-all / collapse-all. Only exceptions are marked: passed materials carry no tag.
// Materials not in any event get their own section below the table.
// The summary bar matches whole-claim review; every count comes from the server's inventory.summary.
// The next step (处理 N 个待确认项 or 进入项目归属) sits in the sticky action bar, not the page header (#141).

// Pending uses the shared status tag (icon plus text); excluded and not-yet-inventoried use neutral gray tags.
function StatusMark({ status }: { status: Material['status'] | null }) {
  if (status === 'pending') return <StatusTag tone="warning">待确认</StatusTag>;
  if (status === 'excluded') return <Tag type="gray">已排除</Tag>;
  if (status === 'uploaded') return <Tag type="gray">待盘点</Tag>;
  return null;
}

// A collapsed group row shows the most severe status in the group: pending > uploaded > excluded > none.
// This only orders server-given statuses for display; it makes no judgement.
const STATUS_SEVERITY: ReadonlyArray<Material['status']> = ['pending', 'uploaded', 'excluded'];

function groupStatus(materials: readonly Material[]): Material['status'] | null {
  return STATUS_SEVERITY.find((status) => materials.some((material) => material.status === status)) ?? null;
}

const GROUP_COLUMNS = ['费用事件', '日期', '金额', '份数', '状态'] as const;
const MATERIAL_COLUMNS = ['文件', '识别为', '校验', '状态'] as const;

type Group = { voucher: Material; events: ExpenseEvent[]; references: Material[] };

// The server already orders events by business number, with events of the same primary voucher adjacent; this only
// folds adjacent same-voucher events into one display group and lists the reference ids each event names.
// Materials in no event come from the server in inventory.ungroupedMaterialIds.
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

// Group parts: No. range, dates, category, amounts. Amounts list each event's server gross amount; never summed.
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

// Material sub-table: file name (role on the line below), recognised as, check, status.
// When the evidence conclusion already contains a material's check text verbatim (for example the reference's
// "26.69 + 20.85 + 21.65 = 69.19，按分守恒"), the cell points to the conclusion instead of repeating it.
// This only compares two server strings; it rewrites and judges nothing.
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
      {/* A single-event group does not list its own event line: the group row already says it. */}
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

// Inventory progress: a vertical step list; status is icon plus text (colour is only a second channel).
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
  // Inventory counts come from the server (inventory.summary); the page does not count.
  const summary = snapshot.inventory.status === 'done' ? snapshot.inventory.summary : null;
  const blocked = snapshot.blockers.length > 0;
  const byId = new Map(snapshot.materials.map((material) => [material.materialId, material]));
  const groups = groupEvents(snapshot, byId);
  const ungrouped = snapshot.inventory.ungroupedMaterialIds.flatMap((id) => byId.get(id) ?? []);
  // Open / closed is pure UI state: remember the user's choice per group (including expand-all / collapse-all);
  // groups never chosen follow "does the group contain a pending material".
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
      <PageHeader title={copy.title} lead={lead} />

      {!summary ? (
        <Progress snapshot={snapshot} />
      ) : (
        <>
          {/* Summary bar, same pattern as whole-claim review; every number comes from inventory.summary. */}
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
                        {...(expanded ? { 'aria-controls': detailId } : {})}
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
      {summary && !blocked ? (
        <ActionBar
          label="下一步"
          consequence={summary.openPendingItemCount > 0 ? '待确认项处理完后，才能进入项目归属。' : null}
          actions={
            summary.openPendingItemCount > 0 ? (
              <Button href={taskHash(taskId, 'pending')}>处理 {summary.openPendingItemCount} 个待确认项</Button>
            ) : (
              <Button href={taskHash(taskId, 'project')}>进入项目归属</Button>
            )
          }
        />
      ) : null}
    </>
  );
}
