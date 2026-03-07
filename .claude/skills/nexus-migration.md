---
name: nexus-migration
description: Use when upgrading dependencies, replacing libraries, or migrating patterns across the codebase. Ensures single-source-of-truth spec and verified integration.
---

# Nexus Systematic Migration

Coordinate dependency upgrades or pattern migrations with a shared spec and partitioned workers.

## Audit Current State
1. Spawn a researcher worker to audit current usage: imports, API calls, config references
2. Researcher reports_result with a complete inventory of what needs to change
3. Identify breaking changes, edge cases, and order-dependent modifications

## Write Migration Spec
4. Write the full migration spec to scratchpad_set(key: "migration-spec")
5. Spec includes: old pattern -> new pattern mappings, edge case handling, order constraints
6. This is the SINGLE SOURCE OF TRUTH — all workers read from this key

## Partition and Migrate
7. Partition files into non-overlapping sets (same rules as refactoring)
8. For breaking changes that require sequential order: spawn workers ONE AT A TIME
9. Use spawn_workers for independent file sets
10. Each worker prompt includes: scratchpad key to read spec from, assigned file list
11. Workers apply migration + verify their files compile/work, then report_result

## Integration Verification
12. Spawn an integration worker that runs: `npm run bundle` + full test suite
13. If failures: spawn targeted fix workers with error context
14. For dependency upgrades: verify package.json and lock file are consistent
15. Final verification worker confirms clean build and all tests pass
