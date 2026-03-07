---
name: nexus-retrospective
description: Use when a multi-worker task is fully integrated and committed. Captures lessons learned for future orchestration improvement.
---

# Nexus Retrospective

After a multi-worker task is complete and committed:

## Review Execution
1. How many workers were spawned? How many succeeded first try?
2. Were any retries needed? What caused them?
3. Did any worker take significantly longer than others? (indicates bad decomposition)

## Identify Wins
4. What worked well? Capture as a reusable pattern.
5. Were prompts clear enough on first try? Save effective prompt templates.

## Identify Failures
6. What failed? Capture the failure mode and the fix applied.
7. Were there merge conflicts? (indicates bad file assignment in the plan)
8. Did workers duplicate effort? (indicates overlapping scope)

## Write to Memory
9. Update memory files with concise lessons — 3-5 bullets per task:
   - Date + task summary
   - What worked (patterns to repeat)
   - What failed (anti-patterns to avoid)
   - Strategy classification that was used and whether it was correct

## Keep It Brief
10. Memory entries should be actionable, not narrative. Future you needs patterns, not stories.
