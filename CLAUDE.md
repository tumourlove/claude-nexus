# Claude Nexus

Tabbed Electron terminal app for running multiple Claude Code sessions in parallel with MCP-based coordination.

## Project Structure

```
claude-nexus/
  main.js              # Electron main process — window, IPC handlers, orchestration
  preload.js           # Secure IPC bridge (contextIsolation)
  index.html           # App shell with tab bar, terminal container, status bar
  src/
    renderer.js        # Renderer entry point — tab management, shortcuts, startup
    tab-manager.js     # Tab bar UI + xterm/dashboard/history tab types
    session-manager.js # Main-process session lifecycle (PTY spawn, MCP config, worktrees)
    ipc-server.js      # Named pipe server bridging MCP servers ↔ Electron
    scratchpad.js      # Shared key-value store across sessions
    history-manager.js # Session output capture + search
    conflict-detector.js # Cross-session file edit conflict detection
    worktree-manager.js  # Git worktree creation/cleanup per session
    notification-manager.js # System tray + in-app toast notifications
    dashboard.js       # Dashboard tab — session overview + activity log
    history-panel.js   # History tab — session logs grouped by date
    project-picker.js  # Startup project selector with recents
    styles.css         # All app styling
  mcp-server/
    index.js           # MCP server entry point (stdio transport, 16 tools)
    message-bus.js     # Inter-session message routing
    session-registry.js # Session metadata tracking
  scripts/
    register-shell.js   # Windows Explorer context menu registration
    unregister-shell.js # Context menu removal
```

## Architecture

- **Electron main process** manages windows, PTY processes (via node-pty), and the IPC named pipe server
- **Renderer process** uses esbuild-bundled xterm.js for terminal tabs, plus DOM-based dashboard/history tabs
- **MCP servers** are spawned per-session as stdio processes — each Claude Code instance gets its own MCP server that connects back to the main process via named pipe IPC
- **IPC flow**: Claude → MCP tool call → MCP server → named pipe → Electron main → (route to target session's MCP server or update shared state)

## Commands

- `npm start` — Bundle renderer and launch app
- `npm run bundle` — Bundle renderer only (esbuild)
- `npm run build` — Build distributable (electron-builder)
- `npm run rebuild` — Rebuild native modules for Electron

## Keyboard Shortcuts

- `Ctrl+T` — New session tab
- `Ctrl+W` — Close current tab
- `Ctrl+Tab` / `Ctrl+Shift+Tab` — Cycle tabs
- `Ctrl+1-9` — Jump to tab by number
- `Ctrl+Shift+D` — Toggle dashboard
- `Ctrl+Shift+H` — Toggle history panel

## Key Design Decisions

- **contextIsolation: true** — All renderer ↔ main communication goes through preload.js bridge
- **esbuild bundling** — Renderer uses ES module imports, bundled to IIFE for browser context
- **Named pipe IPC** — `\\.\pipe\claude-nexus-ipc` on Windows, Unix socket elsewhere
- **Per-session MCP config** — Each session gets a temp JSON config file pointing to its MCP server instance
- **@xterm/xterm v6** — Using the non-deprecated `@xterm/*` package namespace
