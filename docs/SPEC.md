# Claude Corroboree — Specification

## 1. Overview

Claude Corroboree is a tabbed Electron terminal application for running multiple Claude Code sessions in parallel with MCP-based coordination. It provides a visual orchestration layer where a lead session can spawn, monitor, and coordinate worker sessions — each running as a full, independent Claude Code instance with its own terminal, context window, and file access.

**Design Philosophy:**
- **Parallel-first**: Work is decomposed and delegated to worker sessions, not done serially in one context
- **Lead/Worker hierarchy**: A lead session orchestrates; workers execute and report back
- **MCP coordination**: All inter-session communication flows through per-session MCP servers connected via named pipe IPC
- **Git isolation**: Each worker session gets its own git worktree to prevent file conflicts
- **Dynamic capabilities**: Tools are organized into loadable packs — sessions start with a minimal core set and load additional packs on demand

## 2. Architecture

### 2.1 Main Process (Electron)

The main process (`main.js`) manages:
- **BrowserWindow** — Single window with `contextIsolation: true`
- **PTY processes** — One `node-pty` instance per Claude Code session
- **IPC server** — Named pipe server (`src/ipc-server.js`) bridging MCP servers to shared state
- **Session manager** — Lifecycle management for all sessions (`src/session-manager.js`)
- **Shared state** — Scratchpad, task queue, knowledge base, conflict detector, history manager
- **Auto-updater** — electron-updater for self-updates via GitHub releases

Key modules:
| File | Role |
|------|------|
| `main.js` | Electron entry point, window creation, IPC handler registration |
| `src/session-manager.js` | Session lifecycle (spawn, close, retry, respawn) |
| `src/ipc-server.js` | Named pipe server, message routing, shared state handlers |
| `src/scratchpad.js` | Shared key-value store across sessions |
| `src/worktree-manager.js` | Git worktree creation/cleanup per session |
| `src/conflict-detector.js` | Cross-session file edit conflict detection |
| `src/history-manager.js` | Session output capture and search |
| `src/notification-manager.js` | System tray and in-app toast notifications |

### 2.2 Renderer Process

The renderer (`src/renderer.js`) is bundled via esbuild (ES modules to IIFE) and manages:
- **xterm.js terminals** — `@xterm/xterm` v6 with `@xterm/addon-fit` for each session tab
- **Dashboard tab** — Session overview grid with live previews, sparklines, and session controls
- **History panel** — Session logs grouped by date
- **Tab bar** — Tab creation, switching, context menus, unread indicators, color coding

Key renderer modules:
| File | Role |
|------|------|
| `src/tab-manager.js` | Tab bar UI, terminal/dashboard/history tab types |
| `src/dashboard.js` | Dashboard grid with session cards, filtering, sorting |
| `src/history-panel.js` | Session log browser grouped by date |
| `src/project-picker.js` | Startup project selector with recents |
| `src/styles.css` | All application styling |

### 2.3 MCP Servers

Each Claude Code session gets its own MCP server instance:
- Spawned as a **stdio process** by session-manager
- Connects back to the main process via **named pipe IPC**
- Uses the `@modelcontextprotocol/sdk` for tool registration
- Tools are filtered by **session template** (lead/implementer/researcher/reviewer/explorer)
- Tools are organized into **loadable packs** — only core tools are active at startup

MCP server files:
| File | Role |
|------|------|
| `mcp-server/index.js` | MCP server entry point, all tool registrations |
| `mcp-server/message-bus.js` | Inter-session message routing |
| `mcp-server/session-registry.js` | Session metadata tracking |

### 2.4 Data Flow

```
User
  |
  v
[Electron Window / Renderer]
  |  xterm.js terminals          DOM-based dashboard/history
  |  (PTY I/O)                   (IPC events from main)
  |
  v
[preload.js bridge]  ----  contextIsolation boundary
  |
  v
[Electron Main Process]
  |                                          |
  v                                          v
[SessionManager]                      [IPC Server (named pipe)]
  |  spawns PTY                              ^        |
  |  manages lifecycle                       |        v
  v                                   [MCP Server 1] [MCP Server 2] ...
[node-pty] ----stdin/stdout----> [Claude Code CLI]
                                       |
                                       v
                                  MCP tool call
                                       |
                                       v
                                  [MCP Server (stdio)]
                                       |
                                       v
                                  named pipe IPC
                                       |
                                       v
                                  [IPC Server in Main]
                                       |
                                       v
                              route to target / shared state
```

**Message flow for inter-session communication:**
1. Claude Code session calls an MCP tool (e.g., `send_message`)
2. MCP server serializes the request and sends it over the named pipe to main process
3. IPC server in main process routes the message to the target session's MCP server
4. Target MCP server delivers the message to its Claude Code instance via tool results

## 3. Session System

### 3.1 Session Lifecycle

```
spawn_session / createSession
       |
       v
   [idle] <------- prompt visible (❯ character detected)
       |
       v
  [working] <----- any output received while idle
       |
       +-------> [stuck]    (no output for 60s while working)
       |
       +-------> [done]     (PTY exits with code 0)
       |
       +-------> [failed]   (PTY exits non-zero, retries exhausted)
       |
       +-------> [retrying] (PTY exits non-zero, retries remaining)
                     |
                     v
                [respawn with context] --> [idle]
```

**Retry behavior** (workers only):
- Up to 3 retries with exponential backoff: 2s, 8s, 30s
- Retry prompt includes the original task and recent output for context
- If all retries exhausted, status becomes `failed` and lead is notified

**Session creation details:**
- Each session gets a unique ID (e.g., `worker-5`, `lead`)
- A temporary MCP config JSON file is written pointing to the session's MCP server
- Claude Code is spawned via `node-pty` with `--session-id`, `--mcp-config`, and `--append-system-prompt`
- Workers get `--dangerously-skip-permissions` since the lead already authorized their work
- The `CLAUDECODE` environment variable is removed to prevent nesting detection

### 3.2 Session Templates

Templates control which MCP tools a session can access:

| Template | Role | Tool Access | Can Spawn Sessions | Can Edit Files |
|----------|------|-------------|-------------------|----------------|
| **lead** | Orchestrator | All tools | Yes | Yes (discouraged) |
| **implementer** | Worker | All tools | No (by convention) | Yes |
| **researcher** | Read-only investigator | Subset — no `send_message`, `spawn_session`, file editing tools | No | No |
| **reviewer** | Code reviewer | Subset — can send messages and use review tools, no spawn | No | No |
| **explorer** | Observer/analyst | Minimal — read history, search, scratchpad read, knowledge query | No | No |

**Lead** sessions orchestrate by decomposing tasks, spawning workers, and coordinating results. They are explicitly instructed NOT to write implementation code themselves.

**Implementer** sessions are the workhorses — full access to all tools but expected to stay focused on their assigned task and report back via `report_result`.

**Researcher** sessions can investigate, read session history, search across sessions, and use the knowledge base, but cannot modify anything.

**Reviewer** sessions can review code, send feedback messages, and use the review workflow tools (submit/claim/approve/request changes).

**Explorer** sessions have minimal tools — they observe patterns across sessions and report findings.

### 3.3 Worker Personality System

Sessions have injected personality via the system prompt:

- **Lead**: Confident, decisive project lead. Uses tactical metaphors ("deploy", "objective", "sitrep"). Calm under pressure.
- **Implementer**: Disciplined soldier-coder. Greets with "o7" (military salute). Tight, tactical messages. Signs off with "o7".
- **Researcher**: Curious investigator. Uses ">>> DISCOVERY <<<" and "(scribbles notes furiously)". Gets excited about elegant code.
- **Reviewer**: Sharp-eyed quality gatekeeper. Uses severity ratings `[!]` `[!!]` `[!!!]`. Structured APPROVED/CHANGES REQUESTED/BLOCKED.
- **Explorer**: Eagle-eyed observer. Uses map metaphors ("terrain report", "charting course"). Signs off "(folds map)".

**Important**: All reports, results, and inter-session communications are written in clear, professional, personality-free language for reliable comprehension by other Claude sessions.

### 3.4 Worktree Isolation

Worker sessions automatically get isolated git worktrees:
- Created in `.nexus-worktrees/<session-id>/` relative to the repo root
- Each worktree has its own branch: `nexus-<session-id>-<timestamp>`
- Workers can freely edit files without conflicts
- Lead can merge worker branches back via `merge_worker` tool
- Worktrees are cleaned up when sessions close

If the working directory is not a git repo, worktree creation is skipped and the session shares the main directory.

## 4. MCP Toolpacks

Tools are organized into 9 packs (1 core + 8 loadable). Only the `core` pack is active at startup. Sessions load additional packs with `load_toolpack` and unload with `unload_toolpack`.

### 4.1 `core` (always loaded — 21 tools)

| Tool | Description |
|------|-------------|
| `list_sessions` | List all active Claude Code sessions |
| `send_message` | Send a message to another session (with delivery acknowledgment) |
| `read_messages` | Read incoming messages from other sessions |
| `broadcast` | Send a message to all other sessions |
| `report_result` | Report task completion result back to lead |
| `stream_progress` | Report intermediate progress (does not wake wait_for_workers) |
| `report_handoff` | Report structured progress summary for context handoff |
| `spawn_session` | Spawn a new Claude Code session in a new tab |
| `spawn_workers` | Spawn multiple worker sessions in one call |
| `wait_for_workers` | Block until worker sessions report results |
| `get_session_status` | Check a session's status |
| `session_info` | Get introspection info (uptime, message counts, tool usage) |
| `scratchpad_set` | Store a value in the shared scratchpad |
| `scratchpad_get` | Retrieve a value from the shared scratchpad |
| `scratchpad_list` | List all keys in the shared scratchpad |
| `scratchpad_delete` | Delete a key from the shared scratchpad |
| `batch_scratchpad` | Batch set/get multiple scratchpad keys |
| `scratchpad_cas` | Atomic compare-and-swap on a scratchpad value |
| `close_session` | Close a worker session tab |
| `close_all_done` | Close all done/failed/exited worker sessions |
| `context_estimate` | Get context window usage percentage from Claude transcript |

### 4.2 `tasks` (8 tools)

Task queue for structured work distribution. Load when using push/pull task workflow.

| Tool | Description |
|------|-------------|
| `push_task` | Push a task to the shared queue (with priority and dependencies) |
| `pull_task` | Pull the next highest-priority unblocked task |
| `update_task` | Update a task's status or result |
| `list_tasks` | List tasks with optional status filter |
| `get_task_graph` | Get the full task dependency graph (DAG) |
| `propose_task` | Propose a new task bottom-up (lead notified for approval) |
| `list_proposals` | List task proposals with optional status filter |
| `review_proposal` | Approve or reject a task proposal (lead-only) |

### 4.3 `files` (5 tools)

File locking and snippet sharing. Load when multiple workers may edit overlapping files.

| Tool | Description |
|------|-------------|
| `claim_file` | Claim a file for editing (prevents conflicts) |
| `release_file` | Release a file lock |
| `list_locks` | List all active file locks across sessions |
| `share_snippet` | Share a file snippet with another session |
| `get_snippet` | Retrieve a shared snippet by ID |

### 4.4 `knowledge` (11 tools)

Knowledge base and knowledge graph for persistent project knowledge. Load for research, documentation, or pattern tracking.

| Tool | Description |
|------|-------------|
| `kb_add` | Add an entry to the project knowledge base |
| `kb_search` | Search the knowledge base |
| `kb_list` | List knowledge base entries by category |
| `remember` | Record a learning/decision/discovery that persists across resets |
| `recall` | Search persistent session memories by tags |
| `get_lineage` | Get history of prior attempts at a similar task |
| `kg_add_entity` | Add an entity to the knowledge graph |
| `kg_add_relationship` | Add a relationship between entities |
| `kg_query` | Query entities or relationships |
| `kg_traverse` | Traverse the graph from an entity (up to 5 hops) |
| `kg_export` | Export the full knowledge graph |

### 4.5 `review` (5 tools)

Code review workflow. Load when submitting or reviewing code changes.

| Tool | Description |
|------|-------------|
| `submit_for_review` | Submit files for code review |
| `claim_review` | Claim a pending review |
| `approve_review` | Approve a code review |
| `request_changes` | Request changes with line-level comments |
| `list_reviews` | List reviews with optional status filter |

### 4.6 `decisions` (4 tools)

Consensus decision-making. Load when sessions need to vote on design/architecture decisions.

| Tool | Description |
|------|-------------|
| `propose_decision` | Propose a decision for sessions to vote on |
| `vote` | Cast a vote on an open decision with reasoning |
| `resolve_decision` | Resolve a decision (majority or explicit winner) |
| `list_decisions` | List decisions with optional status filter |

### 4.7 `lifecycle` (10 tools)

Session lifecycle management. Load for context handoff, merging, worktree management.

| Tool | Description |
|------|-------------|
| `reset_session` | Reset a session with auto-summary |
| `promote_session` | Grant additional tools to a session (lead-only) |
| `demote_session` | Revoke tools from a session (lead-only) |
| `request_promotion` | Request additional tool capabilities from lead |
| `merge_worker` | Merge a worker's worktree branch (merge/cherry-pick/squash) |
| `resolve_conflicts` | Resolve merge conflicts after failed merge |
| `list_worktrees` | List all active git worktrees and changed files |
| `get_worker_diff` | Get git diff for a worker's worktree |
| `request_context_handoff` | Request cooperative context handoff |
| `save_checkpoint` | Save current session state as a named checkpoint |

### 4.8 `history` (3 tools)

Session history and cross-session intelligence. Load for debugging, auditing, or research.

| Tool | Description |
|------|-------------|
| `read_session_history` | Read terminal output from another session |
| `search_across_sessions` | Search through all sessions' output (regex) |
| `query_git_status` | Get structured git status for the session's working directory |

### 4.9 `events` (4 tools)

Event pub/sub system. Load for reactive workflows (e.g., trigger on build complete).

| Tool | Description |
|------|-------------|
| `subscribe` | Subscribe to events matching a channel pattern (wildcards supported) |
| `unsubscribe` | Unsubscribe from a channel pattern |
| `publish` | Publish an event to a channel |
| `structured_message` | Send a typed, structured message (blocker/info/request/decision/review) |

### Meta Tools (always available)

These 3 tools are always enabled regardless of template or loaded packs:
- `load_toolpack` — Load a tool pack
- `unload_toolpack` — Unload a tool pack
- `list_toolpacks` — List all packs with their tools and loaded status

## 5. Core Tools (Always Available)

The 21 tools in the `core` pack plus the 3 meta tools (24 total) are always available to every session. They cover:

**Communication** (4): `list_sessions`, `send_message`, `read_messages`, `broadcast`

**Session Management** (5): `spawn_session`, `spawn_workers`, `wait_for_workers`, `get_session_status`, `session_info`

**Results & Progress** (3): `report_result`, `stream_progress`, `report_handoff`

**Shared State** (6): `scratchpad_set`, `scratchpad_get`, `scratchpad_list`, `scratchpad_delete`, `batch_scratchpad`, `scratchpad_cas`

**Cleanup & Monitoring** (3): `close_session`, `close_all_done`, `context_estimate`

**Meta** (3): `load_toolpack`, `unload_toolpack`, `list_toolpacks`

## 6. Skills System

Skills are Markdown files in `.claude/skills/` that provide structured workflows and processes. They are invoked via the `Skill` tool and guide Claude Code sessions through specific procedures.

### Project Skills (7 skills)

| Skill | Description |
|-------|-------------|
| `nexus-orchestration` | Lead session workflow for task decomposition and worker coordination |
| `nexus-planning` | Multi-step task planning and spec-to-plan conversion |
| `nexus-review` | Code review workflow for reviewer sessions |
| `nexus-debugging` | Systematic debugging process across sessions |
| `nexus-handoff` | Context handoff procedure when sessions approach context limits |
| `nexus-conflict-resolution` | Resolving merge conflicts between worker worktrees |
| `nexus-cleanup` | Session and worktree cleanup procedures |

### User-Configured Skills (loaded from user's Claude Code setup)

The user has additional skills configured in their Claude Code environment that apply across all projects. These include development workflow skills (brainstorming, TDD, debugging, code review, plan execution), frontend design skills, and meta skills (skill authoring, CLAUDE.md management). These are documented in the user's Claude Code configuration and are not part of the Corroboree codebase.

## 7. IPC Protocol

### 7.1 Transport

- **Windows**: Named pipe at `\\.\pipe\claude-corroboree-ipc`
- **Unix/macOS**: Unix socket at `{tmpdir}/claude-corroboree-ipc.sock`

### 7.2 Message Format

Messages are newline-delimited JSON (`\n`-separated). Each message is a single JSON object.

```json
{
  "type": "message_type",
  "requestId": 123,          // optional — for request/response pattern
  "sessionId": "worker-5",   // sender or target depending on message type
  ...                         // type-specific fields
}
```

**Request/response pattern**: The MCP server sends a message with a `requestId`. The IPC server processes it and sends back a response with the same `requestId`. The MCP server resolves the pending promise. Timeout defaults to 10 seconds.

### 7.3 Key Message Types

**Session lifecycle:**
| Type | Direction | Description |
|------|-----------|-------------|
| `register` | MCP → Main | Session registers with IPC server on connect |
| `heartbeat` | MCP → Main | Periodic keepalive (every 10s) |
| `spawn_session` | MCP → Main | Request to spawn a new worker session |
| `batch-spawn` | MCP → Main | Spawn multiple workers at once |
| `close_session` | MCP → Main | Close a worker session |
| `close_all_done` | MCP → Main | Close all finished sessions |
| `reset_session` | MCP → Main | Reset a session with summary preservation |

**Communication:**
| Type | Direction | Description |
|------|-----------|-------------|
| `send_message` | MCP → Main → MCP | Route message to target session |
| `broadcast` | MCP → Main → all MCP | Broadcast to all sessions |
| `report_result` | MCP → Main → lead MCP | Worker reports task result |
| `stream_progress` | MCP → Main | Progress update (forwarded to renderer) |

**Shared state:**
| Type | Direction | Description |
|------|-----------|-------------|
| `scratchpad_set/get/list/delete` | MCP ↔ Main | Key-value store operations |
| `batch_scratchpad` | MCP ↔ Main | Batch scratchpad operations |
| `scratchpad_cas` | MCP ↔ Main | Atomic compare-and-swap |
| `task_push/pull/update/list` | MCP ↔ Main | Task queue operations |
| `kb_add/search/list` | MCP ↔ Main | Knowledge base operations |

**Git/worktree:**
| Type | Direction | Description |
|------|-----------|-------------|
| `merge_worktree` | MCP → Main | Merge worker branch into main |
| `resolve_conflicts` | MCP → Main | Resolve merge conflicts |
| `list_worktrees` | MCP → Main | List active worktrees |
| `get_worker_diff` | MCP → Main | Get git diff for a worker |
| `query_git_status` | MCP → Main | Get structured git status |

**Events:**
| Type | Direction | Description |
|------|-----------|-------------|
| `subscribe/unsubscribe` | MCP → Main | Event channel subscription management |
| `publish` | MCP → Main → subscribers | Publish event to matching subscribers |

### 7.4 IPC Resilience

- MCP servers buffer critical messages (`report_result`, `heartbeat`, `register`) while disconnected
- Reconnection uses exponential backoff up to 20 attempts (max 30s delay)
- The IPC server tracks per-session stats (connected time, messages sent/received, tool calls)

## 8. UI Components

### 8.1 Tab Bar

- Horizontal tab strip across the top of the window
- Each tab shows: session label, color indicator (hashed from session ID), status dot, unread badge
- Tab context menu: Rename, Duplicate, Close, Close Others, Close to Right
- Supports drag reordering (planned)
- Tab types: `terminal` (xterm.js), `dashboard` (DOM), `history` (DOM)

**Keyboard shortcuts:**
| Shortcut | Action |
|----------|--------|
| `Ctrl+T` | New session tab |
| `Ctrl+W` | Close current tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle tabs |
| `Ctrl+1-9` | Jump to tab by number |
| `Ctrl+Shift+D` | Toggle dashboard |
| `Ctrl+Shift+H` | Toggle history panel |

### 8.2 Dashboard

The Nexus Dashboard is a DOM-based overview panel showing all active sessions in a grid layout.

**Features:**
- **Session cards**: Each session displayed as a card with status indicator, label, template badge, live output preview (last 5 lines), and sparkline activity graph (60-second rolling window)
- **Filtering**: Text search, status filter buttons (All/Active/Idle/Done/Error)
- **Sorting**: By name, status, or creation time
- **Session controls**: Quick actions per card (cancel, restart, send message, view diff)
- **Toolbar buttons**: Unstick All (send Enter to frozen sessions), Broadcast, Update Claude, Update Nexus
- **Session mood**: Inferred emotional state from output patterns
- **Performance stats**: Tasks completed, total time, fastest worker tracking

### 8.3 History Panel

Session log browser displaying captured terminal output grouped by date. Allows searching through historical session data.

### 8.4 Status Bar

Bottom status bar showing:
- **Context usage**: Percentage of context window consumed (read from Claude JSONL transcripts, updated every 5 seconds)
- **Subscription badge**: User's Claude subscription plan (read from `claude auth status`)
- **Session count**: Number of active sessions
- **App version**: Current Corroboree version

### 8.5 Preload Bridge

All renderer-to-main communication goes through `preload.js` using `contextBridge.exposeInMainWorld('nexus', ...)`. The `nexus` API provides:

- Session management: `createSession`, `closeSession`, `listSessions`, `getSessionInfo`, `duplicateSession`
- Terminal I/O: `terminalWrite`, `resizeTerminal`, `onTerminalData`, `offTerminalData`
- Session controls: `cancelSession`, `restartSession`, `sendQuickMessage`, `broadcastMessage`, `retrySession`
- Dashboard events: `onOutputPreview`, `onStuckWarning`, `onSessionResult`, `onAllWorkersComplete`, `onSessionProgress`, `onContextUpdate`
- Clipboard: `clipboardReadText`, `clipboardWriteText`, `clipboardHasImage`, `saveClipboardImage`
- Auto-updater: `checkForUpdates`, `downloadUpdate`, `installUpdate`, `getVersion`, `onUpdate*`
- System: `openExternal`, `browseForFolder`, `getStartupCwd`, `loadRecipes`
- Notifications: `getNotificationsEnabled`, `setNotificationsEnabled`

## Appendix A: Build & Release

```bash
npm start          # Bundle renderer + launch app
npm run bundle     # Bundle renderer only (esbuild)
npm run build      # Build distributable (electron-builder)
npm run rebuild    # Rebuild native modules for Electron
```

The release process requires building assets (`latest.yml` + `.exe`) and uploading them to GitHub releases for the auto-updater to function. See CLAUDE.md for the full release checklist.

## Appendix B: Platform Notes

- **Windows ConPTY workaround**: A periodic resize nudge (every 3s) flushes stuck output buffers — ConPTY sometimes holds output until it receives an event
- **Stuck session detection**: Sessions with no output for 60s while in `working` status trigger a stuck warning and auto-nudge (Enter keypress for workers)
- **CLAUDECODE env removal**: The `CLAUDECODE` environment variable is deleted before spawning sessions to prevent Claude Code's nesting detection from refusing to launch
