const pty = require('node-pty');
const fs = require('fs');
const path = require('path');
const os = require('os');

class SessionManager {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.sessions = new Map();
    this.configDir = path.join(os.homedir(), '.claude-nexus', 'configs');
    fs.mkdirSync(this.configDir, { recursive: true });
    this.onOutput = null; // set by main.js
  }

  createSession(id, { label, cwd, initialPrompt, template, isLead = false }) {
    const resolvedCwd = cwd || process.argv[2] || process.env.USERPROFILE || process.env.HOME;

    // Write temporary MCP config for this session
    const mcpConfigPath = path.join(this.configDir, `mcp-${id}.json`);
    const mcpConfig = this._buildMcpConfig(id);
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    // Build claude CLI args
    const args = ['--mcp-config', mcpConfigPath];
    if (initialPrompt) {
      args.push('--', initialPrompt);
    }

    const ptyProc = pty.spawn('claude', args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 30,
      cwd: resolvedCwd,
      env: { ...process.env },
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
      this.sessions.delete(id);
    }
  }

  destroy() {
    for (const [id] of this.sessions) {
      this.closeSession(id);
    }
  }
}

module.exports = { SessionManager };
