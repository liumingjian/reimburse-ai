## Agent skills

### Issue tracker

Issues are tracked in this repository's GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label names. See `docs/agents/triage-labels.md`.

### Private corpus

Parser accuracy on real materials is gated by `pnpm test:private` against a corpus that lives only on the maintainer's
machine. See `docs/agents/private-corpus.md`.

### Domain docs

This repo uses the single-context domain documentation layout. See `docs/agents/domain.md`.

Product direction: `docs/design/standalone-app.md` (local reimbursement app, 本地报销应用) is the authority and overrides the Agent-driven Skill design. Skill-era ADRs and design docs carry a status line at the top naming what is superseded; read it before relying on the body.
