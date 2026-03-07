---
name: nexus-testing
description: Use when running or writing tests across multiple modules in parallel. Ensures test isolation, failure triage, and verified green status before completion.
---

# Nexus Parallel Testing

Coordinate test execution across modules using workers. Never mark tests as passing without verification.

## Identify Scope
1. Determine test boundaries — by module, file, or test type (unit/integration/e2e)
2. List all test targets and group into independent scopes (no shared state between groups)

## Spawn Test Workers
3. Use spawn_workers — one worker per test scope
4. Separate concerns: test-writing workers vs test-running workers (don't mix)
5. Each worker prompt includes: exact files to test, test command, expected output format
6. Workers report_result with pass/fail counts and full error output for failures

## Collect Results
7. Call wait_for_workers(count=N) — one blocking call, no polling
8. Aggregate pass/fail across all workers into a summary

## Triage Failures
9. For each failing test: spawn a fix worker with the error message, file path, and test name
10. Fix workers report_result with the patch applied and re-run confirmation
11. NEVER assume a fix worked — always re-run the test

## Final Verification
12. Spawn a single verification worker that runs the full test suite
13. Verification worker reports complete pass/fail output
14. Only report success after verification worker confirms all green
