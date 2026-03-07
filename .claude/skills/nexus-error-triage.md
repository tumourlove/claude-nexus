---
name: nexus-error-triage
description: Use when a worker reports an error or failure. Classifies the error type and determines the correct recovery strategy.
---

# Nexus Error Triage

When a worker fails, classify before retrying:

## Classify Error Type
1. **Transient**: timeout, connection issue — retry once with same prompt
2. **Prompt misunderstanding**: worker did the wrong thing — rewrite prompt more specifically, retry
3. **Missing context**: worker couldn't find files or lacked info — add exact file paths or scratchpad data, retry
4. **Build/type error**: code doesn't compile — spawn new worker with EXACT error message (not a summary)
5. **Fundamental**: wrong approach entirely — STOP, re-plan, consult user
6. **Resource exhaustion**: worker hit context limit — use report_handoff, spawn continuation worker

## Recovery Rules
7. Never retry more than 2x with the same strategy — escalate or change approach
8. For build errors, always include the EXACT error output, not a paraphrase
9. For prompt misunderstandings, identify which part was ambiguous and add constraints

## Tracking
10. Log error type and resolution to scratchpad_set(key: "error-log-{task}")
11. If same error type recurs across tasks, flag it as a systemic issue to the user
