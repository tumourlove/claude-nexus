# Claude Nexus

A tabbed Electron terminal for running multiple Claude Code sessions in parallel with full MCP-powered coordination.

![Claude Nexus](https://img.shields.io/badge/version-0.2.0-blue) ![Platform](https://img.shields.io/badge/platform-Windows-lightgrey) ![License](https://img.shields.io/badge/license-MIT-green)

## What It Does

Nexus lets you run multiple Claude Code sessions side-by-side in tabs. Each session gets an MCP server injected that gives Claude the ability to talk to other sessions, spawn workers, share state, and coordinate complex multi-session workflows — all automatically.

The **Lead** session can break a task into subtasks, spawn worker sessions, monitor their progress, and collect results. Workers report back when done. All sessions share a scratchpad for plans, status, and data.

## Features

### Terminal & Tabs
- Multiple Claude Code sessions in tabs with xterm.js (v6)
- Keyboard shortcuts for tab management, clipboard, and navigation
- Shift+Enter for multi-line Claude Code input
- Image paste from clipboard (saves to temp file, pastes path)
- Help dropdown with all shortcuts (F1 or ? button)

### MCP Coordination (16 Tools)
Each session automatically gets these tools:

| Category | Tools |
|----------|-------|
| **Communication** | `list_sessions`, `send_message`, `read_messages`, `broadcast` |
| **Orchestration** | `spawn_session`, `get_session_status`, `report_result` |
| **Shared State** | `scratchpad_set`, `scratchpad_get`, `scratchpad_list` |
| **History** | `read_session_history`, `search_across_sessions` |
| **Context** | `spawn_explorer`, `reset_session`, `save_checkpoint` |

### Session Awareness
Sessions know their role and capabilities from startup via injected system prompts:
- **Lead** sessions orchestrate work, spawn workers, coordinate results
- **Worker** sessions focus on assigned tasks and report back

### Panels
- **Dashboard** (Ctrl+Shift+D) — Real-time overview of all sessions and activity
- **History** (Ctrl+Shift+H) — Browse past session output with search

### Autopilot (v0.2.0)
- **Live preview cards** — Dashboard shows last 5 lines of each session's output
- **Session controls** — Cancel, restart, message, and focus buttons per session
- **Tab badges** — Unread message count on inactive tabs
- **Stuck detection** — Warns when a working session goes silent for 60s
- **Auto-retry** — Failed workers can be retried with failure context (max 2 retries)
- **Result aggregation** — Worker results collected and displayed on dashboard
- **Real-time status** — Sessions tracked as idle/working/done/error/stuck
- **Persistent scratchpad** — Shared state survives app restarts
- **Update buttons** — Update Claude Code and Nexus from the dashboard

### System Integration
- Conflict detection when multiple sessions edit the same file
- Git worktree isolation (optional per-session)
- System tray + in-app toast notifications
- Auto-update from GitHub Releases
- Windows Explorer "Open in Claude Nexus" context menu
- `nexus` command in Explorer address bar and Win+R

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+T | New session tab |
| Ctrl+W | Close tab |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |
| Ctrl+1-9 | Jump to tab by number |
| Ctrl+Shift+D | Dashboard panel |
| Ctrl+Shift+H | History panel |
| Ctrl+C | Copy selection (or SIGINT if no selection) |
| Ctrl+V | Paste text or image |
| Ctrl+X | Cut selection |
| Ctrl+A | Select all |
| Ctrl+L | Clear scrollback |
| Shift+Enter | New line (multi-line input) |
| F1 | Help dropdown |

## Install

### From Source (Development)

```bash
git clone https://github.com/tumourlove/claude-nexus.git
cd claude-nexus
npm install
npm start
```

### Open a Specific Project

```bash
npm start -- "C:\path\to\project"
```

### Register Shell Integration

```bash
node scripts/register-shell.js
```

This adds:
- Right-click "Open in Claude Nexus" on folders
- `nexus` command in Explorer address bar and Win+R

### Build Installer

```bash
npm run build
```

Produces Windows NSIS installer and portable exe in `release/`.

## How It Works

```
┌─────────────────────────────────────────────┐
│  Electron (main.js)                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ Session 1 │  │ Session 2 │  │ Session 3 │  │
│  │ (Lead)   │  │ (Worker) │  │ (Worker) │  │
│  │ node-pty │  │ node-pty │  │ node-pty │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
│       │              │              │        │
│  ┌────┴─────┐  ┌────┴─────┐  ┌────┴─────┐  │
│  │ MCP Srv  │  │ MCP Srv  │  │ MCP Srv  │  │
│  └────┬─────┘  └────┴─────┘  └────┴─────┘  │
│       │              │              │        │
│  ┌────┴──────────────┴──────────────┴────┐  │
│  │     Named Pipe IPC (message broker)    │  │
│  └────────────────┬──────────────────────┘  │
│                   │                          │
│  ┌────────────────┴──────────────────────┐  │
│  │  SessionManager · Scratchpad · History │  │
│  │  ConflictDetector · NotificationMgr    │  │
│  └────────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

Each tab spawns a Claude Code CLI process with a per-session MCP config. The MCP server connects back to Electron's main process via named pipe, which routes messages between sessions and manages shared state.

## Requirements

- Node.js 18+
- Claude Code CLI (`claude`) installed and in PATH
- Windows 10/11 (macOS/Linux support planned)
- Visual Studio Build Tools (for node-pty compilation)

## License

MIT
