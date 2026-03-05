const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');

class IpcServer {
  constructor({ sessionManager, scratchpad, historyManager, conflictDetector, taskQueue, onSpawnRequest }) {
    this.sessionManager = sessionManager;
    this.scratchpad = scratchpad;
    this.historyManager = historyManager;
    this.conflictDetector = conflictDetector;
    this.taskQueue = taskQueue;
    this.onSpawnRequest = onSpawnRequest;
    this.clients = new Map(); // sessionId -> socket
    this.server = null;
    this.results = new Map(); // sessionId -> { result, status, timestamp }
    this.spawnedWorkers = new Set(); // track worker session IDs
    this.heartbeats = new Map(); // sessionId -> { timestamp }
    this.knowledgeBase = null; // initialized when first session provides a cwd
    this.snippets = new Map(); // snippetId -> { filePath, startLine, endLine, label, from }
    this.snippetId = 0;
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
        const sessions = this.sessionManager.listSessions().map(s => ({
          ...s,
          health: this.getSessionHealth(s.id),
        }));
        this._reply(socket, { type: 'sessions', sessions, requestId: msg.requestId });
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
        // Try to reuse an idle/done/stuck worker session before spawning a new tab
        const allSessions = this.sessionManager.listSessions();
        const reusable = allSessions.find(s =>
          !s.isLead && (s.status === 'idle' || s.status === 'done' || s.status === 'stuck' || s.status === 'error')
        );
        if (reusable) {
          // Respawn in-place — reuses the existing tab
          this.sessionManager.respawnSession(reusable.id, {
            label: msg.label || reusable.label,
            cwd: msg.working_directory,
            initialPrompt: msg.initial_prompt,
            template: msg.template,
          });
          // Update tab label in renderer
          if (this.sessionManager.mainWindow) {
            this.sessionManager.mainWindow.webContents.send('session:relabeled', {
              id: reusable.id,
              label: msg.label || reusable.label,
            });
          }
        } else if (this.onSpawnRequest) {
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
        // Store result
        this.results.set(msg.sessionId, {
          result: msg.result,
          status: msg.status,
          timestamp: Date.now(),
        });

        // Store in scratchpad for persistence
        this.scratchpad.set(msg.sessionId, JSON.stringify({
          result: msg.result,
          status: msg.status,
          timestamp: Date.now(),
        }), '_results');

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

        // Notify renderer of result
        if (this.sessionManager.mainWindow) {
          this.sessionManager.mainWindow.webContents.send('session:result', {
            id: msg.sessionId,
            result: msg.result,
            status: msg.status,
            timestamp: Date.now(),
          });
        }

        // Check if all workers complete
        this.spawnedWorkers.add(msg.sessionId);
        const allSessions = this.sessionManager.listSessions();
        const workers = allSessions.filter(s => !s.isLead);
        const allDone = workers.length > 0 && workers.every(w => this.results.has(w.id));
        if (allDone && workers.length > 0) {
          const allResults = workers.map(w => ({
            id: w.id,
            label: w.label,
            ...this.results.get(w.id),
          }));
          this.sessionManager.mainWindow.webContents.send('workers:all-complete', { results: allResults });
          // Clear completed batch to free memory
          this.results.clear();
          this.spawnedWorkers.clear();
          this.scratchpad.clearNamespace('_results');
        }
        break;
      }

      case 'scratchpad_set':
        this.scratchpad.set(msg.key, msg.value, msg.namespace);
        break;

      case 'scratchpad_get': {
        const value = this.scratchpad.get(msg.key, msg.namespace);
        this._reply(socket, { type: 'scratchpad_value', key: msg.key, value, requestId: msg.requestId });
        break;
      }

      case 'scratchpad_list': {
        const keys = msg.include_values
          ? this.scratchpad.list(msg.namespace)
          : this.scratchpad.listKeys(msg.namespace);
        this._reply(socket, { type: 'scratchpad_keys', keys, requestId: msg.requestId });
        break;
      }

      case 'scratchpad_delete':
        this.scratchpad.delete(msg.key, msg.namespace);
        break;

      case 'read_session_history': {
        const output = this.historyManager.getRecentOutput(msg.targetSessionId, msg.lastNLines);
        this._reply(socket, { type: 'session_history', sessionId: msg.targetSessionId, output, requestId: msg.requestId });
        break;
      }

      case 'search_sessions': {
        const results = this.historyManager.searchAcrossSessions(msg.pattern, msg.sessionIds);
        this._reply(socket, { type: 'search_results', results, requestId: msg.requestId });
        break;
      }

      case 'reset_session': {
        // Save history, then kill and respawn the session
        this.historyManager.saveToFile(msg.sessionId, 'pre-reset');
        const sessionInfo = this.sessionManager.getSessionInfo(msg.sessionId);
        if (sessionInfo) {
          // Build a summary prompt if requested
          let respawnPrompt = sessionInfo.initialPrompt || '';
          if (msg.preserveSummary && respawnPrompt) {
            respawnPrompt = `[RESET] Continuing previous task. Original prompt: ${respawnPrompt}`;
          }
          // Kill the old session
          this.sessionManager.closeSession(msg.sessionId);
          // Respawn via the spawn request flow (creates new tab + session)
          if (this.onSpawnRequest) {
            this.onSpawnRequest({
              cwd: sessionInfo.cwd,
              initialPrompt: respawnPrompt,
              label: sessionInfo.label + ' (reset)',
              template: sessionInfo.template,
              requestedBy: currentSessionId,
            });
          }
        }
        break;
      }

      case 'save_checkpoint': {
        const filepath = this.historyManager.saveToFile(msg.sessionId, msg.label || 'checkpoint');
        this._reply(socket, { type: 'checkpoint_saved', filepath, requestId: msg.requestId });
        break;
      }

      case 'get_results': {
        const results = [];
        for (const [id, r] of this.results) {
          const session = this.sessionManager.getSessionInfo(id);
          results.push({ id, label: session?.label || id, ...r });
        }
        this._reply(socket, { type: 'results', results, requestId: msg.requestId });
        break;
      }

      case 'get_session_status': {
        const session = this.sessionManager.getSessionInfo(msg.sessionId);
        const health = this.getSessionHealth(msg.sessionId);
        this._reply(socket, { type: 'session_status', session: { ...session, health }, requestId: msg.requestId });
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
          this._reply(socket, { type: 'session_files', sessionId: msg.sessionId, files, requestId: msg.requestId });
        }
        break;
      }

      // --- Task Queue ---
      case 'task_push': {
        const taskId = this.taskQueue.push({
          title: msg.title,
          description: msg.description,
          priority: msg.priority,
          dependencies: msg.dependencies,
          createdBy: msg.createdBy,
        });
        this._reply(socket, { type: 'task_pushed', taskId, requestId: msg.requestId });
        // Notify dashboard
        if (this.sessionManager.mainWindow) {
          this.sessionManager.mainWindow.webContents.send('tasks:updated', { tasks: this.taskQueue.list() });
        }
        break;
      }

      case 'task_pull': {
        const task = this.taskQueue.pull(msg.sessionId);
        this._reply(socket, { type: 'task_pulled', task, requestId: msg.requestId });
        if (task && this.sessionManager.mainWindow) {
          this.sessionManager.mainWindow.webContents.send('tasks:updated', { tasks: this.taskQueue.list() });
        }
        break;
      }

      case 'task_update': {
        const task = this.taskQueue.update(msg.taskId, { status: msg.status, result: msg.result });
        this._reply(socket, { type: 'task_updated', task, requestId: msg.requestId });
        if (this.sessionManager.mainWindow) {
          this.sessionManager.mainWindow.webContents.send('tasks:updated', { tasks: this.taskQueue.list() });
        }
        break;
      }

      case 'task_list': {
        const tasks = this.taskQueue.list(msg.filter);
        this._reply(socket, { type: 'task_listed', tasks, requestId: msg.requestId });
        break;
      }

      // --- Snippets ---
      case 'share_snippet': {
        const snippetId = String(++this.snippetId);
        // Read the file content
        let content = '';
        try {
          const lines = fs.readFileSync(msg.filePath, 'utf8').split('\n');
          content = lines.slice(msg.startLine - 1, msg.endLine).join('\n');
        } catch (e) {
          content = `(error reading file: ${e.message})`;
        }
        this.snippets.set(snippetId, {
          filePath: msg.filePath,
          startLine: msg.startLine,
          endLine: msg.endLine,
          label: msg.label,
          from: msg.from,
          content,
        });
        // Store in scratchpad for persistence
        this.scratchpad.set(snippetId, JSON.stringify({
          filePath: msg.filePath,
          startLine: msg.startLine,
          endLine: msg.endLine,
          label: msg.label,
          from: msg.from,
        }), '_snippets');

        // Send to target or broadcast
        const snippetMsg = `[SNIPPET #${snippetId}] ${msg.label}\n${msg.filePath}:${msg.startLine}-${msg.endLine}\n${content}`;
        if (msg.target) {
          const targetSocket = this.clients.get(msg.target);
          if (targetSocket) {
            this._reply(targetSocket, { type: 'message', from: msg.from, message: snippetMsg, priority: 'normal' });
          }
        } else {
          for (const [id, s] of this.clients) {
            if (id !== msg.from) {
              this._reply(s, { type: 'message', from: msg.from, message: snippetMsg, priority: 'normal' });
            }
          }
        }
        this._reply(socket, { type: 'snippet_shared', snippetId, requestId: msg.requestId });
        break;
      }

      case 'get_snippet': {
        const snippet = this.snippets.get(msg.snippetId);
        if (snippet) {
          // Re-read fresh from disk
          let content = '';
          try {
            const lines = fs.readFileSync(snippet.filePath, 'utf8').split('\n');
            content = lines.slice(snippet.startLine - 1, snippet.endLine).join('\n');
          } catch (e) {
            content = snippet.content; // fallback to cached
          }
          this._reply(socket, {
            type: 'snippet_content',
            ...snippet,
            content,
            requestId: msg.requestId,
          });
        } else {
          this._reply(socket, { type: 'snippet_content', content: null, requestId: msg.requestId });
        }
        break;
      }

      // --- File Locking ---
      case 'claim_file': {
        const result = this.conflictDetector.claimFile(msg.sessionId, msg.filepath, msg.intent);
        this._reply(socket, { type: 'file_claimed', ...result, requestId: msg.requestId });
        // If conflict, notify the other session
        if (result.conflict) {
          const otherSocket = this.clients.get(result.lockedBy);
          if (otherSocket) {
            this._reply(otherSocket, {
              type: 'message',
              from: msg.sessionId,
              message: `[LOCK_CONFLICT] Session ${msg.sessionId} tried to claim ${msg.filepath} which you have locked`,
              priority: 'normal',
            });
          }
        }
        break;
      }

      case 'release_file': {
        const released = this.conflictDetector.releaseFile(msg.sessionId, msg.filepath);
        this._reply(socket, { type: 'file_released', released, requestId: msg.requestId });
        break;
      }

      case 'list_locks': {
        const locks = this.conflictDetector.listLocks();
        this._reply(socket, { type: 'locks_listed', locks, requestId: msg.requestId });
        break;
      }

      // --- Progress Streaming ---
      case 'stream_progress': {
        // Forward to lead sessions as a message (but NOT as a result, so it won't wake wait_for_workers)
        for (const [id, s] of this.clients) {
          const session = this.sessionManager.getSessionInfo(id);
          if (session && session.isLead) {
            this._reply(s, {
              type: 'message',
              from: msg.sessionId,
              message: `[PROGRESS${msg.percent !== undefined ? ` ${msg.percent}%` : ''}] ${msg.message}`,
              priority: 'normal',
            });
          }
        }
        // Notify renderer for dashboard progress bars
        if (this.sessionManager.mainWindow) {
          this.sessionManager.mainWindow.webContents.send('session:progress', {
            id: msg.sessionId,
            message: msg.message,
            percent: msg.percent,
          });
        }
        break;
      }

      // --- Knowledge Base ---
      case 'kb_add': {
        if (!this.knowledgeBase) {
          this._initKnowledgeBase();
        }
        if (this.knowledgeBase) {
          const entryId = this.knowledgeBase.add({
            title: msg.title,
            content: msg.content,
            category: msg.category,
            tags: msg.tags,
            createdBy: msg.createdBy,
          });
          this._reply(socket, { type: 'kb_added', entryId, requestId: msg.requestId });
        } else {
          this._reply(socket, { type: 'kb_added', entryId: null, error: 'No project directory set', requestId: msg.requestId });
        }
        break;
      }

      case 'kb_search': {
        if (!this.knowledgeBase) this._initKnowledgeBase();
        const results = this.knowledgeBase ? this.knowledgeBase.search(msg.query) : [];
        this._reply(socket, { type: 'kb_results', results, requestId: msg.requestId });
        break;
      }

      case 'kb_list': {
        if (!this.knowledgeBase) this._initKnowledgeBase();
        const entries = this.knowledgeBase ? this.knowledgeBase.list(msg.category) : [];
        this._reply(socket, { type: 'kb_entries', entries, requestId: msg.requestId });
        break;
      }

      case 'heartbeat': {
        this.heartbeats.set(msg.sessionId, { timestamp: msg.timestamp });
        if (this.sessionManager.mainWindow) {
          this.sessionManager.mainWindow.webContents.send('session:heartbeat', {
            id: msg.sessionId,
            health: 'healthy',
          });
        }
        break;
      }
    }

    return currentSessionId;
  }

  sendToSession(sessionId, data) {
    const socket = this.clients.get(sessionId);
    if (socket) this._reply(socket, data);
  }

  getSessionHealth(sessionId) {
    const hb = this.heartbeats.get(sessionId);
    if (!hb) return 'unknown';
    const age = Date.now() - hb.timestamp;
    if (age < 15000) return 'healthy';
    if (age < 30000) return 'slow';
    return 'unresponsive';
  }

  _initKnowledgeBase() {
    // Use the first session's cwd as the project directory
    const sessions = this.sessionManager.listSessions();
    const leadSession = sessions.find(s => s.isLead) || sessions[0];
    if (leadSession && leadSession.cwd) {
      const { KnowledgeBase } = require('./knowledge-base');
      this.knowledgeBase = new KnowledgeBase(leadSession.cwd);
    }
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
