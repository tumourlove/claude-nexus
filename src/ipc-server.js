const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');

class IpcServer {
  constructor({ sessionManager, scratchpad, historyManager, conflictDetector, onSpawnRequest }) {
    this.sessionManager = sessionManager;
    this.scratchpad = scratchpad;
    this.historyManager = historyManager;
    this.conflictDetector = conflictDetector;
    this.onSpawnRequest = onSpawnRequest;
    this.clients = new Map(); // sessionId -> socket
    this.server = null;
  }

  getIpcPath() {
    if (os.platform() === 'win32') {
      return '\\\\.\\pipe\\claude-nexus-ipc';
    }
    return path.join(os.tmpdir(), 'claude-nexus-ipc.sock');
  }

  start() {
    const ipcPath = this.getIpcPath();

    this.server = net.createServer((socket) => {
      let sessionId = null;
      let buffer = '';

      socket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            sessionId = this._handleMessage(msg, socket, sessionId);
          } catch (e) {
            process.stderr.write(`IPC parse error: ${e.message}\n`);
          }
        }
      });

      socket.on('close', () => {
        if (sessionId) this.clients.delete(sessionId);
      });

      socket.on('error', () => {
        if (sessionId) this.clients.delete(sessionId);
      });
    });

    this.server.listen(ipcPath, () => {
      console.log(`IPC server listening on ${ipcPath}`);
    });

    this.server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // Clean up stale socket and retry (Unix only — pipes auto-clean on Windows)
        try { fs.unlinkSync(ipcPath); } catch (e) { /* ignore */ }
        this.server.listen(ipcPath);
      }
    });
  }

  _handleMessage(msg, socket, currentSessionId) {
    switch (msg.type) {
      case 'register':
        this.clients.set(msg.sessionId, socket);
        return msg.sessionId;

      case 'list_sessions': {
        const sessions = this.sessionManager.listSessions();
        this._reply(socket, { type: 'sessions', sessions });
        break;
      }

      case 'send_message': {
        const targetSocket = this.clients.get(msg.to);
        if (targetSocket) {
          this._reply(targetSocket, {
            type: 'message',
            from: msg.from,
            message: msg.message,
            priority: msg.priority,
          });
        }
        break;
      }

      case 'broadcast': {
        for (const [id, s] of this.clients) {
          if (id !== msg.from) {
            this._reply(s, { type: 'message', from: msg.from, message: msg.message, priority: 'normal' });
          }
        }
        break;
      }

      case 'spawn_session': {
        if (this.onSpawnRequest) {
          this.onSpawnRequest({
            cwd: msg.working_directory,
            initialPrompt: msg.initial_prompt,
            label: msg.label,
            template: msg.template,
            requestedBy: msg.from,
          });
        }
        break;
      }

      case 'report_result': {
        // Forward to lead session
        for (const [id, s] of this.clients) {
          const session = this.sessionManager.getSessionInfo(id);
          if (session && session.isLead) {
            this._reply(s, {
              type: 'message',
              from: msg.sessionId,
              message: `[RESULT ${msg.status}] ${msg.result}`,
              priority: 'urgent',
            });
          }
        }
        break;
      }

      case 'scratchpad_set':
        this.scratchpad.set(msg.key, msg.value, msg.namespace);
        break;

      case 'scratchpad_get': {
        const value = this.scratchpad.get(msg.key, msg.namespace);
        this._reply(socket, { type: 'scratchpad_value', key: msg.key, value });
        break;
      }

      case 'scratchpad_list': {
        const keys = this.scratchpad.list(msg.namespace);
        this._reply(socket, { type: 'scratchpad_keys', keys });
        break;
      }

      case 'read_session_history': {
        const output = this.historyManager.getRecentOutput(msg.targetSessionId, msg.lastNLines);
        this._reply(socket, { type: 'session_history', sessionId: msg.targetSessionId, output });
        break;
      }

      case 'search_sessions': {
        const results = this.historyManager.searchAcrossSessions(msg.pattern, msg.sessionIds);
        this._reply(socket, { type: 'search_results', results });
        break;
      }

      case 'reset_session': {
        // Save history, then tell session manager to respawn
        this.historyManager.saveToFile(msg.sessionId, 'pre-reset');
        break;
      }

      case 'save_checkpoint': {
        const filepath = this.historyManager.saveToFile(msg.sessionId, msg.label || 'checkpoint');
        this._reply(socket, { type: 'checkpoint_saved', filepath });
        break;
      }

      case 'get_session_status': {
        const session = this.sessionManager.getSessionInfo(msg.sessionId);
        this._reply(socket, { type: 'session_status', session });
        break;
      }

      case 'file_edit': {
        if (this.conflictDetector) {
          const conflicts = this.conflictDetector.checkConflict(msg.sessionId, msg.filepath);
          this.conflictDetector.recordEdit(msg.sessionId, msg.filepath);
          if (conflicts.length > 0) {
            // Warn the editing session
            this._reply(socket, {
              type: 'conflict_warning',
              filepath: msg.filepath,
              conflictingSessions: conflicts,
            });
            // Warn the other sessions too
            for (const otherId of conflicts) {
              const otherSocket = this.clients.get(otherId);
              if (otherSocket) {
                this._reply(otherSocket, {
                  type: 'conflict_warning',
                  filepath: msg.filepath,
                  conflictingSessions: [msg.sessionId],
                });
              }
            }
          }
        }
        break;
      }

      case 'get_session_files': {
        if (this.conflictDetector) {
          const files = this.conflictDetector.getSessionFiles(msg.sessionId);
          this._reply(socket, { type: 'session_files', sessionId: msg.sessionId, files });
        }
        break;
      }
    }

    return currentSessionId;
  }

  _reply(socket, data) {
    try {
      socket.write(JSON.stringify(data) + '\n');
    } catch (e) {
      // Socket may have closed
    }
  }

  stop() {
    if (this.server) this.server.close();
  }
}

module.exports = { IpcServer };
