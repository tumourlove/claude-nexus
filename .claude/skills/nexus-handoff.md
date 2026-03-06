---
name: nexus-handoff
description: Use when a worker is running out of context or needs to pass work to a fresh session. Ensures no work is lost during context handoffs.
---

# Nexus Handoff Skill

When a worker's context is getting full (>80%) or they report being stuck:

## Pre-Handoff
1. Check context_estimate for the session
2. Have the worker report_handoff with:
   - What was completed
   - What remains
   - Key file paths and decisions made
   - Any gotchas discovered
3. save_checkpoint before reset

## Execute Handoff
4. reset_session with preserve_summary=true
5. The new session gets the original prompt + [RESET] prefix
6. Send the handoff summary via send_message to the fresh session
7. Monitor the fresh session picks up where the old one left off

## If Handoff Fails
8. Read the old session's history: read_session_history
9. Manually extract key context and craft a new prompt
10. Spawn a completely fresh worker with the extracted context
