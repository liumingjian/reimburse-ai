// The task list with a job recorded before #436 (ADR-0037): its events carry the attended path's `waiting_login`
// notice and a `handed_over` result, which today's protocol no longer has. A deployed host keeps such jobs
// (`erp_job_event` is append-only), and reading one used to fail the whole list with HTTP 500.
// Setup: 去报销 runs on the `drafted` double through the page; the two legacy events are then appended to that job
// straight into `baox.sqlite`, since no executor can send them any more.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const fake = 'drafted';

export default async function legacyErpEvents(v) {
  const { page, expect } = v;
  await v.signIn();
  const taskId = await v.confirmedTask();
  await v.step('click 去报销 and let the job reach 暂存', async () => {
    await page.goto(`/#/task/${taskId}/review`);
    await page.getByRole('button', { name: '去报销', exact: true }).click();
    await expect(page.getByRole('link', { name: '查看完成结果' })).toBeVisible({ timeout: 30_000 });
  });
  await v.step('append a pre-#436 waiting_login notice and handed_over result to that job', async () => {
    const db = new DatabaseSync(join(v.dataDir, 'baox.sqlite'));
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      const { job_id: jobId, seq } = db.prepare('SELECT job_id, MAX(seq) AS seq FROM erp_job_event WHERE task_id = ? GROUP BY job_id ORDER BY MAX(created_at) DESC LIMIT 1').get(taskId);
      const insert = db.prepare('INSERT INTO erp_job_event (event_id, job_id, task_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const legacy = [
        { type: 'waiting_login', hint: '请在为这次报销打开的报销系统标签页中登录' },
        { type: 'result', status: 'handed_over', code: null, message: null, billNo: null, capture: null },
      ];
      legacy.forEach((event, i) => insert.run(randomUUID(), jobId, taskId, seq + 1 + i, event.type, JSON.stringify(event), new Date().toISOString()));
      v.note(`appended ${legacy.length} legacy events to job ${jobId} after seq ${seq}`);
    } finally {
      db.close();
    }
  });
  await v.step('open the task list', async () => {
    const listed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/tasks');
    await page.goto('/#/tasks');
    const response = await listed;
    v.note(`GET /api/tasks → ${response.status()}`);
    expect(response.status()).toBe(200);
    await expect(page.getByText('任务列表加载失败')).toHaveCount(0);
    await expect(page.getByRole('table', { name: '报销任务' }).locator('tbody tr')).toHaveCount(1);
    await v.shot('task-list');
  });
  const after = await v.record('legacy-handed-over', taskId);
  v.note(`stage ${after.stage}, erp ${after.erp?.status}/${after.erp?.outcome}`);
  expect(after.stage).toBe('done');
}
