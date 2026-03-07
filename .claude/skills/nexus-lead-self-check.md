---
name: nexus-lead-self-check
description: Use when orchestrating — periodically during operations, after spawning workers, after receiving results, or when context usage exceeds 60%.
---

# Nexus Lead Self-Check

Periodic self-diagnostic for lead sessions during orchestration:

## Delegation Check
1. Am I doing implementation work I should delegate to a worker?
2. Lead's job: plan, spawn, review, integrate. NOT write large code blocks.

## Efficiency Check
3. Am I using wait_for_workers (one blocking call) instead of polling with get_session_status?
4. Are there idle/done sessions I should clean up? Run list_sessions, close stale ones with close_session.

## Context Health
5. Run context_estimate — am I above 60%?
6. If >70%: consider report_handoff to prepare for session continuation
7. If >80%: actively trim — stop reading large files, delegate remaining work

## Plan Alignment
8. Re-read scratchpad_get(key: "plan") — have I drifted from the plan?
9. If drifted, either update the plan or course-correct back to it

## User Communication
10. Have I updated the user recently? If not, send a status update now.
11. Take corrective action immediately on any item that's concerning.
