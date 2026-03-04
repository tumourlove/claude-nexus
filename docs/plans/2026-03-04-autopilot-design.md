# Claude Nexus Autopilot (v0.2.0) — Design Document

## Overview

Upgrade Nexus from a multi-tab terminal into a smart orchestration platform. The focus is on **visibility**, **control**, **reliability**, and **automatic result handling** for parallel Claude Code workflows.

Target use case: User gives the lead session a complex task. Lead breaks it into subtasks, spawns workers. User watches from the dashboard, intervenes when needed, and gets aggregated results.

## Features

### 1. Live Session Preview Cards (Dashboard)

Replace the current flat session list with rich preview cards.

**Each card shows:**
- Session label, template badge, isLead indicator
- Status dot (green=idle, orange=working, red=error, checkmark=done)
- Last 5 lines of terminal output, ANSI-stripped, monospace
- Progress bar (when session reports progress via scratchpad key `_progress:<sessionId>`)
- Clickable to jump to that session's tab

**Updates are event-driven** — main process pushes output snippets to dashboard when new data arrives (no polling).

**Lead card** has a highlighted border to distinguish it visually.

### 2. Session Controls

Each dashboard card has action buttons:

| Button | Action |
|--------|--------|
| **Cancel** | Send SIGINT to the session (with confirmation) |
| **Restart** | Kill session, respawn with same CWD/template/task + context about previous attempt |
| **Message** | Open a quick text input to send a message to that session |
| **Focus** | Switch to that session's tab |

**Lead-only controls:**
| Button | Action |
|--------|--------|
| **Broadcast** | Send a message to all worker sessions |

**Dashboard toolbar (global controls):**
| Button | Action |
|--------|--------|
| **Update Claude Code** | Run `claude update` in a temporary process, show output |
| **Update Nexus** | Trigger auto-updater check + download |

### 3. Tab Badges

Tab labels show real-time indicators:

- **Unread message count** — Badge number (e.g. `Lead (2)`) when MCP messages arrive for that session
- **Status dot color** — Matches session status: green (idle), orange (working), red (error), blue checkmark (done)
- Badges clear when the user switches to that tab

### 4. Stuck Detection

Monitor session output activity to catch stuck workers.

**Logic:**
- Track timestamp of last output per session
- If a session with status "working" produces no output for **60 seconds**, flag as potentially stuck
- Dashboard card shows warning indicator (yellow border + icon)
- Lead session receives notification: "Worker X appears stuck — no output for 60s"
- Lead can: message the worker, restart it, or dismiss the warning

**Configuration:**
- Threshold: 60s default
- Can be adjusted per-session or globally (future: settings UI)
- Only triggers for sessions with "working" status

### 5. Auto-Retry on Failure

When a worker session exits with non-zero exit code or crashes:

1. Dashboard card updates to show "Failed" status with last 10 lines of output
2. A **Retry** button appears on the card
3. Clicking Retry respawns the session with:
   - Same CWD, template, and label
   - Original initial prompt + appended context: "Previous attempt failed with: [last 10 lines]. Try a different approach."
4. Maximum **2 retries** per session to prevent infinite loops
5. After max retries, card shows "Failed permanently" — user must manually intervene

### 6. Result Aggregation

When workers call `report_result` MCP tool:

- Results stored in scratchpad under `_results:<sessionId>` key with timestamp, status, and result text
- Dashboard shows a **Results Panel** section listing all completed worker results in chronological order
- Each result entry shows: worker label, status (success/partial/failed), result summary, timestamp
- When all spawned workers have reported results, the lead session gets a notification: "All N workers complete — results ready"
- Results panel is accessible from dashboard and as a section in the history panel

### 7. Session Status Tracking

Replace the currently static "idle" status with real-time status detection.

**Status states:**
| Status | Meaning | Detection |
|--------|---------|-----------|
| `idle` | Waiting for input | Prompt character `❯` detected in recent output |
| `working` | Producing output | Continuous output without prompt character |
| `done` | Completed successfully | Session called `report_result` or exited with code 0 |
| `error` | Failed | Exited with non-zero code, or stuck timeout triggered |

**Implementation:**
- `SessionManager` monitors PTY output for prompt patterns
- Status updates are pushed to renderer via IPC
- Dashboard, tab badges, and notification system all react to status changes
- Debounced: status only changes after 2s of consistent state to avoid flicker

### 8. Persistent Scratchpad

Save scratchpad data to disk so it survives app restarts.

**Storage:** `~/.claude-nexus/scratchpad.json`

**Behavior:**
- Auto-saves on every `scratchpad_set` call (debounced 1s to avoid thrashing)
- Loads from disk on app startup
- Namespaced by project CWD hash so different projects don't collide
- Stale entries (>7 days) are automatically cleaned up on startup

**Schema:**
```json
{
  "<cwd-hash>": {
    "<key>": { "value": "...", "updatedAt": 1709567123000 }
  }
}
```

## Architecture Changes

### New IPC Events (main → renderer)

| Event | Payload | Purpose |
|-------|---------|---------|
| `session:output-preview` | `{ id, lines: string[] }` | Push last 5 lines to dashboard |
| `session:status` | `{ id, status }` | Status change (already exists, needs real data) |
| `session:result` | `{ id, result, status, timestamp }` | Worker reported result |
| `session:stuck-warning` | `{ id, lastOutputAge }` | Stuck detection alert |
| `workers:all-complete` | `{ results: [...] }` | All spawned workers finished |

### New IPC Handlers (renderer → main)

| Handler | Payload | Purpose |
|---------|---------|---------|
| `session:cancel` | `{ id }` | Send SIGINT to session |
| `session:restart` | `{ id }` | Kill + respawn session |
| `session:send-message` | `{ id, text }` | Quick message from dashboard |
| `session:broadcast` | `{ text }` | Broadcast from dashboard |
| `app:update-claude` | — | Run `claude update` |
| `app:check-update` | — | Trigger Nexus auto-updater |

### Modified Files

| File | Changes |
|------|---------|
| `src/session-manager.js` | Status detection, restart logic, output preview emission, stuck monitoring |
| `src/dashboard.js` | Complete rewrite — preview cards, controls, results panel, toolbar |
| `src/tab-manager.js` | Tab badge rendering, unread count tracking |
| `src/scratchpad.js` | Disk persistence, namespace by CWD, auto-save, stale cleanup |
| `src/ipc-server.js` | Result collection, stuck detection forwarding |
| `main.js` | New IPC handlers for cancel/restart/broadcast/update |
| `preload.js` | Expose new IPC methods |
| `src/renderer.js` | Wire up new events to tab badges and notifications |
| `src/styles.css` | Dashboard card styles, progress bars, badges, toolbar |
| `mcp-server/index.js` | Enhance report_result to store in scratchpad |

## Non-Goals (v0.2.0)

- Split panes (Approach 3)
- Task dependency graph visualization (Approach 3)
- Session timeline (Approach 3)
- Drag-and-drop tab reordering (Approach 3)
- Settings UI
- macOS/Linux support
- Web search/fetch MCP tools
