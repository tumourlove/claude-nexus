---
name: nexus-conflict-resolution
description: Use when multiple workers have edited the same files and merge conflicts occur.
---

# Nexus Conflict Resolution Skill

When merging workers produces conflicts:

## Assess
1. list_worktrees to see which workers changed which files
2. Identify the overlapping files
3. get_worker_diff for each conflicting worker to understand their changes

## Strategy Selection
- **Non-overlapping changes**: Cherry-pick in order, auto-merge usually works
- **Additive changes** (both add to same file): Merge first, cherry-pick second, manual fixup
- **Conflicting changes** (both modify same lines): Spawn an Integrator worker

## Integrator Pattern
4. Spawn a worker with template 'implementer' and prompt:
   - "Read the diffs from [worker-A] and [worker-B] worktrees"
   - "Both modified [file]. Integrate both sets of changes on the main branch"
   - "Verify with npm run bundle"
5. The integrator reads both worktrees and writes the merged result
6. Verify build after integration

## Nuclear Option
If all else fails:
7. git stash all current changes
8. Apply each worker's changes file-by-file using the Read tool
9. Manual integration, one file at a time
10. Run npm run bundle after each file
