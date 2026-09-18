import { createHash } from 'node:crypto';
import { PROJECT_ASSIGNMENT_ERRORS, type Line, type ProjectAssignment, type ProjectUsage } from '@baox/contract';
import type { BookOption } from './books';

// 项目归属 (project assignment) as a pure fold over its facts: `assign-project-lines` edits the working draft,
// `submit-project-assignment` stores the selection, pinning code + name + source per line (ADR-0018). A submission
// stands on the candidate lines it was made for (kernel selection.mjs `linesDigest`): when the lines change it goes
// stale and the task returns to assignment, keeping the draft for lines that still exist.
// A draft line whose project stopped being selectable before submission (removed from the personal book, deactivated in
// the public book) leaves the draft and is listed under `reselect`; only the standing submission's pin may be kept.

export type PinnedProject = BookOption;

export type AssignFact = { kind: 'assign'; revision: number; lineIds: readonly string[]; project: PinnedProject; onlyUnassigned: boolean };
export type SubmitFact = { kind: 'submit'; revision: number; purpose: string; selection: Readonly<Record<string, PinnedProject>>; linesDigest: string; catalogHash: string; submittedAt: string };
export type AssignmentFact = AssignFact | SubmitFact;

// Kernel linesDigest: what a project choice is made for. Excluding, re-allocating or replacing a voucher changes it.
export function linesDigest(lines: readonly Line[]): string {
  const shape = lines.map((line) => [line.lineId, line.voucherMaterialId, line.date, line.endDate ?? '', line.city ?? '', line.grossAmount].join('|'));
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 32);
}

export type Assignment = {
  view: ProjectAssignment;
  // The submission that still stands on the current lines, if any.
  submitted: SubmitFact | null;
  working: ReadonlyMap<string, PinnedProject>;
};

const cents = (amount: string) => Math.round(Number(amount) * 100);
const yuan = (value: number) => (value / 100).toFixed(2);

export function assignmentOf(lines: readonly Line[], facts: readonly AssignmentFact[], options: readonly BookOption[], homeCity: string, entered: boolean): Assignment {
  const ordered = [...facts].sort((a, b) => a.revision - b.revision);
  const working = new Map<string, PinnedProject>();
  for (const fact of ordered) {
    if (fact.kind === 'submit') {
      working.clear();
      for (const [lineId, project] of Object.entries(fact.selection)) working.set(lineId, project);
      continue;
    }
    for (const lineId of fact.lineIds) if (!(fact.onlyUnassigned && working.has(lineId))) working.set(lineId, fact.project);
  }
  const digest = linesDigest(lines);
  const last = [...ordered].reverse().find((fact): fact is SubmitFact => fact.kind === 'submit') ?? null;
  const submitted = last && last.linesDigest === digest ? last : null;
  const selectable = new Set(options.map((option) => option.number));
  const dropped = new Map<string, PinnedProject>();
  for (const [lineId, project] of working) {
    if (selectable.has(project.number) || submitted?.selection[lineId]?.number === project.number) continue;
    dropped.set(lineId, project);
    working.delete(lineId);
  }

  const inLineOrder = (source: ReadonlyMap<string, PinnedProject>) =>
    lines.flatMap((line) => {
      const project = source.get(line.lineId);
      return project ? [{ lineId: line.lineId, projectNumber: project.number, projectName: project.name, projectSource: project.source }] : [];
    });
  const usage = new Map<string, ProjectUsage & { cents: number }>();
  for (const line of lines) {
    const project = working.get(line.lineId);
    if (!project) continue;
    const entry = usage.get(project.number) ?? { number: project.number, name: project.name, lineCount: 0, grossTotal: '0.00', selectable: selectable.has(project.number), cents: 0 };
    entry.lineCount += 1;
    entry.cents += cents(line.grossAmount);
    usage.set(project.number, entry);
  }

  return {
    submitted,
    working,
    view: {
      status: submitted ? 'submitted' : entered ? 'pending' : 'not_started',
      purpose: submitted?.purpose ?? last?.purpose ?? null,
      homeCity,
      assignments: submitted ? inLineOrder(new Map(Object.entries(submitted.selection))) : [],
      working: inLineOrder(working),
      reselect: inLineOrder(dropped),
      usage: [...usage.values()].map(({ cents: total, ...entry }) => ({ ...entry, grossTotal: yuan(total) })),
      projects: options.map((option) => ({ number: option.number, name: option.name, source: option.source })),
      submittedAt: submitted?.submittedAt ?? null,
    },
  };
}

type Refusal = { code: string; message: string };

// 归入: new lines may only go to a currently selectable project.
export function checkAssign(lines: readonly Line[], lineIds: readonly string[], number: string, options: readonly BookOption[]): PinnedProject | Refusal {
  const known = new Set(lines.map((line) => line.lineId));
  const unknown = lineIds.find((lineId) => !known.has(lineId));
  if (unknown) return { code: 'unknown_line', message: PROJECT_ASSIGNMENT_ERRORS.unknownLine(unknown) };
  return options.find((option) => option.number === number) ?? { code: 'project_not_selectable', message: PROJECT_ASSIGNMENT_ERRORS.projectNotSelectable(number) };
}

// Submit: every line needs a project, and each project must be selectable now, or be the very project the standing
// submission already pinned on that line (kernel `canKeepPrevious`): a later book edit neither breaks nor changes it.
export function checkSubmit(lines: readonly Line[], projects: Readonly<Record<string, string>>, options: readonly BookOption[], standing: SubmitFact | null): { selection: Record<string, PinnedProject> } | Refusal {
  const known = new Set(lines.map((line) => line.lineId));
  const unknown = Object.keys(projects).find((lineId) => !known.has(lineId));
  if (unknown) return { code: 'unknown_line', message: PROJECT_ASSIGNMENT_ERRORS.unknownLine(unknown) };
  const missing = lines.find((line) => !projects[line.lineId]?.trim());
  if (missing) return { code: 'incomplete', message: PROJECT_ASSIGNMENT_ERRORS.lineUnassigned(missing.no) };
  const selection: Record<string, PinnedProject> = {};
  for (const line of lines) {
    const number = (projects[line.lineId] ?? '').trim();
    const kept = standing?.selection[line.lineId];
    const pinned = options.find((option) => option.number === number) ?? (kept?.number === number ? kept : undefined);
    if (!pinned) return { code: 'project_not_allowed', message: PROJECT_ASSIGNMENT_ERRORS.projectNotAllowed(line.no, number) };
    // A kept project keeps its pinned name and source even when the book now says otherwise.
    selection[line.lineId] = kept?.number === number ? kept : pinned;
  }
  return { selection };
}
