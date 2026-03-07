# Claude Corroboree

Tabbed Electron terminal app for running multiple Claude Code sessions in parallel with MCP-based coordination.

## Project Structure

```
claude-corroboree/
  main.js              # Electron main process — window, IPC handlers, orchestration
  preload.js           # Secure IPC bridge (contextIsolation)
  index.html           # App shell with tab bar, terminal container, status bar
  electron-builder.yml # Build config for electron-builder (source of truth)
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
    chat-panel.js      # Inter-session chat sidebar UI
    checkpoint-manager.js # Session checkpoint/restore support
    command-palette.js # Command palette UI
    consensus-manager.js # Multi-session consensus/voting mechanism
    cost-tracker.js    # Token usage + cost estimation from session output
    event-bus.js       # Cross-module event pub/sub
    knowledge-base.js  # Shared knowledge store across sessions
    knowledge-graph.js # Knowledge relationship graph
    logger.js          # Structured logging utility
    recipe-loader.js   # Project recipe/template loading
    review-manager.js  # Code review coordination across sessions
    session-memory.js  # Per-session persistent memory
    task-queue.js      # Task queue for work distribution
    theme-manager.js   # Terminal theme cycling + persistence
    styles.css         # All app styling
  mcp-server/
    index.js           # MCP server entry point (stdio transport, ~80 tools across 9 toolpacks)
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

## Release Process (MANDATORY)

User relies on auto-updater — EVERY release MUST include built assets.

```bash
# 1. Bump version
#    Edit package.json version field

# 2. Commit + tag + push
git add -A && git commit -m "chore: bump version to X.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin master --tags

# 3. Build installer (creates release/ dir with .exe + latest.yml)
npm run build

# 4. Create GitHub release WITH assets
gh release create vX.Y.Z \
  "release/Claude-Corroboree-Setup-X.Y.Z.exe" \
  "release/Claude-Corroboree-Setup-X.Y.Z.exe.blockmap" \
  "release/Claude Corroboree X.Y.Z.exe" \
  "release/latest.yml" \
  --title "vX.Y.Z — Title" --notes "Release notes here"

# 5. Verify assets uploaded
gh release view vX.Y.Z --json assets --jq '.assets[].name'
```

Without `latest.yml` + `.exe` assets, electron-updater cannot detect updates. NEVER create a release without running `npm run build` and uploading the artifacts.

## Keyboard Shortcuts

- `Ctrl+T` — New session tab
- `Ctrl+W` — Close current tab
- `Ctrl+Shift+T` — Reopen last closed tab
- `Ctrl+Tab` / `Ctrl+Shift+Tab` — Cycle tabs
- `Ctrl+1-9` — Jump to tab by number
- `Ctrl+P` — Quick tab switcher
- `Ctrl+Shift+D` — Toggle dashboard
- `Ctrl+Shift+H` — Toggle history panel
- `Ctrl+Shift+C` — Toggle chat panel
- `Ctrl+Shift+F` — Terminal search
- `Ctrl+=` / `Ctrl++` — Zoom in
- `Ctrl+-` — Zoom out
- `Ctrl+0` — Reset zoom
- `Ctrl+Shift+K` — Cycle theme
- `F1` — Toggle help

## Key Design Decisions

- **contextIsolation: true** — All renderer ↔ main communication goes through preload.js bridge
- **esbuild bundling** — Renderer uses ES module imports, bundled to IIFE for browser context
- **Named pipe IPC** — `\\.\pipe\claude-corroboree-ipc` on Windows, Unix socket elsewhere
- **Per-session MCP config** — Each session gets a temp JSON config file pointing to its MCP server instance
- **@xterm/xterm v6** — Using the non-deprecated `@xterm/*` package namespace
- **electron-builder.yml** — Source of truth for build config (not package.json build section)
