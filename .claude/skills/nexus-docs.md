---
name: nexus-docs
description: Use when user asks for documentation, or lead identifies stale docs after large changes. Parallel documentation generation across modules.
---

# Nexus Documentation Generation

Generate comprehensive docs in parallel without auto-committing:

## Plan Structure
1. Decide what sections the docs need (API, architecture, usage, etc.)
2. Save doc plan to scratchpad_set(key: "doc-plan") with template and tone guidelines

## Research Phase
3. Use spawn_workers — one reader worker per module/directory
4. Each reader reports: exports, key functions, data flow, dependencies, notable patterns
5. Call wait_for_workers to collect all reader findings
6. Save consolidated findings to scratchpad_set(key: "doc-findings")

## Writing Phase
7. Define a template + tone guide (formal, casual, tutorial-style, etc.)
8. Use spawn_workers — one writer worker per doc section
9. Each writer gets: their section assignment, relevant reader findings, the template
10. Writers report_result with their completed section content

## Assembly
11. Call wait_for_workers to collect all written sections
12. Spawn one integrator worker to assemble, deduplicate, and add cross-references
13. Wait for integrator result

## Delivery
14. NEVER auto-commit docs — present the full output to the user for review
15. User approves before any file writes or commits
