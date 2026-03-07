---
name: nexus-bug-sweep
description: Use when a bug is found and suspected to be a pattern, or user says 'find all bugs like X'. Systematic parallel codebase audit for a class of bugs.
---

# Nexus Bug Sweep

When a bug looks like it could be a pattern, sweep the codebase systematically:

## Define the Pattern
1. Write a clear bug pattern: what to find, what the fix looks like, good vs bad example
2. Save to scratchpad_set(key: "bug-pattern") so all workers reference the same definition
3. Partition the codebase into non-overlapping module groups (e.g., by directory)

## Audit Phase
4. Use spawn_workers — one audit worker per module partition
5. Each worker prompt must include the bug pattern and their assigned files
6. Workers report_result with findings: file:line, description, severity (critical/moderate/low)
7. Call wait_for_workers to collect all audit results

## Triage
8. Lead reviews all findings, deduplicates, groups into non-overlapping fix batches
9. Save fix plan to scratchpad_set(key: "fix-plan")

## Fix Phase
10. Use spawn_workers — one fix worker per batch (no file overlaps between workers)
11. Each worker gets their exact file list and the fix pattern
12. Call wait_for_workers to collect fix results

## Verify
13. Rebuild: `npm run bundle` (or project-appropriate build command)
14. Run tests if available
15. Spawn one re-audit worker using the original bug pattern — must find zero matches
16. Write the pattern to knowledge base (scratchpad_set) for future reference
