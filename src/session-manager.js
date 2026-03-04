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
  }

  createSession(id, { label, cwd, initialPrompt, template, isLead = false, useWorktree = false }) {
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
    if (initialPrompt) {
      args.push('--', initialPrompt);
    }

    // Resolve claude executable path — Electron may not inherit full shell PATH
    const claudePath = this._findExecutable('claude');

    const ptyProc = pty.spawn(claudePath, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 30,
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
    };

    ptyProc.onData((data) => {
      this.mainWindow.webContents.send(`terminal:data:${id}`, data);
      if (this.onOutput) this.onOutput(id, data);
    });

    ptyProc.onExit(({ exitCode }) => {
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
    for (const [id] of this.sessions) {
      this.closeSession(id);
    }
    this.worktreeManager.cleanup();
  }
}

module.exports = { SessionManager };
