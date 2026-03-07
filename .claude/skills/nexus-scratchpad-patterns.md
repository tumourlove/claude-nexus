---
name: nexus-scratchpad-patterns
description: Use when workers need shared state, concurrent updates, coordination flags, or mutex-like synchronization. Advanced scratchpad coordination patterns.
---

# Nexus Scratchpad Patterns Skill

Coordinate workers through shared state using the scratchpad key-value store.

## Namespace Convention

1. Prefix keys with task/feature name: `auth/status`, `auth/counter`, `refactor/phase`
2. Use consistent naming: `{feature}/{purpose}` — never bare keys in multi-task work

## Shared Counters (Atomic Increment)

3. Read current value with scratchpad_get(key)
4. Increment locally, then write with scratchpad_cas(key, expected=oldValue, value=newValue)
5. If CAS fails (another worker updated first): re-read and retry
6. Use for: completed task counts, progress tracking, sequential numbering

## Coordination Flags (Phase Gates)

7. Lead sets phase: scratchpad_set(key: "feature/phase", value: "planning")
8. Workers poll scratchpad_get("feature/phase") before starting phase-dependent work
9. Lead advances: scratchpad_set(key: "feature/phase", value: "implementing")
10. Pattern: planning -> implementing -> reviewing -> done

## Mutex via CAS

11. Acquire: scratchpad_cas(key: "feature/lock", expected: null, value: sessionId)
12. If CAS succeeds: lock acquired, proceed with critical section
13. Release: scratchpad_delete(key: "feature/lock")
14. If CAS fails: another session holds the lock, wait and retry

## Batch Operations

15. Use batch_scratchpad to read/write multiple keys atomically
16. Useful for setting up initial state or reading full feature namespace at once

## Cleanup

17. When task completes: scratchpad_delete all keys in the feature namespace
18. Lead should verify cleanup with scratchpad_list after all workers finish
