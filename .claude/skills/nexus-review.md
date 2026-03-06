---
name: nexus-review
description: Use when reviewing and integrating work from multiple Nexus workers before committing.
---

# Nexus Review & Integration Skill

After workers complete their tasks:

## Review Checklist
1. list_worktrees — see what each worker changed
2. For each worktree with changes:
   - Check the diff (get_worker_diff)
   - Verify it matches the assigned task
   - Look for unintended side effects
3. Identify overlapping file changes across workers

## Integration Order
4. Merge non-conflicting workers first (merge_worker with squash strategy)
5. For conflicting workers: merge one, then cherry-pick the other
6. If auto-merge fails: use resolve_conflicts or manual edit
7. Run `npm run bundle` after each merge to catch breakage early

## Final Verification
8. Build passes: `npm run bundle`
9. No stale file locks: list_locks
10. Git status is clean (except intentional uncommitted changes)
11. Report integration summary to user
