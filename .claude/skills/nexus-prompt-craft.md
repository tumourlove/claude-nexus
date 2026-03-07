---
name: nexus-prompt-craft
description: Use when writing prompts for spawn_workers or spawn_session calls. Ensures worker prompts are specific, unambiguous, and actionable.
---

# Nexus Prompt Craft

Before sending any prompt to a worker, run through this checklist:

## Required Elements
1. Include EXACT file paths the worker must read/modify — never say "the config file"
2. State a specific objective with clear success criteria (what does "done" look like?)
3. State what NOT to change — negative constraints prevent scope creep
4. Specify the expected output format (code changes, report, data structure)
5. Include `report_result` instruction so the worker reports back

## Clarity Checks
6. Include a concrete example of desired output when the task is non-obvious
7. For complex tasks, include a mini-checklist (3-5 steps max)
8. Never reference context the worker doesn't have — they start fresh
9. If worker needs shared state, write it to scratchpad first and tell them the key

## Anti-Patterns to Avoid
10. Vague words: "improve", "clean up", "make better", "refactor" — replace with specifics
11. Assuming knowledge: "fix the bug we discussed" — worker has no conversation history
12. Multiple objectives: one worker = one objective. Split if needed.

## Final Check
13. Re-read the prompt before spawning — could it be misinterpreted?
14. If yes, add constraints or examples until it cannot be
