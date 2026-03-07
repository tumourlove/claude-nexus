---
name: nexus-refactoring
description: Use when performing cross-file refactors like renames, API changes, or pattern migrations. Ensures no file conflicts and verified zero residual references.
---

# Nexus Coordinated Refactoring

Safely execute large refactors across many files using partitioned workers.

## Research Phase
1. Spawn a researcher worker to grep all usages of the target pattern/symbol
2. Researcher reports_result with a complete file:line list of every occurrence
3. Review the list — understand the full blast radius before changing anything

## Partition Work
4. Group files into non-overlapping sets (NO two workers touch the same file)
5. Write the transformation spec to scratchpad_set(key: "refactor-spec") — old pattern, new pattern, edge cases
6. Keep sets small enough that each worker has a focused, verifiable task

## Spawn Refactor Workers
7. Use spawn_workers — one per file set
8. Each worker prompt includes: exact file list, transformation spec, instruction to ONLY touch assigned files
9. Workers report_result with list of changes made per file

## Verify Zero Residuals
10. Spawn a verification worker that runs: `npm run bundle` + grep for the old pattern
11. Old pattern grep must return zero results — any hits mean missed references
12. If misses found: spawn targeted fix workers for remaining files
13. Final build verification: `npm run bundle` must succeed with no errors
