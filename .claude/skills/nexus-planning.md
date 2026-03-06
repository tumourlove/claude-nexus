---
name: nexus-planning
description: Use when starting a new multi-step task. Guides task decomposition, dependency mapping, and worker allocation.
---

# Nexus Planning Skill

Before spawning any workers, plan the work:

## Understand
1. Read relevant files to grasp the scope
2. Identify all files that need to change
3. Map dependencies between changes

## Decompose
4. Break into independent subtasks (max 5 workers)
5. Each subtask should:
   - Have ONE clear objective
   - Touch a distinct set of files (minimize overlap)
   - Be completable in a single session
6. If tasks MUST share files, sequence them or use an integrator

## Plan Document
7. Write plan to scratchpad: scratchpad_set(key: 'plan', value: ...)
8. Include:
   - Task list with IDs
   - File assignments per task
   - Dependency order
   - Integration strategy

## Execute
9. Spawn workers in dependency order (independent tasks first)
10. Use wait_for_workers to block until results arrive
11. Integrate results per the nexus-review skill
12. Clean up per the nexus-cleanup skill
