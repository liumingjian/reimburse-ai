import type { FrozenJob } from './fill-plan';

export function withProjectNames(frozen: FrozenJob, projects: readonly { code: string; name: string }[]): FrozenJob {
  const names = new Map(projects.map(project => [project.code, project.name]));
  const expected = frozen.plan.catalog.projects;
  if (names.size !== projects.length || names.size !== expected.length || expected.some(project => !names.get(project.code)?.trim())) {
    throw new Error('ERP 核对的项目号集合与本次任务不一致');
  }
  const canonical = expected.map(project => ({ ...project, name: names.get(project.code)! }));
  return { ...frozen, plan: { ...frozen.plan, catalog: { ...frozen.plan.catalog, projects: canonical } },
    judge: { ...frozen.judge, projects: canonical, lines: frozen.judge.lines.map(line => ({ ...line, projectName: names.get(line.projectCode) ?? line.projectName })) } };
}
