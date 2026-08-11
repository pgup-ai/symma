---
name: symma-de-slop
description: Run a deletion-biased cleanup pass on symma changes. Use when asked to de-slop a diff, remove AI-generated-looking code, reduce over-engineering, or run a hostile self-review before pushing, opening, or updating a PR.
---

# symma-de-slop

Use this skill with a hostile review mindset after implementation and before final validation. Keep only code, tests, docs, and configuration that earn their place.

## Workflow

1. Inspect the exact diff: `git status --short --branch`, `git diff --stat`, `git diff --check`, `git diff -- <changed paths>`, and every untracked file. When commits exist, also inspect `git diff origin/main...HEAD`.
2. Review only branch changes. Preserve unrelated user work.
3. Adjudicate comments block by block; a diff-wide "comments look fine" is not a verdict:
   - Enumerate every added or modified comment block first. Starting point: `git diff -U0 -- '*.ts' | grep -nE '^[+-][[:space:]]*(//|/\*|\*)'`; the unit of judgment is each match's full enclosing block in the file, not the diff fragment.
   - Record one verdict per block: `cut` (the default), `rewrite` (true rationale at excess length — compress to the one or two lines stating what the code cannot say), or `keep` (concise and non-obvious). "It explains intent" justifies content, never length.
   - Restating what the code does, narrating what the old code did, or describing sibling code paths never justifies a keep.
4. Adjudicate added test cases the same way; coverage is never a keep reason (body edits inside existing cases get ordinary diff review, not the cut default):
   - Enumerate them first. Starting point: `git diff -U0 -- '*.test.ts' | grep -nE '^[+-][[:space:]]*(it|test)(\.[a-zA-Z]+)*(<.*>)?\('`. Matches on `-` lines are removals or renames — check them against step 7, do not verdict them as new cases.
   - Record one verdict per case: `cut` (the default), `fold` (assertions worth keeping that belong in an existing case), or `keep`.
   - A case earns `keep` only by naming the failure it alone would catch; a case whose failure always accompanies a sibling's failure is duplicate.
5. Bias hard toward deletion. Flag and fix:
   - one-use helpers, wrappers, types, options, or files that do not reduce real complexity
   - duplicate validation, impossible-state guards, rethrow-only catches, and speculative fallbacks
   - assertions weakened or deleted inside existing tests to make a change pass; the fix is restoring them unless the PR states the behavior change that invalidates them
   - scope creep, repeated docs/config text, and unused exports
   - duplicated logic where an existing package primitive already fits; search with `rg` before keeping new logic
6. Keep additions only when they fix requested behavior, preserve an existing contract, cover a real regression, or document a concrete operational constraint.
7. If deleting something might change product behavior or remove required evidence, flag it instead of guessing.
8. Rerun scoped validation (`npm run format:check`, `npm run lint`, and a focused `node --conditions=symma-source --import tsx --test packages/<pkg>/test/<file>.test.ts`) and inspect the updated diff again.

## Report

For each meaningful finding, report the file and issue, why it is slop, and Applied / Not applied with a concise reason. Finish with:

```text
Cut: <removed or simplified surface>
Comments: <blocks adjudicated> — <kept> kept, <rewritten> rewritten, <cut> cut
Tests: <cases adjudicated> — <kept> kept, <folded> folded, <cut> cut
Net line delta: <additions>/<deletions> from `git diff --numstat`
Validation: <commands run>
Residual risk: <none or concrete gap>
```

If no issues remain, say that directly, still report the adjudication counts, and list the validation run.
