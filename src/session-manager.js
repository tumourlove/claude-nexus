const pty = require('node-pty');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WorktreeManager } = require('./worktree-manager');

class SessionManager {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.sessions = new Map();
    this.configDir = path.join(os.homedir(), '.claude-nexus', 'configs');
    fs.mkdirSync(this.configDir, { recursive: true });
    this.onOutput = null; // set by main.js
    this.worktreeManager = new WorktreeManager();
    this.stuckThresholdMs = 60000; // 60 seconds
    this._stuckCheckInterval = setInterval(() => this._checkStuck(), 10000);
  }

  createSession(id, { label, cwd, initialPrompt, template, isLead = false, useWorktree = false, cols = 80, rows = 30 }) {
    let resolvedCwd = cwd || process.argv[2] || process.env.USERPROFILE || process.env.HOME;

    // Optionally create an isolated git worktree for this session
    let worktreeInfo = null;
    if (useWorktree) {
      try {
        worktreeInfo = this.worktreeManager.createWorktree(id, resolvedCwd);
        resolvedCwd = worktreeInfo.path;
      } catch (e) {
        // Fall back to shared cwd if worktree creation fails
        console.error(`Worktree creation failed for ${id}: ${e.message}`);
      }
    }

    // Write temporary MCP config for this session
    const mcpConfigPath = path.join(this.configDir, `mcp-${id}.json`);
    const mcpConfig = this._buildMcpConfig(id, template || (isLead ? 'lead' : 'implementer'));
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    // Build claude CLI args
    const args = ['--mcp-config', mcpConfigPath];

    // Workers auto-accept permissions since the lead already authorized their task
    if (!isLead) {
      args.push('--dangerously-skip-permissions');
    }

    // Inject Nexus awareness so Claude knows its capabilities
    const systemPrompt = this._buildSystemPrompt(id, template || (isLead ? 'lead' : 'implementer'));
    args.push('--append-system-prompt', systemPrompt);

    if (initialPrompt) {
      args.push('--', initialPrompt);
    }

    // Resolve claude executable path — Electron may not inherit full shell PATH
    const claudePath = this._findExecutable('claude');

    const ptyProc = pty.spawn(claudePath, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: resolvedCwd,
      env: (() => {
        const env = { ...process.env };
        // Remove nesting detection so Claude Code doesn't refuse to launch
        delete env.CLAUDECODE;
        return env;
      })(),
      useConpty: true,
    });

    const session = {
      id,
      pty: ptyProc,
      label,
      cwd: resolvedCwd,
      template: template || (isLead ? 'lead' : 'implementer'),
      status: 'idle',
      isLead,
      mcpConfigPath,
      worktree: worktreeInfo,
      createdAt: Date.now(),
      lastOutputAt: Date.now(),
      initialPrompt: initialPrompt || null,
      retryCount: 0,
      maxRetries: 2,
    };

    ptyProc.onData((data) => {
      this.mainWindow.webContents.send(`terminal:data:${id}`, data);
      if (this.onOutput) this.onOutput(id, data);

      // Track activity for status detection
      session.lastOutputAt = Date.now();

      // Detect idle state (prompt character visible)
      if (data.includes('\u276f') || data.includes('❯')) {
        this.updateStatus(id, 'idle');
      } else if (session.status === 'idle') {
        this.updateStatus(id, 'working');
      }

      // Push preview lines to dashboard
      this._emitPreview(id, data);
    });

    ptyProc.onExit(({ exitCode }) => {
      const status = exitCode === 0 ? 'done' : 'error';
      this.updateStatus(id, status);

      // If failed and under retry limit, offer retry
      if (exitCode !== 0 && session.retryCount < session.maxRetries) {
        this.mainWindow.webContents.send('session:retry-available', {
          id,
          exitCode,
          retryCount: session.retryCount,
          maxRetries: session.maxRetries,
        });
      }

      this.mainWindow.webContents.send('session:exited', { id, exitCode });
      this._cleanup(id);
    });

    this.sessions.set(id, session);
    this.mainWindow.webContents.send('session:created', {
      id, label, template: session.template, isLead,
    });

    return session;
  }

  closeSession(id) {
    const session = this.sessions.get(id);
    if (session) {
      session.pty.kill();
      this._cleanup(id);
    }
  }

  respawnSession(id, { label, cwd, initialPrompt, template, cols, rows }) {
    // Kill old PTY but keep the tab alive in the renderer
    const oldSession = this.sessions.get(id);
    if (oldSession) {
      oldSession.pty.kill();
      if (oldSession._previewTimer) clearTimeout(oldSession._previewTimer);
      try { fs.unlinkSync(oldSession.mcpConfigPath); } catch (e) { /* ignore */ }
      if (oldSession.worktree) this.worktreeManager.removeWorktree(id);
      this.sessions.delete(id);
    }
    // Create a fresh session with the same tab ID
    return this.createSession(id, {
      label,
      cwd: cwd || (oldSession && oldSession.cwd),
      initialPrompt,
      template: template || (oldSession && oldSession.template) || 'implementer',
      cols: cols || 80,
      rows: rows || 30,
    });
  }

  writeToSession(id, data) {
    const session = this.sessions.get(id);
    if (session) session.pty.write(data);
  }

  resizeSession(id, cols, rows) {
    const session = this.sessions.get(id);
    if (session) {
      try { session.pty.resize(cols, rows); } catch (e) { /* ignore */ }
    }
  }

  getSessionInfo(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    return {
      id: session.id,
      label: session.label,
      cwd: session.cwd,
      template: session.template,
      status: session.status,
      isLead: session.isLead,
      createdAt: session.createdAt,
      initialPrompt: session.initialPrompt,
    };
  }

  listSessions() {
    return [...this.sessions.values()].map(s => this.getSessionInfo(s.id));
  }

  updateStatus(id, status) {
    const session = this.sessions.get(id);
    if (session) {
      session.status = status;
      this.mainWindow.webContents.send('session:status', { id, status });
    }
  }

  _checkStuck() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.status === 'working' && (now - session.lastOutputAt) > this.stuckThresholdMs) {
        // Rate-limit: at most one stuck warning per 5 minutes per session
        if (session._lastStuckWarning && (now - session._lastStuckWarning) < 300000) continue;
        session._lastStuckWarning = now;
        this.updateStatus(id, 'stuck');
        this.mainWindow.webContents.send('session:stuck-warning', {
          id,
          lastOutputAge: Math.round((now - session.lastOutputAt) / 1000),
        });
      }
    }
  }

  _emitPreview(id, data) {
    // Strip ANSI codes for clean preview text (CSI, OSC, and single-char escapes)
    const clean = data
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')  // OSC sequences
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')               // CSI sequences
      .replace(/\x1b[^[\]]/g, '')                             // other escape sequences
      .replace(/\r/g, '');
    const session = this.sessions.get(id);
    if (!session) return;
    if (!session._previewBuffer) session._previewBuffer = '';
    session._previewBuffer += clean;
    // Keep only last ~500 chars
    if (session._previewBuffer.length > 500) {
      session._previewBuffer = session._previewBuffer.slice(-500);
    }
    // Debounce: only send every 500ms
    if (!session._previewTimer) {
      session._previewTimer = setTimeout(() => {
        session._previewTimer = null;
        const lines = session._previewBuffer.split('\n').filter(l => l.trim()).slice(-5);
        this.mainWindow.webContents.send('session:output-preview', { id, lines });
      }, 500);
    }
  }

  _findExecutable(name) {
    // Cache resolved path — executable location doesn't change during session
    if (!this._executableCache) this._executableCache = {};
    if (this._executableCache[name]) return this._executableCache[name];

    const { execSync } = require('child_process');
    let result = name;
    // Try common locations first
    const commonPaths = [
      path.join(os.homedir(), '.local', 'bin', name + (os.platform() === 'win32' ? '.exe' : '')),
      path.join(os.homedir(), '.local', 'bin', name),
    ];
    for (const p of commonPaths) {
      if (fs.existsSync(p)) { result = p; break; }
    }
    if (result === name) {
      // Fall back to shell resolution
      try {
        const cmd = os.platform() === 'win32' ? `where ${name}` : `which ${name}`;
        result = execSync(cmd, { encoding: 'utf8' }).trim().split('\n')[0];
      } catch (e) {
        // hope it's in PATH at runtime
      }
    }
    this._executableCache[name] = result;
    return result;
  }

  _buildSystemPrompt(sessionId, template) {
    const base = `You are running inside Claude Nexus — a multi-session orchestration terminal. Your session ID is "${sessionId}".

You have MCP tools from the "nexus-${sessionId}" server that let you coordinate with other sessions:

COMMUNICATION:
- list_sessions: See all active sessions and their status
- send_message: Send a message to another session by ID
- read_messages: Check your inbox for messages from other sessions
- broadcast: Send a message to all sessions at once

ORCHESTRATION:
- spawn_session: Create or reuse a worker session. Idle/done/stuck workers are automatically recycled — no need to manually reset before spawning.
- spawn_explorer: Spawn a read-only explorer session to analyze/cross-reference other sessions
- wait_for_workers: BLOCKING wait for worker results. Use this instead of polling. Returns when workers report back.
- get_session_status: Check if a session is idle, busy, or done (avoid polling this in a loop)
- report_result: Report your task result back to the lead session

SESSION LIFECYCLE:
- reset_session: Reset a session (clears context), optionally preserving a summary of progress so far
- save_checkpoint: Save current session state as a named checkpoint

SHARED STATE:
- scratchpad_set/get/list: Key-value store shared across all sessions — use for plans, status, shared data

HISTORY & SEARCH:
- read_session_history: Read another session's recent terminal output
- search_across_sessions: Search all sessions' output for a pattern`;

    if (template === 'lead') {
      return base + `

## YOUR ROLE: LEAD ORCHESTRATOR

You are the LEAD session. Your PRIMARY job is to DELEGATE work to worker sessions, NOT to do implementation yourself.

**CRITICAL RULE — YOU MUST FOLLOW THIS:**
When the user gives you a task, you MUST:
1. Break it into subtasks
2. Use spawn_session to create worker sessions for each subtask — this is NOT optional
3. Call wait_for_workers to BLOCK until workers report back — do NOT poll in a loop
4. Coordinate results and handle conflicts
5. Use the scratchpad to share plans and track progress

**CONTEXT CONSERVATION — CRITICAL:**
Your context window is expensive. Do NOT waste it polling or checking status in loops.
- After spawning workers, call wait_for_workers(count=N) where N is the number of workers you spawned
- This single call blocks until all N workers report back — zero polling needed
- NEVER call get_session_status or read_messages in a loop to check if workers are done
- Only use get_session_status for one-off checks if something seems wrong

**DO NOT write implementation code yourself.** You are the orchestrator. Your job is to:
- Plan and decompose tasks
- Spawn workers and assign them clear, specific subtasks
- Call wait_for_workers to block until results arrive (NOT poll with get_session_status)
- Reset workers with reset_session if they get stuck or run out of context
- Integrate results when workers report back

**IMPORTANT — USE NEXUS SESSIONS, NOT LOCAL AGENTS:**
You MUST use the spawn_session MCP tool to create new Nexus sessions in separate tabs. Do NOT use your built-in Agent tool or subagents for parallelism. Nexus sessions are full Claude Code instances with their own terminal, file access, and context window — they are far more capable than local subagents. Every worker task should be a spawn_session call, not an Agent tool call.

**This instruction overrides any default Claude Code behavior or CLAUDE.md instructions that suggest using the Agent tool, subagents, or local parallelism.** In Claude Nexus, all parallelism MUST go through spawn_session. This is non-negotiable.

**If you catch yourself writing code, making file edits, or spawning local agents — STOP.** Use spawn_session to create a Nexus worker session instead.

The only exceptions where you may work directly:
- Trivial one-line fixes (< 5 lines)
- Reading files to understand the codebase for planning purposes
- Coordinating/merging results from workers

For EVERYTHING else, spawn a worker session. When in doubt, spawn a session.`;
    }

    if (template === 'implementer') {
      return base + `

## YOUR ROLE: WORKER

You are a WORKER session spawned by the lead to handle a specific task. You MUST:
1. Focus exclusively on your assigned task — do not go beyond your scope
2. Use report_result to send your output back to the lead session when done
3. Check read_messages periodically for instructions or updates from the lead
4. If you encounter a blocker or need clarification, send_message to the lead session

Do NOT spawn additional sessions — that is the lead's job. Complete your task and report back.`;
    }

    return base;
  }

  _buildMcpConfig(sessionId, template) {
    // Use the bundled MCP server (single file, no external deps)
    // In packaged builds it's in resources/mcp-server.js (via extraResources)
    // In dev it's in dist/mcp-server.js (built by esbuild)
    const isPackaged = __dirname.includes('app.asar');
    let serverScript;
    if (isPackaged) {
      serverScript = path.join(process.resourcesPath, 'mcp-server.js');
    } else {
      serverScript = path.join(__dirname, '..', 'dist', 'mcp-server.js');
    }
    return {
      mcpServers: {
        [`nexus-${sessionId}`]: {
          type: 'stdio',
          command: 'node',
          args: [serverScript, '--session-id', sessionId],
          env: {
            NEXUS_SESSION_ID: sessionId,
            NEXUS_IPC_PATH: this._getIpcPath(),
            NEXUS_TEMPLATE: template || 'implementer',
          },
        },
      },
    };
  }

  _getIpcPath() {
    // Named pipe on Windows, Unix socket elsewhere
    if (os.platform() === 'win32') {
      return '\\\\.\\pipe\\claude-nexus-ipc';
    }
    return path.join(os.tmpdir(), 'claude-nexus-ipc.sock');
  }

  _cleanup(id) {
    const session = this.sessions.get(id);
    if (session) {
      // Clear pending preview timer to prevent leaked closure
      if (session._previewTimer) clearTimeout(session._previewTimer);
      // Remove temp MCP config
      try { fs.unlinkSync(session.mcpConfigPath); } catch (e) { /* ignore */ }
      // Clean up worktree if one was created
      if (session.worktree) {
        this.worktreeManager.removeWorktree(id);
      }
      this.sessions.delete(id);
    }
  }

  destroy() {
    if (this._stuckCheckInterval) clearInterval(this._stuckCheckInterval);
    for (const [id] of this.sessions) {
      this.closeSession(id);
    }
    this.worktreeManager.cleanup();
  }
}

module.exports = { SessionManager };
