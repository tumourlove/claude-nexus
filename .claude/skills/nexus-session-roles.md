---
name: nexus-session-roles
description: Use when spawning workers and choosing session templates. Guides role assignment, privilege levels, and escalation for worker sessions.
---

# Nexus Session Roles Skill

Assign appropriate roles and privileges to worker sessions. Follow the principle of least privilege.

## Template Guide

1. **implementer** — Full edit + run permissions. For workers that write code, run tests, build
2. **researcher** — Read-only access. For workers investigating code, gathering context, answering questions
3. **reviewer** — Read + diff access. For workers reviewing code, checking quality, comparing changes
4. **explorer** — Minimal investigation scope. For workers doing quick, targeted lookups

## Spawning with Roles

5. Choose the most restrictive template that covers the worker's task
6. Specify template in spawn_session or spawn_workers: `template: "researcher"`
7. When unsure, start with researcher and promote if the worker needs write access

## Escalation

8. If a worker needs more permissions: worker calls request_promotion(reason)
9. Lead reviews the reason, then calls promote_session(sessionId, newTemplate)
10. Only promote for the duration needed — demote_session after sensitive work completes

## Role Patterns

11. **Research then implement**: spawn as researcher first, promote to implementer when ready to code
12. **Review gate**: spawn reviewer after implementer finishes, reviewer checks before merge
13. **Sensitive operations**: promote to implementer for the edit, immediately demote_session after

## Rules

14. Never spawn implementers for read-only tasks — it wastes trust and adds risk
15. Lead is responsible for all promotions — workers cannot self-promote
16. Log role changes via scratchpad_set for audit trail: `roles/{sessionId}: "promoted:implementer"`
