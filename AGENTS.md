## Agent skills

### Browser usage

For browser interactions during project development, bug diagnosis and fixes, information or UI improvements, and automated QA, agents must use the `ego-browser` skill in an isolated task space. Read the installed `ego-browser` skill before operating the browser.

This rule is the standing selection of ego for these tasks; no per-task browser confirmation is needed. For baox automated QA, follow `.agents/skills/baox/references/browser.md` to configure the QA adapter.

Normal reimbursement pages intended for user interaction and user-performed manual QA use the user's system default browser. When preparing manual QA, provide the URL and verification steps for that browser. Browser selection does not replace business confirmations or the ego-browser control handoff protocol.

### Issue tracker

Issues are tracked in this repository's GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label names. See `docs/agents/triage-labels.md`.

### Domain docs

This repo uses the single-context domain documentation layout. See `docs/agents/domain.md`.
