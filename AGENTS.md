## Agent skills

### Issue tracker

Issues are tracked in this repository's GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label names. See `docs/agents/triage-labels.md`.

### Testing

Inner loop: `pnpm test:changed <changed files>` after each edit. Merge gate once, before merge. Both run on the Mac.
See `docs/agents/testing.md`.

### Private corpus

Parser accuracy on real materials is gated by `pnpm test:private` against a corpus that lives only on the maintainer's
machine. See `docs/agents/private-corpus.md`.

### Coding standards

Reviewing a change (`/code-review` Standards axis) or fixing a QA-reported bug: see `docs/agents/coding-standards.md`.

### Merge conditions

Before merging any branch (to `main` or to a spec's integration branch), check it against
`docs/agents/merge-conditions.md`. It picks the gate (`docs`, `standard` or `full`); the whole e2e suite runs only
on `full`, before a deploy, or when the maintainer asks.

### Manual QA on the Mac

When the maintainer asks for QA on the Mac, launch the dev-mode instance (`qa/dev.sh` through rexec) and push each fix into it. See `qa/README.md` §1a.

### Where things run

- `10.250.0.222`: the server only (QA/POC, `/deploy-intranet`). It never drives ERP. Reach it from the Mac through
  rexec; the agent server has no route to it.
- ERP is driven from each employee's own PC, by the 本地执行器 or the browser extension (ADR-0033).
- The Mac mini is the test environment: tests, QA and ERP spikes, through rexec.

### Domain docs

This repo uses the single-context domain documentation layout. See `docs/agents/domain.md`.

Product direction: `docs/design/standalone-app.md` (local reimbursement app, 本地报销应用) is the authority and overrides the Agent-driven Skill design. Skill-era ADRs and design docs carry a status line at the top naming what is superseded; read it before relying on the body.

ERP 去报销 work (本地执行器, 暂存, 对账, install): start from `docs/design/erp-headless-v1.md` §当前状态.
