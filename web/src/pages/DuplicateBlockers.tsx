import { Button, InlineNotification, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@carbon/react';
import { BLOCKER_TABLE_COLUMNS, DUPLICATE_BLOCKER_COPY, type TaskSnapshot } from '@baox/contract';
import { ActionError } from '../shell/ActionError';
import { useAction } from '../shell/useAction';

// 跨任务重复发票（内核 duplicate_blocked）：命中就停整批。表格列照内核 itemTable，行文字与命中的任务由服务端给出；
// 序号按行序写，「参考材料」列内核写破折号，这里留空。盘点页与待确认项页共用。
// 处置照内核「把文件移出」：每行一个「移出 <文件名>」，经 exclude-material（带 stepToken）请服务端把它移出本次材料；
// 能不能移出由服务端判定，移出后阻塞解除、接着划分费用事件（新快照经事件流送到）。

export function DuplicateBlockers({ snapshot }: { snapshot: TaskSnapshot }) {
  const taskId = snapshot.task.taskId;
  const { busy, error, run } = useAction(taskId);
  const hits = snapshot.blockers.filter((blocker) => blocker.kind === 'duplicate_across_tasks');
  if (hits.length === 0) return null;
  // 同一个任务可能占着多张发票，只列一次。
  const tasks = [...new Map(hits.flatMap((hit) => hit.tasks).map((task) => [task.taskId, task])).values()];
  const remove = (materialId: string) => run((adapter) => adapter.excludeMaterial(taskId, materialId, snapshot.step.stepToken));
  return (
    <section className="app-block" aria-label="跨任务重复发票">
      <InlineNotification
        kind="error"
        role="alert"
        lowContrast
        hideCloseButton
        statusIconDescription="错误"
        title={`${DUPLICATE_BLOCKER_COPY.blocked}${DUPLICATE_BLOCKER_COPY.disposal}`}
      />
      <div className="bleed app-table">
        <Table aria-label="重复发票">
          <TableHead>
            <TableRow>
              {BLOCKER_TABLE_COLUMNS.map((column) => (
                <TableHeader key={column}>{column}</TableHeader>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {hits.map((hit, index) => (
              <TableRow key={hit.materialId}>
                <TableCell className="app-nowrap">{index + 1}</TableCell>
                <TableCell className="app-file-name">{hit.fileName}</TableCell>
                <TableCell />
                <TableCell>{hit.reason}</TableCell>
                <TableCell className="app-nowrap">{hit.resolver}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="app-btn-row app-block-actions">
        {hits.map((hit) => (
          <Button key={hit.materialId} kind="secondary" size="sm" disabled={busy} onClick={() => void remove(hit.materialId)}>
            移出 {hit.fileName}
          </Button>
        ))}
        <span className="app-caption">移出后这份文件不参与本次盘点，也不进入材料包。</span>
      </div>
      <ActionError message={error} />
      <h3 className="app-subhead">命中的任务</h3>
      <ul className="app-plain-list" aria-label="命中的任务">
        {tasks.map((task) => (
          <li key={task.taskId}>{task.name}</li>
        ))}
      </ul>
      <p className="app-caption">{DUPLICATE_BLOCKER_COPY.scope}</p>
    </section>
  );
}
