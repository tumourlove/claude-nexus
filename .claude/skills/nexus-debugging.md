---
name: nexus-debugging
description: Use when debugging issues across multiple Nexus sessions or when workers report failures.
---

# Nexus Debugging Skill

When a worker fails or something goes wrong:

## Diagnosis
1. Check get_session_status for the failing worker
2. Use read_session_history to see what went wrong
3. Search across sessions with search_across_sessions for error patterns
4. Check list_locks — file locks from dead sessions can block workers

## Common Issues
- **Worker stuck**: reset_session, then respawn with clearer prompt
- **File conflicts**: list_locks, release_file for stale locks, then retry
- **Build failures**: Have a worker run `npm run bundle` and report errors
- **Merge conflicts**: Use resolve_conflicts or spawn integrator worker
- **Ghost tabs**: Worker crashed — close tab and respawn

## Recovery
5. If worker is salvageable: send_message with guidance
6. If worker is lost: reset_session and respawn with adjusted prompt
7. Never retry the exact same prompt — always add context about what failed
8. After recovery: verify with `npm run bundle`
