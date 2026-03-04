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
    const mcpConfig = this._buildMcpConfig(id);
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    // Build claude CLI args
    const args = ['--mcp-config', mcpConfigPath];

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
        this.updateStatus(id, 'stuck');
        this.mainWindow.webContents.send('session:stuck-warning', {
          id,
          lastOutputAge: Math.round((now - session.lastOutputAt) / 1000),
        });
      }
    }
  }

  _emitPreview(id, data) {
    // Strip ANSI codes for clean preview text
    const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
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
    const { execSync } = require('child_process');
    // Try common locations first
    const commonPaths = [
      path.join(os.homedir(), '.local', 'bin', name + (os.platform() === 'win32' ? '.exe' : '')),
      path.join(os.homedir(), '.local', 'bin', name),
    ];
    for (const p of commonPaths) {
      if (fs.existsSync(p)) return p;
    }
    // Fall back to shell resolution
    try {
      const cmd = os.platform() === 'win32' ? `where ${name}` : `which ${name}`;
      return execSync(cmd, { encoding: 'utf8' }).trim().split('\n')[0];
    } catch (e) {
      return name; // hope it's in PATH at runtime
    }
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
- spawn_session: Create a new worker session with a specific task and working directory
- get_session_status: Check if a session is idle, busy, or done
- report_result: Report your result back (useful for workers)

SHARED STATE:
- scratchpad_set/get/list: Key-value store shared across all sessions — use for plans, status, shared data
- save_checkpoint: Save a named checkpoint of current progress

HISTORY & SEARCH:
- read_session_history: Read another session's recent terminal output
- search_across_sessions: Search all sessions' output for a pattern

Use these tools proactively when tasks would benefit from parallelism or coordination.`;

    if (template === 'lead') {
      return base + `

You are the LEAD session. You orchestrate work by:
1. Breaking complex tasks into subtasks
2. Spawning worker sessions for independent subtasks
3. Monitoring progress via get_session_status and read_messages
4. Coordinating results and handling conflicts
5. Using the scratchpad to share plans and state

When the user gives you a complex task, consider whether parts can be parallelized across sessions.`;
    }

    if (template === 'implementer') {
      return base + `

You are a WORKER session. You were spawned to handle a specific task. Focus on your assigned work, and use report_result to send your output back to the lead session when done. Check read_messages periodically for instructions.`;
    }

    return base;
  }

  _buildMcpConfig(sessionId) {
    // Point to the nexus MCP server script
    const serverScript = path.join(__dirname, '..', 'mcp-server', 'index.js');
    return {
      mcpServers: {
        [`nexus-${sessionId}`]: {
          type: 'stdio',
          command: 'node',
          args: [serverScript, '--session-id', sessionId],
          env: {
            NEXUS_SESSION_ID: sessionId,
            NEXUS_IPC_PATH: this._getIpcPath(),
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
