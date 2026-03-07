---
name: nexus-release-coordination
description: Use when user says release, ship it, or wants to publish a new version. Full release pipeline with mandatory build gates.
---

# Nexus Release Coordination

Coordinate a release with parallel workers and mandatory gates:

## Pre-Flight
1. Spawn a pre-flight worker: verify git clean, tests pass, `npm run bundle` succeeds
2. Call wait_for_workers — if pre-flight fails, STOP and report issues to user

## Changelog
3. Spawn a changelog worker: read `git log` since last tag, categorize commits (feat/fix/chore), draft release notes
4. Wait for changelog result, present draft to user
5. Lead confirms: version bump type (major/minor/patch) and changelog text

## Version + Tag
6. Spawn a version worker: update package.json version, commit, create git tag
7. Wait for result — verify commit and tag were created correctly

## Build (MANDATORY — NEVER SKIP)
8. Spawn a build worker: run `npm run build`, verify artifacts exist:
   - `release/Claude-Corroboree-Setup-X.Y.Z.exe`
   - `release/Claude-Corroboree-Setup-X.Y.Z.exe.blockmap`
   - `release/latest.yml`
9. Call wait_for_workers — if build fails, STOP

## GATE: User Approval
10. Present build summary to user — they MUST approve before publish
11. Do NOT proceed without explicit user confirmation

## Publish
12. Spawn a publish worker: `git push origin master --tags`, then `gh release create` with ALL built assets
13. Spawn a verify worker: `gh release view` to confirm all assets uploaded
14. Call wait_for_workers — report final status to user
