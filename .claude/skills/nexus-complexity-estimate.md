---
name: nexus-complexity-estimate
description: Use when receiving a task, before planning or spawning workers. Assesses task size to pick the right execution strategy.
---

# Nexus Complexity Estimate

Before planning or spawning, assess the task dimensions:

## Assess Dimensions
1. Count files affected — read the codebase to confirm, don't guess
2. Check independence — can changes be made in parallel without conflicts?
3. Gauge depth — does the task require deep understanding of coupled systems?
4. Rate risk — IPC changes, MCP protocol, build pipeline = higher risk

## Classify Strategy
5. Pick the right approach based on assessment:
   - **Solo**: 1 file, simple change — lead does it directly, no worker needed
   - **Pair**: 2-3 related files — 1 worker + lead review
   - **Team**: 4+ independent files — 2-4 parallel workers via spawn_workers
   - **Sequential**: coupled changes with ordering deps — workers in sequence, each reading prior output

## Hidden Complexity Check
6. Watch for these complexity multipliers:
   - Cross-process communication (IPC, named pipes, MCP stdio)
   - Build pipeline changes (esbuild config, electron-builder)
   - State shared across sessions (scratchpad, message-bus)
   - Preload bridge changes (require renderer + main + preload)

## Communicate
7. State your assessment to the user before proceeding
8. Defer to user judgment if they disagree with classification
