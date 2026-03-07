---
name: nexus-user-comms
description: Use when running multi-worker operations, any operation taking >30 seconds, or when plans change. Keeps the user informed throughout orchestration.
---

# Nexus User Communications

Keep the user informed during long operations:

## At Start
1. Announce the plan concisely — what you're doing, how many workers, expected scope
2. Use stream_progress to show status on the dashboard

## During Execution
3. Report milestones: workers spawned, first results arriving, integration starting
4. Use stream_progress(percent=N) to update dashboard progress
5. On plan changes, explain immediately — don't surprise the user after the fact

## On Blockers
6. Ask the user before spending more than 1 retry cycle on a failure
7. Present options, not just problems — "Worker failed because X. I can retry with Y or take approach Z."

## At Completion
8. Summarize: what changed, which files, any caveats or follow-ups needed
9. NEVER say "almost done" unless you have verified the work is actually near-complete

## Calibration
10. Match detail level to user responsiveness — brief updates for engaged users, fuller context if they've been away
