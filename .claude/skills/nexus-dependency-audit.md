---
name: nexus-dependency-audit
description: Use when updating dependencies, checking vulnerabilities, or addressing npm audit issues. Safe parallel dependency updates with isolated testing.
---

# Nexus Dependency Audit

Safely update dependencies with parallel isolated testing:

## Research
1. Spawn a researcher worker: run `npm outdated`, `npm audit`, report categorized list
2. Wait for researcher result — get full picture before acting
3. Lead prioritizes: security fixes first, then major bumps, then minor/patch

## Safe Patches (low risk)
4. Spawn one worker to batch-update all patch/minor non-breaking deps
5. Worker runs: `npm update`, `npm run bundle`, reports any build failures
6. Call wait_for_workers for result

## Risky Updates (major versions, breaking changes)
7. Use spawn_workers — one spike worker per risky dependency
8. Each spike worker in its own worktree: update the dep, rebuild, run tests, report breakage
9. Call wait_for_workers to collect all spike results
10. For confirmed breaking changes: spawn a migration worker per dep to fix breaking APIs

## Integration
11. Merge safe patches first (already verified)
12. Merge breaking-change fixes sequentially (one at a time, rebuild between each)
13. Final full rebuild: `npm run bundle` + run all tests

## Report
14. Summarize: what was updated, what broke and how it was fixed, what was skipped and why
15. Present to user for approval before committing
