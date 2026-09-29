import type { Db } from '../db/database';

// ERP facts a test asserts on that the task snapshot does not carry. The ERP action attempts (ADR-0014's freeze) are
// read straight from the database, in the order they were recorded.

// The actions of the task's ERP action attempts (`import`, `fill`), oldest first.
export async function attemptedActions(db: Db, taskId: string): Promise<string[]> {
  return (await db.selectFrom('erp_attempt').select('action').where('task_id', '=', taskId).execute()).map((attempt) => attempt.action);
}
