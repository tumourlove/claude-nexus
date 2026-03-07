---
name: nexus-file-coordination
description: Use when 2+ workers may edit files concurrently. Prevents file conflicts through claim-based locking and proactive file mapping.
---

# Nexus File Coordination Skill

Prevent file conflicts when multiple workers are active. NEVER edit without claiming when >1 worker is active.

## Planning Phase

1. During task decomposition, map which files each worker needs to edit
2. Assign files exclusively to workers — no two workers should edit the same file
3. If overlap is unavoidable, serialize those tasks or use an integrator worker

## Worker File Locking

4. Workers load_toolpack('files') at session start
5. Before editing any file: call claim_file(path) to acquire an exclusive lock
6. If claim_file fails: call list_locks to see who holds the lock
7. Send a message to the lock holder via send_message asking for release, or wait
8. After editing is complete: call release_file(path) to free the lock

## Read-Only Sharing

9. Use share_snippet(path, startLine, endLine) to share file contents without locking
10. Snippets are read-only — they don't create conflicts

## Lead Monitoring

11. Periodically call list_locks to see all active file claims
12. Detect stale locks: if a worker is done/idle but still holds locks, release them
13. Before integration: verify all locks are released with list_locks

## Rules

14. ONE file = ONE owner at a time. No exceptions.
15. Claim before edit, release after edit. Every time.
