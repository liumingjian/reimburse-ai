import { ProjectBookResultSchema, type ProjectBookResult } from '@baox/contract';
import type { TestClient } from './harness';
import type { ScenarioOptions } from './scenario';

// Shared by the project book (项目簿) tests: the scene they start tasks from, and their one way of writing the book.

// Hotel e-invoice + rail ticket inventoried (住宿 trio answered 确认没有, "confirm none"), with the project book exactly
// as the test left it: `scenario(server, client).at('project', INVENTORIED)`.
export const INVENTORIED = { materials: ['m01', 'm07'], projectBook: 'as_is' } as const satisfies ScenarioOptions;

// One write to a project book endpoint (intake, edit, deactivate, convert, …), expected to be answered 200: its result.
// A refusal is part of the result (`status: 'rejected'`), not an HTTP error.
export async function bookChange(client: TestClient, path: string, body: unknown): Promise<ProjectBookResult> {
  const response = await client.post(path, body);
  if (response.status !== 200) throw new Error(`${path}: expected 200, got ${response.status} ${await response.text()}`);
  return ProjectBookResultSchema.parse(await response.json());
}
