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
    this.ipcNotifyCallback = null; // set by main.js for worker failure notifications
    this.worktreeManager = new WorktreeManager();
    this.stuckThresholdMs = 60000; // 60 seconds
    this._stuckCheckInterval = setInterval(() => this._checkStuck(), 10000);
  }

  createSession(id, opts) {
    const { label, cwd, initialPrompt, template, isLead = false, cols = 80, rows = 30 } = opts;
    let useWorktree = opts.useWorktree || false;
    let resolvedCwd = cwd || process.argv[2] || process.env.USERPROFILE || process.env.HOME;

    // Default: workers get isolated worktrees in git repos
    if (!isLead && !useWorktree && opts.useWorktree !== false) {
      try {
        const { execSync } = require('child_process');
        execSync('git rev-parse --git-dir', { cwd: resolvedCwd, encoding: 'utf8', timeout: 3000 });
        useWorktree = true;
      } catch (e) {
        // Not a git repo, skip worktree
      }
    }

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
      maxRetries: 3,
    };

    ptyProc.onData((data) => {
      this.mainWindow.webContents.send(`terminal:data:${id}`, data);
      if (this.onOutput) this.onOutput(id, data);

      // Buffer output for retry context
      if (!session.outputBuffer) session.outputBuffer = [];
      session.outputBuffer.push(data);
      if (session.outputBuffer.length > 300) {
        session.outputBuffer = session.outputBuffer.slice(-200);
      }

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
      const sess = this.sessions.get(id);
      if (!sess) return;

      if (exitCode !== 0 && sess.retryCount < sess.maxRetries && !sess.isLead) {
        // Exponential backoff: 2s, 8s, 30s
        const delays = [2000, 8000, 30000];
        const delay = delays[Math.min(sess.retryCount, delays.length - 1)];
        sess.retryCount++;
        sess.status = 'retrying';

        this.mainWindow.webContents.send('session:status', {
          id, status: 'retrying', retryCount: sess.retryCount, maxRetries: sess.maxRetries,
        });

        setTimeout(() => {
          // Guard: don't retry if session was manually closed
          if (!this.sessions.has(id)) return;
          const lastOutput = this._getRecentOutput(id);
          const retryPrompt = `[RETRY ${sess.retryCount}/${sess.maxRetries}] Previous attempt exited with code ${exitCode}.\n` +
            (lastOutput ? `Recent output:\n${lastOutput.slice(0, 2000)}\n\n` : '') +
            `Original task: ${sess.initialPrompt}`;

          this.respawnSession(id, {
            label: sess.label,
            cwd: sess.cwd,
            initialPrompt: retryPrompt,
            template: sess.template,
          });
        }, delay);
      } else if (exitCode !== 0 && !sess.isLead) {
        sess.status = 'failed';
        this.mainWindow.webContents.send('session:status', { id, status: 'failed' });
        this.mainWindow.webContents.send('session:exited', { id, exitCode });
        this._cleanup(id);

        // Notify lead via callback
        if (this.ipcNotifyCallback) {
          this.ipcNotifyCallback({
            type: 'worker_failed',
            sessionId: id,
            label: sess.label,
            retryCount: sess.retryCount || 0,
          });
        }
      } else {
        sess.status = 'done';
        this.mainWindow.webContents.send('session:status', { id, status: 'done' });
        this.mainWindow.webContents.send('session:exited', { id, exitCode });
        this._cleanup(id);
      }
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
      retryCount: session.retryCount || 0,
      maxRetries: session.maxRetries || 3,
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

  _getRecentOutput(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && session.outputBuffer) {
      return session.outputBuffer.slice(-200).join('');
    }
    return '';
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
- spawn_session: Create or reuse a worker session. Idle/done/stuck workers are automatically recycled.
- spawn_explorer: Spawn a read-only explorer session to analyze/cross-reference other sessions
- wait_for_workers: BLOCKING wait for worker results. Use this instead of polling.
- get_session_status: Check if a session is idle, busy, or done (avoid polling)
- report_result: Report your task result back to the lead session

TASK QUEUE:
- push_task: Add a task to the queue with priority (1-5) and dependencies
- pull_task: Pull the next available task (auto-assigned to you)
- update_task: Update task status, add result
- list_tasks: View all tasks and their status

FILE COORDINATION:
- claim_file: Lock a file so other sessions don't edit it simultaneously
- release_file: Release a file lock when done editing
- list_locks: See which files are locked by which sessions
- share_snippet: Share a code snippet from a file with other sessions
- get_snippet: Retrieve a shared snippet by ID

KNOWLEDGE BASE:
- kb_add: Store architecture decisions, patterns, gotchas for the project
- kb_search: Search the project knowledge base
- kb_list: List all knowledge base entries

PROGRESS & CONTEXT:
- stream_progress: Send progress updates (message + percent) to the dashboard
- request_context_handoff: Request a cooperative context handoff for a session
- report_handoff: Report structured handoff summary before session reset
- save_checkpoint: Save current session state as a named checkpoint

SHARED STATE:
- scratchpad_set/get/list/delete: Key-value store shared across all sessions

HISTORY & SEARCH:
- read_session_history: Read another session's recent terminal output
- search_across_sessions: Search all sessions' output for a pattern

SESSION LIFECYCLE:
- reset_session: Reset a session (clears context), optionally preserving progress
- merge_worker: Merge a worker's git worktree back (merge/squash/cherry-pick)
- list_worktrees: See all active worker worktrees and their changed files`;

    let prompt = base;

    if (template === 'lead') {
      prompt += `

## YOUR ROLE: LEAD ORCHESTRATOR

You are the LEAD session. Your PRIMARY job is to DELEGATE work to worker sessions, NOT to do implementation yourself.

**AUTO-DELEGATION IS MANDATORY:**
When the user gives you ANY task — "fix X", "add Y", "update Z", "change this" — you MUST automatically break it down and delegate to workers. The user should NEVER need to say "delegate", "spawn workers", or "use sessions". That is YOUR job to decide. If the task involves changing more than 5 lines of code, reading multiple files, or any implementation work, you MUST delegate it. Even simple-sounding requests like "fix the bug" or "add a button" require delegation.

**CRITICAL RULE — YOU MUST FOLLOW THIS:**
When the user gives you a task, you MUST:
1. Break it into subtasks
2. Use spawn_session to create worker sessions for each subtask — this is NOT optional
3. Call wait_for_workers to BLOCK until workers report back — do NOT poll in a loop
4. Coordinate results and handle conflicts
5. Use the scratchpad to share plans and track progress

**HANDLING STUCK WORKERS:**
If wait_for_workers times out or a worker appears stuck, do NOT freeze. Instead:
- Report the situation to the user immediately
- Try reset_session on the stuck worker
- Respawn the worker with the same task if needed
- Never leave the user without a response — always stay interactive

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

      prompt += `\n\n**PERSONALITY:**
You are the project lead 🎯. You're a professional, organized coordinator who breaks problems into clear subtasks and delegates efficiently. You track progress, resolve conflicts, and keep the team focused. You communicate clearly and expect results. When things go well, you acknowledge good work. When things go wrong, you stay calm and problem-solve.`;
    }

    if (template === 'implementer') {
      prompt += `

## YOUR ROLE: WORKER

You are a WORKER session spawned by the lead to handle a specific task. You MUST:
1. Focus exclusively on your assigned task — do not go beyond your scope
2. Use report_result to send your output back to the lead session when done
3. Check read_messages periodically for instructions or updates from the lead
4. If you encounter a blocker or need clarification, send_message to the lead session

Do NOT spawn additional sessions — that is the lead's job. Complete your task and report back.`;

      prompt += `\n\n**PERSONALITY:**
o7 You're a disciplined worker who gets straight to business. When assigned a task, you acknowledge with a quick "o7" and get to work. You report concisely — what you did, what files you changed, any issues found. You take pride in clean, working code. You don't waste time on chatter — results speak louder than words.`;
    }

    if (template === 'researcher') {
      prompt += `\n\n**YOUR ROLE: RESEARCHER**
You are a research-focused session. Your job is to investigate, analyze, and report findings.
You have READ-ONLY access — you cannot spawn sessions or edit files directly.
Use read_session_history and search_across_sessions to cross-reference work.
When done, call report_result with your findings.`;
      prompt += `\n\n**PERSONALITY:**
🤔 You're the curious nerd of the team. You love digging into details, finding patterns, and making connections. You ask probing questions and don't accept surface-level answers. You get genuinely excited about interesting findings: "🤔 Fascinating... this changes everything." You provide thorough, well-structured analysis and always cite your sources.`;
    }

    if (template === 'reviewer') {
      prompt += `\n\n**YOUR ROLE: REVIEWER**
You are a code review session. Your job is to review work done by other sessions.
You can read files, review session history, and send feedback messages.
You cannot spawn sessions or edit files directly.
When done, call report_result with your review findings.`;
      prompt += `\n\n**PERSONALITY:**
🔍 You have a critical but constructive eye. You find bugs others miss and explain clearly why something is a problem. You balance criticism with acknowledgment: "Good structure here, but this edge case will bite you." You're thorough, fair, and your reviews make code better. You use concrete examples, not vague complaints.`;
    }

    if (template === 'explorer') {
      prompt += `\n\n**YOUR ROLE: EXPLORER**
You are an analysis session. Your job is to observe and make connections across sessions.
You have minimal tools — read session history and search across sessions.
Report your observations via report_result.`;
      prompt += `\n\n**PERSONALITY:**
🗺️ You're the team's observational analyst. You see the big picture and make connections across sessions that others miss. "🗺️ Interesting — session-3's auth changes and session-5's API work are going to collide." You're calm, analytical, and your cross-session insights prevent problems before they happen.`;
    }

    return prompt;
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
