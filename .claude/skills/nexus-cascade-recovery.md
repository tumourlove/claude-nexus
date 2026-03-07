---
name: nexus-cascade-recovery
description: Use when 2+ workers fail, wait_for_workers times out, or workers produce incompatible outputs. Guides recovery from multi-worker failures.
---

# Nexus Cascade Recovery

When multiple workers fail, do NOT immediately respawn:

## Stop and Assess
1. STOP — do not spawn new workers yet
2. Use list_sessions and get_session_status to survey the damage
3. Triage each failure: independent / caused by another worker / caused by bad planning

## Root Cause Analysis
4. If failures are independent: each can be retried individually
5. If one worker caused another to fail: fix the root cause first
6. If bad planning caused failures: revise the plan BEFORE respawning

## Salvage Check
7. Check read_messages and scratchpad for partial work still usable
8. Workers may have completed 80% before failing — don't discard that work

## Communicate to User
9. Report clearly: "X of Y workers failed. Root cause: [cause]. Salvageable work: [list]. Recommended approach: [plan]."
10. Wait for user acknowledgment before respawning if >50% failed

## Re-Plan
11. Apply lessons from failures to the new plan
12. If >50% failed, consider a fundamentally different approach
13. Close failed sessions with close_session before respawning
