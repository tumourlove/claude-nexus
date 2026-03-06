---
name: nexus-cleanup
description: Use when wrapping up a task or when the workspace has accumulated many finished workers. Guides systematic cleanup of done sessions, stale locks, and worktrees.
---

# Nexus Cleanup Skill

After tasks complete, clean up to keep the workspace manageable:

## Session Cleanup
1. Use close_all_done to bulk-close finished workers
2. Check list_sessions for any stuck workers — reset_session or close them
3. Release any stale file locks: list_locks, then release_file for dead sessions

## Worktree Cleanup
4. list_worktrees — check for worktrees from closed sessions
5. merge_worker any unmerged worktrees with good work
6. Stale worktrees from crashed sessions get cleaned on next close

## State Cleanup
7. scratchpad_list — remove stale keys from finished tasks
8. Clear completed tasks from the task queue if using it

## Pre-Commit
9. Run `npm run bundle` to verify build
10. Check git status for any unintended changes
11. Report summary to user
