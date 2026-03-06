---
name: nexus-orchestration
description: Use when delegating tasks to worker sessions in Claude Nexus. Ensures proper task decomposition, worker spawning, and result coordination.
---

# Nexus Orchestration Skill

When delegating work to Nexus workers, follow this checklist:

## Pre-Spawn
1. Read relevant files to understand the scope (this is the ONE thing you do yourself)
2. Break the task into independent subtasks — each worker gets ONE clear objective
3. Identify file conflicts: if 2+ workers need the same file, either:
   - Assign one worker per file and have them coordinate
   - Spawn an integrator worker to merge after
4. Write the plan to scratchpad_set(key: "plan") so workers can reference it

## Spawning
5. Use spawn_workers (batch) instead of individual spawn_session calls
6. Give each worker:
   - A specific, actionable prompt (not vague)
   - The exact file paths they need to touch
   - The expected output format
   - Instructions to report_result when done
7. NEVER spawn more than 5 workers at once — diminishing returns

## Waiting
8. Call wait_for_workers(count=N) — ONE blocking call, no polling
9. If timeout: check get_session_status, then reset_session if stuck

## Integration
10. Review results from all workers
11. If file conflicts: spawn an integrator worker or merge manually
12. Run `npm run bundle` to verify build
13. Report summary to user
