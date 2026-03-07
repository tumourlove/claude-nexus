---
name: nexus-monitoring
description: Use when workers are expected to run for extended periods. Provides progress tracking, stall detection, and intervention patterns.
---

# Nexus Monitoring Skill

Watch long-running multi-worker operations and intervene early when things go wrong.

## Instruct Workers to Report

1. Include in worker prompts: "call stream_progress(message, percent) every significant step"
2. Workers should stream_progress at natural milestones (file read, implementation done, tests passing)
3. Workers should send_message to lead if they hit blockers

## Passive Monitoring

4. Call read_messages periodically to check for worker progress updates and blocker reports
5. Use list_sessions to get an overview of all active worker states
6. Check context_estimate on workers approaching long tasks

## Stall Detection

7. No progress for 2+ minutes: call get_session_status to check if worker is still busy
8. If busy but silent: send_message asking for a status update
9. If idle/done but no report_result received: check read_messages for missed results

## Context Bloat Detection

10. If context_estimate shows >70% usage: send worker a message to report_handoff and wrap up
11. Spawn a fresh worker with the handoff summary to continue the task
12. Proactively instruct workers on large tasks to use report_handoff before hitting limits

## Escalation Ladder

13. **Level 1**: send_message — ask worker for status or redirect approach
14. **Level 2**: reset_session — restart a stuck worker with refined prompt
15. **Level 3**: close_session + spawn_session — full respawn with lessons learned from failure
