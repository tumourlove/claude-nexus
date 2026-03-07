---
name: nexus-knowledge-capture
description: Use when workers discover non-obvious patterns, gotchas, or architectural decisions worth preserving. Builds shared knowledge during multi-session work.
---

# Nexus Knowledge Capture Skill

Capture and share knowledge discovered during multi-worker operations.

## Before Starting Work

1. load_toolpack('knowledge') in sessions that will capture knowledge
2. Call kb_search with relevant terms to check for existing knowledge on the topic
3. Share relevant existing knowledge with workers via scratchpad_set or send_message

## During Work — Workers

4. Instruct workers: "When you discover a gotcha, pattern, or non-obvious decision, call kb_add immediately"
5. For code patterns: kb_add with category 'pattern' and include the file path + context
6. For gotchas/bugs: kb_add with category 'gotcha' and include what went wrong + the fix
7. For architectural decisions: use kg_add_entity for the component + kg_add_relationship for connections

## Building the Knowledge Graph

8. Use kg_add_entity for major components, services, or modules discovered
9. Use kg_add_relationship to map dependencies and data flows between entities
10. This builds a navigable architecture map for future sessions

## After Work — Lead

11. Call kg_export to review all captured knowledge and relationships
12. Curate high-value discoveries into CLAUDE.md or memory files for persistence
13. Delete low-value or session-specific entries to keep the knowledge base clean
14. Share key findings with the user for validation before persisting
