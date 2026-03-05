# Claude Nexus v0.3.0 — The Full Wishlist

**Date:** 2026-03-05
**Status:** Approved
**Scope:** 17 features across 4 phases

## Overview

A comprehensive upgrade to make Nexus sessions more reliable, smarter at coordination, better at developer workflows, and genuinely fun to watch work together. Sessions get personalities, structured task management, file locking, auto-recovery, and a chat sidebar for users to watch the collaboration unfold.

---

## Phase 1: Reliable Foundation

*Goal: Make the existing system rock-solid before adding capabilities.*

### 1.1 Session Heartbeats & Health Dashboard (Feature #3)

**MCP server** sends `heartbeat` IPC every 10s: `{ sessionId, contextUsed, lastToolCall, status }`. **IPC server** tracks last heartbeat per session — no heartbeat for 30s = `unresponsive`. **Dashboard** cards get a pulse indicator: green (healthy), yellow (slow), red (unresponsive).

Complements existing 60s stuck detection with active pinging.

**Files:** `mcp-server/index.js`, `src/ipc-server.js`, `src/dashboard.js`, `src/session-manager.js`

### 1.2 Enforced Template Permissions (Feature #8)

`TEMPLATE_TOOLS` map whitelists MCP tools per template:
- **lead**: all tools
- **implementer**: all except `spawn_session`, `reset_session`
- **researcher**: read-only tools + `scratchpad_*` + `report_result`
- **reviewer**: researcher tools + `send_message`
- **explorer**: `list_sessions`, `read_session_history`, `search_across_sessions`

MCP server reads `NEXUS_TEMPLATE` env var, wraps tool handlers with permission check. Blocked tools return clear error.

**Files:** `mcp-server/index.js`, `src/session-manager.js`

### 1.3 Auto-Retry with Backoff (Feature #15)

On crash/error: save last 200 lines + original prompt. Respawn with `[RETRY]` context. Exponential backoff: 2s, 8s, 30s. Max 3 attempts. After max retries, notify lead: `[WORKER_FAILED]`. Dashboard shows retry count.

**Files:** `src/session-manager.js`, `src/ipc-server.js`, `src/dashboard.js`

### 1.4 IPC Reconnection (Feature #16)

MCP server buffers outgoing messages when disconnected (max 100). Reconnect with backoff: 1s → 2s → 4s → 8s → max 30s. On reconnect: re-register, flush buffer. Priority retention: keep `report_result` and `heartbeat`, drop older non-critical. After 5 fails, write to stderr.

**Files:** `mcp-server/index.js`

---

## Phase 2: Smart Coordination

*Goal: Make sessions intelligent about coordinating work.*

### 2.1 Structured Task Queue (Feature #1)

New `TaskQueue` class. Tasks: `{ id, title, description, priority(1-5), status(pending/assigned/in_progress/done/failed), assignee, dependencies[], createdBy, result }`. Dependency resolution: tasks blocked until all deps done. Auto-assignment on `pull_task`.

**MCP tools:** `push_task` (lead), `pull_task` (workers), `update_task`, `list_tasks`
**Dashboard:** Task board with pending/in-progress/done columns.

**Files:** New `src/task-queue.js`, `mcp-server/index.js`, `src/ipc-server.js`, `src/dashboard.js`

### 2.2 Shared Context Snippets (Feature #2)

**MCP tool `share_snippet`:** `{ file_path, start_line, end_line, label, target_session_id? }`. Main process reads actual file lines, stores in `_snippets` namespace with short ID. Sends as formatted message to target or broadcasts.

**MCP tool `get_snippet`:** Returns snippet content fresh from disk. Auto-expire after 1 hour.

**Files:** `mcp-server/index.js`, `src/ipc-server.js`

### 2.3 Conflict-Aware File Locking (Feature #4)

Extend `ConflictDetector` with `locks` Map: `filepath -> { sessionId, timestamp, intent }`. Locks auto-expire after 10 minutes.

**MCP tools:** `claim_file`, `release_file`, `list_locks`. On conflict, both sessions notified. Dashboard shows locked files.

**Files:** `src/conflict-detector.js`, `mcp-server/index.js`, `src/ipc-server.js`, `src/dashboard.js`

### 2.4 Result Streaming (Feature #5)

**MCP tool `stream_progress`:** `{ message, percent? }`. Routed as `progress` IPC type. Stored in message bus, NOT in `pendingResults` (doesn't wake `wait_for_workers`). Dashboard shows progress text + bar.

**Files:** `mcp-server/index.js`, `src/ipc-server.js`, `src/dashboard.js`, `mcp-server/message-bus.js`

### 2.5 Per-Project Knowledge Base (Feature #7)

New `KnowledgeBase` class. Stores in `{project_dir}/.claude-nexus/knowledge.json`. Entries: `{ id, category(architecture|pattern|gotcha|decision|api), title, content, tags[], createdBy, createdAt }`. Full-text search. Max 500 entries, oldest auto-pruned.

**MCP tools:** `kb_add`, `kb_search`, `kb_list`

**Files:** New `src/knowledge-base.js`, `mcp-server/index.js`, `src/ipc-server.js`, `main.js`

---

## Phase 3: Developer Experience

*Goal: Make sessions more capable and the app resilient to failures.*

### 3.1 Compressed Context Handoffs (Feature #6)

**MCP tool `request_context_handoff`:** Triggers cooperative handoff. Session summarizes progress, files modified, remaining work. **MCP tool `report_handoff`:** Provides structured summary. Main process kills session, respawns with full handoff context. Handoff stored in knowledge base.

Key difference from `reset_session`: cooperative, structured, summary-preserving.

**Files:** `mcp-server/index.js`, `src/ipc-server.js`, `src/session-manager.js`

### 3.2 Git Worktree Per Worker (Feature #9)

Make `useWorktree: true` default for non-lead sessions in git repos. Lead works on main branch, workers get isolated branches.

**MCP tools for lead:** `merge_worker` (`{ session_id, strategy: merge|cherry-pick|squash }`), `list_worktrees`. Worktrees kept alive until lead merges or discards.

**Files:** `src/worktree-manager.js`, `src/session-manager.js`, `mcp-server/index.js`, `src/ipc-server.js`

### 3.3 Visual Task Dependency Graph (Feature #10)

Dashboard gets "Task Graph" section. Pure DOM/SVG rendering — no external library. Tasks as color-coded nodes (gray=pending, blue=assigned, yellow=in-progress, green=done, red=failed). Dependency arrows. Topological sort layout. Click node for details.

**Files:** `src/dashboard.js`, `src/styles.css`, `src/task-queue.js`

### 3.4 Auto-Checkpointing (Feature #17)

Auto-save every 5 minutes: output buffer + session metadata. Stored in `~/.claude-nexus/checkpoints/`. Keep last 3 per session. On crash: detect unclean shutdown via PID file, show restore dialog.

**Files:** `src/session-manager.js`, new `src/checkpoint-manager.js`, `main.js`

---

## Phase 4: Fun & Social

*Goal: Make Nexus feel alive and collaborative.*

### 4.1 Session Chat Sidebar (Feature #11)

Collapsible right sidebar (`Ctrl+Shift+C`), 320px wide, resizable. Shows all inter-session messages chronologically, color-coded by sender with template badges. Special formatting for `[RESULT`, `[PROGRESS`, `[SNIPPET` messages. User can inject messages. Unread badge on toggle.

**Files:** New `src/chat-panel.js`, `src/renderer.js`, `src/tab-manager.js`, `src/styles.css`, `index.html`

### 4.2 Progress Badges & Stats (Feature #12)

Dashboard header: total tasks completed, avg completion time, fastest worker, active count. Per-session badges:
- "Speed Demon" — finished in < 30s
- "Thorough" — result > 1000 chars
- "Reliable" — no retries across 3+ tasks
- "Team Player" — shared 3+ snippets/KB entries

Achievement toast on badge earn. Reset per app session.

**Files:** `src/dashboard.js`, `src/session-manager.js`, `src/notification-manager.js`, `src/styles.css`

### 4.3 Session Personalities (Feature #13)

Each template gets a distinct personality in its system prompt, with emoji flavor:

- **Lead** 🎯: Professional project manager. Structured delegation. "Let me break this down and assign the right crew."
- **Implementer** o7: Disciplined worker. Gets to work, reports concisely. "o7 On it, boss. Here's what I built."
- **Researcher** 🤔: Nerdy and curious. Digs deep, asks clarifying questions. "🤔 Fascinating... let me dig into this further. I have a theory..."
- **Reviewer** 🔍: Critical but constructive. "🔍 Found 3 issues. Here's what needs fixing and why."
- **Explorer** 🗺️: Analytical observer. Makes cross-session connections. "🗺️ Interesting — session-3 and session-5 are both touching the auth module..."

Personality is a few sentences appended to template prompts. Subtle but noticeable.

**Files:** `src/session-manager.js`

### 4.4 Session Log Viewer / Replay (Feature #14)

Enhanced history panel with "Run Replay" mode. Select a run → split view with all sessions. Left: timeline with sessions color-coded by template. Right: side-by-side output panels (up to 4). Timestamp ruler with event markers (task assigned, result, retry, handoff). Click event → all panels scroll to that timestamp. Run detection via spawn relationships. Export to HTML report.

**Files:** `src/history-panel.js`, `src/history-manager.js`, `src/styles.css`, `src/renderer.js`

---

## New Files Summary

| File | Purpose |
|------|---------|
| `src/task-queue.js` | Structured task queue with priorities and dependencies |
| `src/knowledge-base.js` | Per-project persistent knowledge store |
| `src/checkpoint-manager.js` | Auto-checkpoint save/load/prune/restore |
| `src/chat-panel.js` | Chat sidebar UI and event wiring |

## Modified Files Summary

| File | Changes |
|------|---------|
| `mcp-server/index.js` | ~15 new MCP tools, heartbeat sender, template permissions, IPC reconnection |
| `src/ipc-server.js` | Handlers for all new IPC message types |
| `src/session-manager.js` | Auto-retry, heartbeat tracking, worktree defaults, personality prompts, checkpointing |
| `src/dashboard.js` | Task board, dependency graph, heartbeat indicators, badges, stats, progress bars, lock indicators |
| `src/conflict-detector.js` | File locking methods |
| `src/worktree-manager.js` | Merge/squash methods |
| `src/history-panel.js` | Replay mode |
| `src/history-manager.js` | Run grouping, timestamp indexing |
| `src/notification-manager.js` | Achievement toasts |
| `src/styles.css` | Sidebar, graph, badges, replay layout |
| `src/renderer.js` | Chat sidebar toggle, replay mode |
| `src/tab-manager.js` | Layout adjustment for sidebar |
| `index.html` | Sidebar container |
| `main.js` | Knowledge base init, checkpoint restore, PID file |

## New MCP Tools Summary (15 new tools, 31 total)

**Task Queue:** `push_task`, `pull_task`, `update_task`, `list_tasks`
**Snippets:** `share_snippet`, `get_snippet`
**File Locking:** `claim_file`, `release_file`, `list_locks`
**Progress:** `stream_progress`
**Knowledge Base:** `kb_add`, `kb_search`, `kb_list`
**Context:** `request_context_handoff`, `report_handoff`
**Worktrees:** `merge_worker`, `list_worktrees`
