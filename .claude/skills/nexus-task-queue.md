---
name: nexus-task-queue
description: Use when distributing 5+ independent tasks, handling dependency chains, or when task count is dynamic. Pull-model work distribution via the task queue.
---

# Nexus Task Queue Skill

Use the task queue when workers should pull tasks dynamically rather than being assigned one task each at spawn time.

## When to Use Push vs Pull

1. **Push model** (spawn_workers with specific prompts): <5 tasks, all known upfront, no dependencies
2. **Pull model** (task queue): 5+ tasks, tasks discovered during work, dependency chains, or variable worker count

## Setting Up the Queue

3. load_toolpack('tasks') in the lead session
4. Push tasks with push_task — include priority (higher = first), dependencies (list of task IDs), and a clear actionable description
5. For dependency chains: push parent tasks first, then children with `dependencies: [parentId]`

## Spawning Generic Workers

6. Spawn workers with a generic prompt: "load_toolpack('tasks'), then loop: pull_task -> execute -> update_task(status:'done', result:...) -> repeat until no tasks remain"
7. Workers call pull_task to atomically claim the next available highest-priority task
8. Workers call update_task with status 'done' or 'failed' plus result data
9. If a task has unmet dependencies, pull_task skips it automatically

## Monitoring

10. Lead calls list_tasks periodically to check progress counts
11. If a task is stuck in 'in-progress' too long, check the assigned worker with get_session_status
12. Failed tasks can be re-queued by updating status back to 'pending'
