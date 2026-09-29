# Merge conditions

A branch merges to `main`, or into a spec's integration branch, only when every condition below holds. The one
running the merge (implementer, merger subagent, or maintainer) checks them; a PR description states the result.

## e2e green on main

`main`'s Playwright suite (both the `mock` and `server` projects) is green, so any red e2e run means the change under
test broke it: there is no baseline to diff against. A merge keeps it that way.

- Run the full suite on the Mac through `rexec`: `pnpm test:e2e` from the repo root. It builds everything first.
- The merge is allowed only on a run of the merge result (the branch rebased on or merged with its target) that
  ends with every test passed.
- When a spec is red because behaviour changed on purpose, update its assertions to the behaviour the governing
  ADR now defines, in the same change. A skipped, `fixme`'d or deleted spec is a red spec.
- When `main` itself is found red, fixing it is the next change to land, before anything else merges.
