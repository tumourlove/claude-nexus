const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { EventBus } = require('./event-bus');
const { ReviewManager } = require('./review-manager');
const { ConsensusManager } = require('./consensus-manager');
const { SessionMemory } = require('./session-memory');
const { KnowledgeGraph } = require('./knowledge-graph');
const { Logger } = require('./logger');

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
    this.knowledgeGraph = null; // initialized alongside knowledgeBase
    this.snippets = new Map(); // snippetId -> { filePath, startLine, endLine, label, from }
    this.snippetId = 0;
    // Main branch: session stats (connectedAt, messagesSent, messagesReceived, toolCalls)
    this.sessionStats = new Map();
    // W9: message ack tracking + context estimation
    this.nextMessageId = 0;
    this.pendingAcks = new Map(); // messageId -> { resolve, timer }
    // W10: event pub/sub
    this.eventBus = new EventBus();
    // W12: code review + consensus
    this.reviewManager = new ReviewManager();
    this.consensusManager = new ConsensusManager();
    // Adaptive templates: per-session tool overrides
    this.toolOverrides = new Map(); // sessionId -> { added: Set, removed: Set }
    // Emergent task discovery: proposals
    this.proposals = []; // { id, proposer, title, description, justification, urgency, status, comment, taskId, timestamp }
    this.nextProposalId = 0;
    // Persistent session memory
    this.sessionMemory = new SessionMemory();

    // W10: Wire up conflict detector to publish file events
    if (this.conflictDetector) {
      this.conflictDetector.onEvent = (channel, data, sourceSessionId) => {
        this._publishEvent(channel, data, sourceSessionId);
      };
    }
  }

  // W9: track output bytes for context estimation
  trackOutput(sessionId, data) {
    const stats = this.sessionStats.get(sessionId);
    if (stats) {
      if (!stats.outputBytes) stats.outputBytes = 0;
      stats.outputBytes += Buffer.byteLength(data);
    }
  }

  // W9: context window usage estimate
  getContextEstimate(sessionId) {
    const stats = this.sessionStats.get(sessionId) || {};
    const outputBytes = stats.outputBytes || 0;
    const estimatedPercent = Math.min(100, Math.round(outputBytes / 128000 * 100));
    let level;
    if (estimatedPercent < 40) level = 'low';
    else if (estimatedPercent < 65) level = 'medium';
    else if (estimatedPercent < 85) level = 'high';
    else level = 'critical';
    return {
      output_bytes: outputBytes,
      estimated_context_percent: estimatedPercent,
      level,
    };
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
        if (sessionId) {
          this.clients.delete(sessionId);
          if (this.conflictDetector) this.conflictDetector.clearSession(sessionId);
          // W10: cleanup event subscriptions + publish close event
          this.eventBus.unsubscribeAll(sessionId);
          this._publishEvent('session:closed', { sessionId }, sessionId);
        }
      });

      socket.on('error', (err) => {
        if (sessionId) {
          Logger.warn('ipc-server', 'socket.error', `Socket error for ${sessionId}: ${err.message}`);
          this.clients.delete(sessionId);
          if (this.conflictDetector) this.conflictDetector.clearSession(sessionId);
          this.eventBus.unsubscribeAll(sessionId);
          // Attempt reconnection with exponential backoff
          this._attemptReconnect(sessionId);
        }
      });
    });

    this.server.listen(ipcPath, () => {
      Logger.info('ipc-server', 'start', `IPC server listening on ${ipcPath}`);
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
    // Track tool calls per session (skip register/heartbeat)
    if (msg.type !== 'register' && msg.type !== 'heartbeat') {
      const callerId = msg.from || msg.sessionId || currentSessionId;
      if (callerId) {
        const stats = this.sessionStats.get(callerId);
        if (stats) stats.toolCalls++;
      }
    }

    switch (msg.type) {
      case 'register':
        this.clients.set(msg.sessionId, socket);
        if (!this.sessionStats.has(msg.sessionId)) {
          this.sessionStats.set(msg.sessionId, {
            connectedAt: Date.now(),
            messagesSent: 0,
            messagesReceived: 0,
            toolCalls: 0,
            outputBytes: 0,
          });
        }
        return msg.sessionId;

      case 'list_sessions': {
        const sessions = this.sessionManager.listSessions().map(s => ({
          ...s,
          health: this.getSessionHealth(s.id),
        }));
        this._reply(socket, { type: 'sessions', sessions, requestId: msg.requestId });
        break;
      }

      // W9: enhanced send_message with messageId, structured fields, and ack
      case 'send_message': {
        const targetSocket = this.clients.get(msg.to);
        const messageId = ++this.nextMessageId;
        const payload = {
          type: 'message',
          from: msg.from,
          message: msg.message,
          priority: msg.priority,
          messageId,
        };
        // Forward structured fields if present (W9)
        if (msg.msgType) payload.msgType = msg.msgType;
        if (msg.subject) payload.subject = msg.subject;
        if (msg.data) payload.data = msg.data;

        if (targetSocket) {
          this._reply(targetSocket, payload);
          const targetStats = this.sessionStats.get(msg.to);
          if (targetStats) targetStats.messagesReceived++;
          // Wait for ack with 3s timeout
          if (msg.requestId) {
            const ackPromise = new Promise((resolve) => {
              const timer = setTimeout(() => {
                this.pendingAcks.delete(messageId);
                resolve({ delivered: false, reason: 'timeout' });
              }, 3000);
              this.pendingAcks.set(messageId, { resolve, timer });
            });
            ackPromise.then((result) => {
              this._reply(socket, { type: 'message_sent', ...result, requestId: msg.requestId });
            });
          }
        } else {
          if (msg.requestId) {
            this._reply(socket, { type: 'message_sent', delivered: false, reason: 'session not connected', requestId: msg.requestId });
          }
        }
        const senderStats = this.sessionStats.get(msg.from);
        if (senderStats) senderStats.messagesSent++;
        if (this.sessionManager.mainWindow) {
          this.sessionManager.mainWindow.webContents.send('chat:message', {
            from: msg.from,
            message: msg.subject ? `[${msg.msgType || 'info'}] ${msg.subject}: ${msg.message}` : msg.message,
            priority: msg.priority,
          });
        }
        break;
      }

      // W9: ack handler
      case 'ack': {
        const pending = this.pendingAcks.get(msg.messageId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingAcks.delete(msg.messageId);
          pending.resolve({ delivered: true });
        }
        break;
      }

      case 'broadcast': {
        for (const [id, s] of this.clients) {
          if (id !== msg.from) {
            this._reply(s, { type: 'message', from: msg.from, message: msg.message, priority: 'normal' });
          }
        }
        if (this.sessionManager.mainWindow) {
          this.sessionManager.mainWindow.webContents.send('chat:message', {
            from: msg.from,
            message: msg.message,
            priority: 'normal',
          });
        }
        break;
      }

      case 'spawn_session': {
        // Try to reuse an idle/done/stuck worker session before spawning a new tab
        const allSessions = this.sessionManager.listSessions();
        const reusable = allSessions.find(s =>
          !s.isLead && (s.status === 'idle' || s.status === 'done' || s.status === 'stuck' || s.status === 'error')
        );
        let spawnedId = null;
        if (reusable) {
          spawnedId = reusable.id;
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
          // W10: publish spawn event
          this._publishEvent('session:spawned', { sessionId: reusable.id, label: msg.label || reusable.label, reused: true }, msg.from);
        } else if (this.onSpawnRequest) {
          // onSpawnRequest returns the new session ID
          spawnedId = this.onSpawnRequest({
            cwd: msg.working_directory,
            initialPrompt: msg.initial_prompt,
            label: msg.label,
            template: msg.template,
            requestedBy: msg.from,
          });
          this._publishEvent('session:spawned', { sessionId: spawnedId, label: msg.label, template: msg.template }, msg.from);
        }
        if (msg.requestId) {
          this._reply(socket, { type: 'session_spawned', sessionId: spawnedId, requestId: msg.requestId });
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

        // Forward structured worker result to lead sessions
        for (const [id, s] of this.clients) {
          const session = this.sessionManager.getSessionInfo(id);
          if (session && session.isLead) {
            this._reply(s, {
              type: 'worker_result',
              from: msg.sessionId,
              status: msg.status,
              result: msg.result,
              timestamp: Date.now(),
            });
            // Also send as regular message for chat display
            this._reply(s, {
              type: 'message',
              from: msg.sessionId,
              message: `[RESULT ${msg.status}] ${msg.result}`,
              priority: 'urgent',
            });
          }
        }

        // Forward to chat panel
        if (this.sessionManager.mainWindow) {
          this.sessionManager.mainWindow.webContents.send('chat:message', {
            from: msg.sessionId,
            message: `[RESULT ${msg.status}] ${msg.result}`,
            priority: 'urgent',
          });
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
        // W10: publish task:completed event
        if (msg.status === 'done' && task) {
          this._publishEvent('task:completed', { taskId: msg.taskId, title: task.title, result: msg.result }, currentSessionId);
        }
        break;
      }

      case 'task_list': {
        const tasks = this.taskQueue.list(msg.filter);
        this._reply(socket, { type: 'task_listed', tasks, requestId: msg.requestId });
        break;
      }

      case 'task_graph': {
        const graph = this.taskQueue.getGraph();
        this._reply(socket, { type: 'task_graph', graph, requestId: msg.requestId });
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

      // --- Knowledge Graph ---
      case 'kg_add_entity': {
        if (!this.knowledgeGraph) this._initKnowledgeBase();
        if (this.knowledgeGraph) {
          const entityId = this.knowledgeGraph.addEntity(msg.entityType, msg.name, msg.properties, msg.sessionId);
          this._reply(socket, { type: 'kg_entity_added', entityId, requestId: msg.requestId });
        } else {
          this._reply(socket, { type: 'kg_entity_added', entityId: null, error: 'No project directory set', requestId: msg.requestId });
        }
        break;
      }

      case 'kg_add_relationship': {
        if (!this.knowledgeGraph) this._initKnowledgeBase();
        if (this.knowledgeGraph) {
          const relId = this.knowledgeGraph.addRelationship(msg.fromEntity, msg.toEntity, msg.relType, msg.properties, msg.sessionId);
          this._reply(socket, { type: 'kg_relationship_added', relId, requestId: msg.requestId });
        } else {
          this._reply(socket, { type: 'kg_relationship_added', relId: null, error: 'No project directory set', requestId: msg.requestId });
        }
        break;
      }

      case 'kg_query': {
        if (!this.knowledgeGraph) this._initKnowledgeBase();
        if (this.knowledgeGraph) {
          let result;
          if (msg.entityId) {
            result = this.knowledgeGraph.queryRelationships(msg.entityId);
          } else {
            result = this.knowledgeGraph.queryEntities({
              type: msg.entityType,
              namePattern: msg.namePattern,
              sessionId: msg.filterSessionId,
            });
          }
          this._reply(socket, { type: 'kg_query_result', result, requestId: msg.requestId });
        } else {
          this._reply(socket, { type: 'kg_query_result', result: [], requestId: msg.requestId });
        }
        break;
      }

      case 'kg_traverse': {
        if (!this.knowledgeGraph) this._initKnowledgeBase();
        const traversal = this.knowledgeGraph
          ? this.knowledgeGraph.traverse(msg.entityId, msg.maxDepth || 2)
          : { entities: [], relationships: [] };
        this._reply(socket, { type: 'kg_traversal', ...traversal, requestId: msg.requestId });
        break;
      }

      case 'kg_export': {
        if (!this.knowledgeGraph) this._initKnowledgeBase();
        const graph = this.knowledgeGraph
          ? this.knowledgeGraph.exportGraph()
          : { entities: [], relationships: [] };
        this._reply(socket, { type: 'kg_graph', ...graph, requestId: msg.requestId });
        break;
      }

      // --- Context Handoffs ---
      case 'request_handoff': {
        // Send message to target session asking it to summarize
        const targetSocket = this.clients.get(msg.targetSessionId);
        if (targetSocket) {
          this._reply(targetSocket, {
            type: 'message',
            from: msg.requestedBy,
            message: `[HANDOFF_REQUEST] Please prepare for context handoff. Reason: ${msg.reason}. ` +
              `Call report_handoff with: summary (2-3 sentences of progress), files_modified, remaining_work, and key_findings. ` +
              `Your session will be reset with full context preserved.`,
            priority: 'urgent',
          });
        }
        break;
      }

      case 'report_handoff': {
        const session = this.sessionManager.getSessionInfo(msg.sessionId);
        if (!session) break;

        // Store handoff in knowledge base if available
        if (this.knowledgeBase) {
          this.knowledgeBase.add({
            title: `Handoff: ${session.label || msg.sessionId}`,
            content: `Summary: ${msg.summary}\nFiles: ${msg.filesModified.join(', ')}\nRemaining: ${msg.remainingWork}\nFindings: ${msg.keyFindings.join('; ')}`,
            category: 'decision',
            tags: ['handoff', msg.sessionId],
            createdBy: msg.sessionId,
          });
        }

        // Build handoff prompt and respawn
        const handoffPrompt = `[CONTEXT HANDOFF] You are continuing a previous session's work.\n` +
          `Summary: ${msg.summary}\n` +
          `Files modified: ${msg.filesModified.join(', ') || 'none'}\n` +
          `Remaining work: ${msg.remainingWork || 'not specified'}\n` +
          `Key findings: ${msg.keyFindings.join('; ') || 'none'}\n\n` +
          `Original task: ${session.initialPrompt || 'unknown'}`;

        // Kill and respawn
        this.sessionManager.respawnSession(msg.sessionId, {
          label: session.label,
          cwd: session.cwd,
          initialPrompt: handoffPrompt,
          template: session.template,
        });
        break;
      }

      // --- Git Worktrees ---
      case 'merge_worktree': {
        const result = this.sessionManager.worktreeManager
          ? this.sessionManager.worktreeManager.mergeWorktree(msg.sessionId, msg.strategy)
          : { success: false, error: 'Worktree manager not available' };
        this._reply(socket, { type: 'worktree_merged', ...result, requestId: msg.requestId });
        break;
      }

      case 'list_worktrees': {
        const worktrees = this.sessionManager.worktreeManager
          ? this.sessionManager.worktreeManager.listWorktrees()
          : [];
        this._reply(socket, { type: 'worktrees_listed', worktrees, requestId: msg.requestId });
        break;
      }

      // --- Batch Scratchpad ---
      case 'batch_scratchpad': {
        const result = this.scratchpad.batchOps(msg.set, msg.get, msg.namespace);
        this._reply(socket, { type: 'batch_scratchpad_result', ...result, requestId: msg.requestId });
        break;
      }

      // --- Scratchpad Compare-and-Swap ---
      case 'scratchpad_cas': {
        const result = this.scratchpad.compareAndSwap(msg.key, msg.expected, msg.new_value, msg.namespace);
        this._reply(socket, { type: 'scratchpad_cas_result', ...result, requestId: msg.requestId });
        break;
      }

      // --- Worker Diff ---
      case 'get_worker_diff': {
        let diff = '';
        let error = null;
        const worktree = this.sessionManager.worktreeManager
          ? this.sessionManager.worktreeManager.getWorktree(msg.sessionId)
          : null;
        if (worktree) {
          try {
            diff = execSync('git diff', { cwd: worktree.path, encoding: 'utf8', timeout: 15000 });
          } catch (e) {
            error = e.message;
          }
        } else {
          // Fallback: use session's cwd
          const session = this.sessionManager.getSessionInfo(msg.sessionId);
          if (session && session.cwd) {
            try {
              diff = execSync('git diff', { cwd: session.cwd, encoding: 'utf8', timeout: 15000 });
            } catch (e) {
              error = e.message;
            }
          } else {
            error = `No worktree or cwd found for session ${msg.sessionId}`;
          }
        }
        this._reply(socket, { type: 'worker_diff', diff, error, requestId: msg.requestId });
        break;
      }

      // --- Git Status ---
      case 'query_git_status': {
        const session = this.sessionManager.getSessionInfo(msg.sessionId);
        const cwd = session && session.cwd ? session.cwd : process.cwd();
        try {
          const opts = { cwd, encoding: 'utf8', timeout: 15000 };
          const branch = execSync('git rev-parse --abbrev-ref HEAD', opts).trim();
          // Get tracking branch
          let baseBranch = 'master';
          try {
            baseBranch = execSync(`git rev-parse --abbrev-ref ${branch}@{upstream}`, opts).trim();
          } catch (e) { Logger.info('ipc-server', 'query_git_status', `No upstream for branch: ${e.message}`); }
          // Changed files
          const statusRaw = execSync('git status --porcelain', opts).trim();
          const changedFiles = statusRaw ? statusRaw.split('\n').map(line => ({
            status: line.substring(0, 2).trim(),
            path: line.substring(3),
          })) : [];
          // Ahead/behind
          let ahead = 0, behind = 0;
          try {
            const counts = execSync(`git rev-list --left-right --count ${branch}...${baseBranch}`, opts).trim();
            const parts = counts.split(/\s+/);
            ahead = parseInt(parts[0]) || 0;
            behind = parseInt(parts[1]) || 0;
          } catch (e) { Logger.info('ipc-server', 'query_git_status', `Could not get ahead/behind counts: ${e.message}`); }
          this._reply(socket, {
            type: 'git_status',
            branch, baseBranch, changedFiles, ahead, behind,
            requestId: msg.requestId,
          });
        } catch (e) {
          this._reply(socket, { type: 'git_status', error: e.message, requestId: msg.requestId });
        }
        break;
      }

      // --- Session Info ---
      case 'session_info': {
        const session = this.sessionManager.getSessionInfo(msg.sessionId);
        const stats = this.sessionStats.get(msg.sessionId) || {
          connectedAt: Date.now(), messagesSent: 0, messagesReceived: 0, toolCalls: 0,
        };
        const uptimeSeconds = Math.floor((Date.now() - stats.connectedAt) / 1000);
        this._reply(socket, {
          type: 'session_info_result',
          session_id: msg.sessionId,
          uptime_seconds: uptimeSeconds,
          messages_sent: stats.messagesSent,
          messages_received: stats.messagesReceived,
          tool_calls_made: stats.toolCalls,
          template: (session && session.template) || 'unknown',
          requestId: msg.requestId,
        });
        break;
      }

      // W9: context_estimate handler
      case 'context_estimate': {
        const estimate = this.getContextEstimate(msg.sessionId);
        this._reply(socket, { type: 'context_estimate', ...estimate, requestId: msg.requestId });
        break;
      }

      // W10: Event Pub/Sub handlers
      case 'subscribe': {
        this.eventBus.subscribe(currentSessionId, msg.channelPattern);
        this._reply(socket, { type: 'subscribed', channelPattern: msg.channelPattern, requestId: msg.requestId });
        break;
      }

      case 'unsubscribe': {
        this.eventBus.unsubscribe(currentSessionId, msg.channelPattern);
        this._reply(socket, { type: 'unsubscribed', channelPattern: msg.channelPattern, requestId: msg.requestId });
        break;
      }

      case 'publish': {
        this._publishEvent(msg.channel, msg.data, currentSessionId);
        this._reply(socket, { type: 'published', channel: msg.channel, requestId: msg.requestId });
        break;
      }

      // W11: Batch Spawn handler
      case 'batch-spawn': {
        const spawned = [];
        for (const w of (msg.workers || [])) {
          const allSessions = this.sessionManager.listSessions();
          const reusable = allSessions.find(s =>
            !s.isLead && (s.status === 'idle' || s.status === 'done' || s.status === 'stuck' || s.status === 'error')
            && !spawned.some(sp => sp.id === s.id)
          );
          if (reusable) {
            this.sessionManager.respawnSession(reusable.id, {
              label: w.label || 'Worker',
              cwd: w.cwd,
              initialPrompt: w.prompt,
              template: w.template || 'implementer',
            });
            if (this.sessionManager.mainWindow) {
              this.sessionManager.mainWindow.webContents.send('session:relabeled', {
                id: reusable.id,
                label: w.label || 'Worker',
              });
            }
            spawned.push({ id: reusable.id, label: w.label || 'Worker' });
          } else if (this.onSpawnRequest) {
            const newId = this.onSpawnRequest({
              cwd: w.cwd,
              initialPrompt: w.prompt,
              label: w.label || 'Worker',
              template: w.template || 'implementer',
              requestedBy: msg.from,
            });
            spawned.push({ id: newId || '(pending)', label: w.label || 'Worker' });
          }
        }
        this._reply(socket, { type: 'batch_spawned', spawned, requestId: msg.requestId });
        break;
      }

      // W11: Conflict Resolution handler
      case 'resolve_conflicts': {
        const result = this.sessionManager.worktreeManager
          ? this.sessionManager.worktreeManager.resolveConflicts(msg.sessionId, msg.resolutions)
          : { success: false, error: 'Worktree manager not available' };
        this._reply(socket, { type: 'conflicts_resolved', ...result, requestId: msg.requestId });
        break;
      }

      // W12: Code Review handlers
      case 'review_submit': {
        try {
          const reviewId = this.reviewManager.submitForReview(msg.submitter, {
            files: msg.files,
            description: msg.description,
          });
          this._reply(socket, { type: 'review_submitted', reviewId, requestId: msg.requestId });
        } catch (e) {
          this._reply(socket, { type: 'review_submitted', reviewId: null, error: e.message, requestId: msg.requestId });
        }
        break;
      }

      case 'review_claim': {
        try {
          const review = this.reviewManager.claimReview(msg.reviewerId, msg.reviewId);
          this._reply(socket, { type: 'review_claimed', review, requestId: msg.requestId });
        } catch (e) {
          this._reply(socket, { type: 'review_claimed', review: null, error: e.message, requestId: msg.requestId });
        }
        break;
      }

      case 'review_approve': {
        try {
          const review = this.reviewManager.approveReview(msg.reviewerId, msg.reviewId, msg.comment);
          this._reply(socket, { type: 'review_approved', review, requestId: msg.requestId });
          // Notify submitter
          const submitterSocket = this.clients.get(review.submitter);
          if (submitterSocket) {
            this._reply(submitterSocket, {
              type: 'message',
              from: msg.reviewerId,
              message: `[REVIEW APPROVED] Review ${msg.reviewId} approved${msg.comment ? ': ' + msg.comment : ''}`,
              priority: 'normal',
            });
          }
        } catch (e) {
          this._reply(socket, { type: 'review_approved', review: null, error: e.message, requestId: msg.requestId });
        }
        break;
      }

      case 'review_request_changes': {
        try {
          const review = this.reviewManager.requestChanges(msg.reviewerId, msg.reviewId, msg.comments);
          this._reply(socket, { type: 'review_changes_requested', review, requestId: msg.requestId });
          // Notify submitter
          const submitterSocket = this.clients.get(review.submitter);
          if (submitterSocket) {
            const commentSummary = msg.comments.map(c => `  ${c.file}:${c.line} — ${c.comment}`).join('\n');
            this._reply(submitterSocket, {
              type: 'message',
              from: msg.reviewerId,
              message: `[CHANGES REQUESTED] Review ${msg.reviewId}:\n${commentSummary}`,
              priority: 'urgent',
            });
          }
        } catch (e) {
          this._reply(socket, { type: 'review_changes_requested', review: null, error: e.message, requestId: msg.requestId });
        }
        break;
      }

      case 'review_list': {
        const reviews = this.reviewManager.listReviews(msg.status);
        this._reply(socket, { type: 'review_listed', reviews, requestId: msg.requestId });
        break;
      }

      case 'review_get': {
        const review = this.reviewManager.getReview(msg.reviewId);
        this._reply(socket, { type: 'review_detail', review, requestId: msg.requestId });
        break;
      }

      // W12: Consensus Decision handlers
      case 'decision_propose': {
        try {
          const decisionId = this.consensusManager.proposeDecision(msg.proposer, {
            topic: msg.topic,
            options: msg.options,
            description: msg.description,
          });
          this._reply(socket, { type: 'decision_proposed', decisionId, requestId: msg.requestId });
          // Broadcast to all sessions
          for (const [id, s] of this.clients) {
            if (id !== msg.proposer) {
              this._reply(s, {
                type: 'message',
                from: msg.proposer,
                message: `[DECISION PROPOSED] "${msg.topic}" — Options: ${msg.options.join(', ')}. Use vote tool with decision_id="${decisionId}" to cast your vote.`,
                priority: 'normal',
              });
            }
          }
        } catch (e) {
          this._reply(socket, { type: 'decision_proposed', decisionId: null, error: e.message, requestId: msg.requestId });
        }
        break;
      }

      case 'decision_vote': {
        try {
          const decision = this.consensusManager.vote(msg.sessionId, msg.decisionId, {
            choice: msg.choice,
            reasoning: msg.reasoning,
          });
          this._reply(socket, { type: 'decision_voted', decision, requestId: msg.requestId });
        } catch (e) {
          this._reply(socket, { type: 'decision_voted', decision: null, error: e.message, requestId: msg.requestId });
        }
        break;
      }

      case 'decision_resolve': {
        try {
          const decision = this.consensusManager.resolveDecision(msg.decisionId, msg.winningOption);
          this._reply(socket, { type: 'decision_resolved', decision, requestId: msg.requestId });
          // Broadcast result
          for (const [id, s] of this.clients) {
            this._reply(s, {
              type: 'message',
              from: 'system',
              message: `[DECISION RESOLVED] "${decision.topic}" → ${decision.resolvedOption}`,
              priority: 'normal',
            });
          }
        } catch (e) {
          this._reply(socket, { type: 'decision_resolved', decision: null, error: e.message, requestId: msg.requestId });
        }
        break;
      }

      case 'decision_list': {
        const decisions = this.consensusManager.listDecisions(msg.status);
        this._reply(socket, { type: 'decision_listed', decisions, requestId: msg.requestId });
        break;
      }

      case 'decision_get': {
        const decision = this.consensusManager.getDecision(msg.decisionId);
        this._reply(socket, { type: 'decision_detail', decision, requestId: msg.requestId });
        break;
      }

      // --- Session Memory ---
      case 'session_remember': {
        const session = this.sessionManager.getSessionInfo(msg.sessionId);
        const projectPath = msg.projectPath || (session && session.cwd) || null;
        const entryId = this.sessionMemory.addEntry(msg.sessionId, {
          type: msg.entryType,
          content: msg.content,
          tags: msg.tags,
          projectPath,
        });
        this._reply(socket, { type: 'memory_added', entryId, requestId: msg.requestId });
        break;
      }

      case 'session_recall': {
        const session = this.sessionManager.getSessionInfo(msg.sessionId);
        const projectPath = msg.projectPath || (session && session.cwd) || null;
        const entries = this.sessionMemory.getRelevant(projectPath, msg.tags, msg.limit);
        this._reply(socket, { type: 'memory_results', entries, requestId: msg.requestId });
        break;
      }

      case 'session_lineage': {
        const session = this.sessionManager.getSessionInfo(msg.sessionId);
        const projectPath = msg.projectPath || (session && session.cwd) || null;
        const entries = this.sessionMemory.getTaskLineage(msg.taskDescription, projectPath);
        this._reply(socket, { type: 'memory_lineage', entries, requestId: msg.requestId });
        break;
      }

      // --- Adaptive Templates ---
      case 'promote_session': {
        // Lead-only check
        const promoterSession = this.sessionManager.getSessionInfo(msg.requestedBy);
        if (!promoterSession || !promoterSession.isLead) {
          this._reply(socket, { type: 'promoted', error: 'Only the lead session can promote sessions', requestId: msg.requestId });
          break;
        }
        const overrides = this.toolOverrides.get(msg.targetSessionId) || { added: new Set(), removed: new Set() };
        for (const tool of msg.addTools) {
          overrides.added.add(tool);
          overrides.removed.delete(tool); // un-demote if previously removed
        }
        this.toolOverrides.set(msg.targetSessionId, overrides);
        // Push overrides to the target session's MCP server
        const promoteSocket = this.clients.get(msg.targetSessionId);
        if (promoteSocket) {
          this._reply(promoteSocket, {
            type: 'tool_overrides_update',
            added: [...overrides.added],
            removed: [...overrides.removed],
          });
        }
        this._reply(socket, { type: 'promoted', requestId: msg.requestId });
        break;
      }

      case 'demote_session': {
        const demoterSession = this.sessionManager.getSessionInfo(msg.requestedBy);
        if (!demoterSession || !demoterSession.isLead) {
          this._reply(socket, { type: 'demoted', error: 'Only the lead session can demote sessions', requestId: msg.requestId });
          break;
        }
        const dOverrides = this.toolOverrides.get(msg.targetSessionId) || { added: new Set(), removed: new Set() };
        for (const tool of msg.removeTools) {
          dOverrides.removed.add(tool);
          dOverrides.added.delete(tool); // un-promote if previously added
        }
        this.toolOverrides.set(msg.targetSessionId, dOverrides);
        const demoteSocket = this.clients.get(msg.targetSessionId);
        if (demoteSocket) {
          this._reply(demoteSocket, {
            type: 'tool_overrides_update',
            added: [...dOverrides.added],
            removed: [...dOverrides.removed],
          });
        }
        this._reply(socket, { type: 'demoted', requestId: msg.requestId });
        break;
      }

      case 'request_promotion': {
        // Find lead session and send a message
        const sessions = this.sessionManager.listSessions();
        const lead = sessions.find(s => s.isLead);
        if (!lead) {
          this._reply(socket, { type: 'promotion_requested', error: 'No lead session found', requestId: msg.requestId });
          break;
        }
        const leadSocket = this.clients.get(lead.id);
        if (leadSocket) {
          this._reply(leadSocket, {
            type: 'message',
            from: msg.sessionId,
            message: `[PROMOTION REQUEST] Session ${msg.sessionId} requests tools: [${msg.tools.join(', ')}]. Reason: ${msg.reason}. Use promote_session to grant.`,
            priority: 'urgent',
          });
        }
        this._reply(socket, { type: 'promotion_requested', requestId: msg.requestId });
        break;
      }

      // --- Emergent Task Discovery ---
      case 'propose_task': {
        const proposalId = String(++this.nextProposalId);
        const proposal = {
          id: proposalId,
          proposer: msg.proposer,
          title: msg.title,
          description: msg.description,
          justification: msg.justification,
          urgency: msg.urgency,
          status: 'pending',
          comment: null,
          taskId: null,
          timestamp: Date.now(),
        };
        this.proposals.push(proposal);
        // Notify lead
        const allSessions = this.sessionManager.listSessions();
        const leadSession = allSessions.find(s => s.isLead);
        if (leadSession) {
          const lSocket = this.clients.get(leadSession.id);
          if (lSocket) {
            this._reply(lSocket, {
              type: 'message',
              from: msg.proposer,
              message: `[TASK PROPOSAL #${proposalId}] "${msg.title}" (${msg.urgency} urgency)\n  ${msg.description}\n  Justification: ${msg.justification}\n  Use review_proposal to approve/reject.`,
              priority: msg.urgency === 'high' ? 'urgent' : 'normal',
            });
          }
        }
        this._reply(socket, { type: 'proposal_created', proposalId, requestId: msg.requestId });
        break;
      }

      case 'list_proposals': {
        let filtered = this.proposals;
        if (msg.status) {
          filtered = filtered.filter(p => p.status === msg.status);
        }
        this._reply(socket, { type: 'proposals_listed', proposals: filtered, requestId: msg.requestId });
        break;
      }

      case 'review_proposal': {
        const reviewerSess = this.sessionManager.getSessionInfo(msg.reviewedBy);
        if (!reviewerSess || !reviewerSess.isLead) {
          this._reply(socket, { type: 'proposal_reviewed', error: 'Only the lead session can review proposals', requestId: msg.requestId });
          break;
        }
        const proposal = this.proposals.find(p => p.id === msg.proposalId);
        if (!proposal) {
          this._reply(socket, { type: 'proposal_reviewed', error: `Proposal #${msg.proposalId} not found`, requestId: msg.requestId });
          break;
        }
        if (proposal.status !== 'pending') {
          this._reply(socket, { type: 'proposal_reviewed', error: `Proposal #${msg.proposalId} already ${proposal.status}`, requestId: msg.requestId });
          break;
        }
        proposal.status = msg.action === 'approve' ? 'approved' : 'rejected';
        proposal.comment = msg.comment || null;

        let taskId = null;
        if (msg.action === 'approve') {
          // Auto-push to task queue
          const priorityMap = { high: 1, medium: 3, low: 5 };
          taskId = this.taskQueue.push({
            title: proposal.title,
            description: proposal.description,
            priority: priorityMap[proposal.urgency] || 3,
            createdBy: proposal.proposer,
          });
          proposal.taskId = taskId;
          if (this.sessionManager.mainWindow) {
            this.sessionManager.mainWindow.webContents.send('tasks:updated', { tasks: this.taskQueue.list() });
          }
        }

        // Notify the proposer
        const proposerSocket = this.clients.get(proposal.proposer);
        if (proposerSocket) {
          const action = msg.action === 'approve' ? 'APPROVED' : 'REJECTED';
          let notifMsg = `[PROPOSAL ${action}] Your proposal #${msg.proposalId} "${proposal.title}" was ${action.toLowerCase()}.`;
          if (taskId) notifMsg += ` Created task #${taskId}.`;
          if (msg.comment) notifMsg += ` Comment: ${msg.comment}`;
          this._reply(proposerSocket, {
            type: 'message',
            from: msg.reviewedBy,
            message: notifMsg,
            priority: 'normal',
          });
        }

        this._reply(socket, { type: 'proposal_reviewed', proposalId: msg.proposalId, action: msg.action, taskId, requestId: msg.requestId });
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
      if (!this.knowledgeGraph) {
        this.knowledgeGraph = new KnowledgeGraph(leadSession.cwd);
      }
    }
  }

  // Exponential backoff reconnection for disconnected sessions
  _attemptReconnect(sessionId) {
    if (!this._reconnectAttempts) this._reconnectAttempts = new Map();
    const attempts = (this._reconnectAttempts.get(sessionId) || 0) + 1;
    this._reconnectAttempts.set(sessionId, attempts);

    if (attempts > 3) {
      Logger.warn('ipc-server', '_attemptReconnect', `Session ${sessionId} disconnected after 3 failed reconnection attempts`);
      this._reconnectAttempts.delete(sessionId);
      // Update session status to disconnected
      this.sessionManager.updateStatus(sessionId, 'disconnected');
      return;
    }

    // Exponential backoff: 1s, 2s, 4s (capped at 30s)
    const delay = Math.min(1000 * Math.pow(2, attempts - 1), 30000);
    Logger.info('ipc-server', '_attemptReconnect', `Reconnection attempt ${attempts}/3 for ${sessionId} in ${delay}ms`);

    // Update status to reconnecting
    this.sessionManager.updateStatus(sessionId, 'reconnecting');

    setTimeout(() => {
      // Check if the session already reconnected on its own
      if (this.clients.has(sessionId)) {
        Logger.info('ipc-server', '_attemptReconnect', `Session ${sessionId} already reconnected`);
        this._reconnectAttempts.delete(sessionId);
        return;
      }

      // Check if session still exists (wasn't closed)
      const session = this.sessionManager.getSessionInfo(sessionId);
      if (!session) {
        this._reconnectAttempts.delete(sessionId);
        return;
      }

      // Try again — the MCP server process should reconnect itself;
      // if it hasn't by now, try the next backoff interval
      this._attemptReconnect(sessionId);
    }, delay);
  }

  // W10: publish event to all matching subscribers
  _publishEvent(channel, data, sourceSessionId) {
    const targets = this.eventBus.publish(channel, data, sourceSessionId);
    for (const targetId of targets) {
      const targetSocket = this.clients.get(targetId);
      if (targetSocket) {
        this._reply(targetSocket, {
          type: 'event',
          channel,
          data,
          source: sourceSessionId,
          timestamp: Date.now(),
        });
      }
    }
  }

  _reply(socket, data) {
    try {
      socket.write(JSON.stringify(data) + '\n');
    } catch (e) {
      Logger.error('ipc-server', '_reply', `Failed to write to socket: ${e.message}`);
    }
  }

  stop() {
    if (this.server) this.server.close();
  }
}

module.exports = { IpcServer };
