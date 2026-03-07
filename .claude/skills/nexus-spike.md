---
name: nexus-spike
description: Use when exploring multiple solution approaches in parallel. Trigger on words like explore, prototype, spike, or when the best approach is unclear.
---

# Nexus Parallel Spike

Prototype 2-3 candidate approaches simultaneously, compare results, pick a winner.

## Define the Problem
1. Write a clear problem statement with success criteria
2. Identify 2-3 candidate approaches (max 3 — more adds noise, not signal)
3. Define evaluation criteria: complexity, LOC, performance, maintainability

## Spawn Prototype Workers
4. Use spawn_workers — one worker per approach
5. Each worker prompt includes: the approach to try, success criteria, and a time-box scope
6. Workers must NOT commit or modify shared files — prototype in isolation
7. Workers report_result with: working/not-working, pros, cons, LOC estimate, blockers hit

## Compare and Decide
8. Call wait_for_workers(count=N) to collect all results
9. Compare approaches side-by-side against evaluation criteria
10. Pick the winner — document WHY in scratchpad_set(key: "spike-decision")
11. Discard losing approaches (delete prototype files if any)

## Implement Winner
12. Spawn an implementation worker with: winning approach + lessons learned from losers
13. Implementation worker builds the real version, not a prototype
14. Verify with `npm run bundle` or relevant build/test command
