import type { TaskSnapshot } from '@baox/contract';

export function LatestUploadRejections({ snapshot }: { snapshot: TaskSnapshot }) {
  const rejected = snapshot.batches.at(-1)?.files.filter((file) => file.status === 'rejected') ?? [];
  if (rejected.length === 0) return null;
  return <section className="app-block" aria-label="本次未接收的文件" role="status">
    <h2 className="app-section-title">本次未接收的文件</h2>
    <ul>{rejected.map((file, index) => <li key={index}>{file.fileName}：{file.reason}</li>)}</ul>
  </section>;
}
