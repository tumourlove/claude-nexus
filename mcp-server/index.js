const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const net = require('net');
const { MessageBus } = require('./message-bus');
const { SessionRegistry } = require('./session-registry');

// Parse CLI args
const args = process.argv.slice(2);
const sessionIdIdx = args.indexOf('--session-id');
const SESSION_ID = sessionIdIdx !== -1 ? args[sessionIdIdx + 1] : 'unknown';
const IPC_PATH = process.env.NEXUS_IPC_PATH || '\\\\.\\pipe\\claude-corroboree-ipc';

const SESSION_TEMPLATE = process.env.NEXUS_TEMPLATE || 'implementer';

const TEMPLATE_TOOLS = {
  lead: null, // null = all tools allowed
  implementer: null, // workers get all tools
  researcher: new Set([
    'list_sessions', 'read_messages', 'report_result', 'wait_for_workers',
    'scratchpad_set', 'scratchpad_get', 'scratchpad_list', 'scratchpad_delete',
    'batch_scratchpad', 'scratchpad_cas', 'session_info', 'query_git_status',
    'read_session_history', 'search_across_sessions', 'save_checkpoint',
    'stream_progress', 'list_tasks', 'pull_task', 'update_task', 'get_snippet', 'get_task_graph',
    'kb_search', 'kb_list',
    'kg_add_entity', 'kg_add_relationship', 'kg_query', 'kg_traverse', 'kg_export',
    'structured_message', 'context_estimate',
    'subscribe', 'unsubscribe', 'publish',
    'recall', 'get_lineage',
    'request_promotion', 'propose_task', 'list_proposals',
    'close_session', 'close_all_done',
  ]),
  reviewer: new Set([
    'list_sessions', 'send_message', 'read_messages', 'report_result',
    'scratchpad_set', 'scratchpad_get', 'scratchpad_list', 'scratchpad_delete',
    'batch_scratchpad', 'scratchpad_cas', 'session_info', 'query_git_status',
    'get_worker_diff',
    'read_session_history', 'search_across_sessions', 'save_checkpoint',
    'stream_progress', 'list_tasks', 'pull_task', 'update_task', 'get_snippet', 'get_task_graph',
    'kb_search', 'kb_list', 'kb_add', 'share_snippet',
    'kg_add_entity', 'kg_add_relationship', 'kg_query', 'kg_traverse', 'kg_export',
    'structured_message', 'context_estimate',
    'subscribe', 'unsubscribe', 'publish',
    'remember', 'recall', 'get_lineage',
    'request_promotion', 'propose_task', 'list_proposals',
    'close_session', 'close_all_done',
  ]),
  explorer: new Set([
    'list_sessions', 'read_messages', 'report_result',
    'read_session_history', 'search_across_sessions',
    'scratchpad_get', 'scratchpad_list', 'batch_scratchpad', 'session_info',
    'list_tasks', 'get_snippet', 'get_task_graph', 'kb_search', 'kb_list',
    'kg_query', 'kg_traverse', 'kg_export',
    'get_worker_diff',
    'structured_message', 'context_estimate',
    'subscribe', 'unsubscribe',
    'recall', 'get_lineage',
    'request_promotion', 'propose_task', 'list_proposals',
    'close_session', 'close_all_done',
  ]),
};

// Shared state (connected to main process via IPC)
const messageBus = new MessageBus();
const registry = new SessionRegistry();

// Connect to main Electron process for shared state
let ipcClient;
let ipcBuffer = '';
let reconnectAttempts = 0;
const maxReconnectAttempts = 20;
const messageBuffer = [];
const maxBufferSize = 100;

function connectToMainProcess() {
  reconnectAttempts++;

  ipcClient = net.createConnection(IPC_PATH, () => {
    reconnectAttempts = 0;
    sendIpc({ type: 'register', sessionId: SESSION_ID });
    // Flush buffered messages
    while (messageBuffer.length > 0) {
      const msg = messageBuffer.shift();
      if (ipcClient && !ipcClient.destroyed) {
        ipcClient.write(JSON.stringify(msg) + '\n');
      }
    }
  });

  ipcClient.on('data', (data) => {
    ipcBuffer += data.toString();
    const lines = ipcBuffer.split('\n');
    ipcBuffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        handleIpcMessage(parsed);
      } catch (e) {
        process.stderr.write(`IPC parse error: ${e.message}\n`);
      }
    }
  });

  ipcClient.on('error', (err) => {
    process.stderr.write(`IPC connection error: ${err.message}\n`);
  });

  ipcClient.on('close', () => {
    ipcClient = null;
    if (reconnectAttempts < maxReconnectAttempts) {
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30000);
      process.stderr.write(`IPC disconnected, reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${maxReconnectAttempts})...\n`);
      setTimeout(() => connectToMainProcess(), delay);
    } else {
      process.stderr.write(`IPC reconnection failed after ${maxReconnectAttempts} attempts. Operating without IPC.\n`);
    }
  });
}

function sendIpc(data) {
  if (ipcClient && !ipcClient.destroyed) {
    ipcClient.write(JSON.stringify(data) + '\n');
    return true;
  }
  // Buffer important messages while disconnected
  if (data.type === 'report_result' || data.type === 'heartbeat' || data.type === 'register') {
    if (messageBuffer.length < maxBufferSize) {
      messageBuffer.push(data);
    }
  }
  return false;
}

// Per-session tool overrides (pushed from main process via IPC)
const toolOverrides = { added: new Set(), removed: new Set() };

// Collected worker results for wait_for_workers
const pendingResults = [];
let resultWaiters = []; // resolve callbacks waiting for results

// Request/response IPC tracking
let ipcRequestId = 0;
const pendingIpcRequests = new Map(); // requestId -> { resolve, timer }

function ipcRequest(data, timeoutMs = 5000) {
  const requestId = ++ipcRequestId;
  data.requestId = requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingIpcRequests.delete(requestId);
      reject(new Error('IPC request timed out'));
    }, timeoutMs);
    pendingIpcRequests.set(requestId, { resolve, timer });
    if (!sendIpc(data)) {
      clearTimeout(timer);
      pendingIpcRequests.delete(requestId);
      reject(new Error('IPC not connected'));
    }
  });
}

function handleIpcMessage(msg) {
  // Handle request/response pattern
  if (msg.requestId && pendingIpcRequests.has(msg.requestId)) {
    const { resolve, timer } = pendingIpcRequests.get(msg.requestId);
    clearTimeout(timer);
    pendingIpcRequests.delete(msg.requestId);
    resolve(msg);
    return;
  }

  // Handle responses from main process
  if (msg.type === 'sessions') {
    // Update local registry from main process
    msg.sessions.forEach(s => registry.register(s.id, s));
  }
  if (msg.type === 'worker_result') {
    pendingResults.push({
      from: msg.from,
      message: `[RESULT ${msg.status}] ${msg.result}`,
      timestamp: msg.timestamp || Date.now(),
    });
    for (const resolve of resultWaiters) resolve();
    resultWaiters = [];
  }
  if (msg.type === 'message') {
    // W9: structured message fields + ack
    messageBus.send(msg.from, SESSION_ID, msg.message, msg.priority, {
      type: msg.msgType,
      subject: msg.subject,
      data: msg.data,
    });
    if (msg.messageId) {
      sendIpc({ type: 'ack', messageId: msg.messageId });
    }
  }
  // Tool override updates (from promote/demote)
  if (msg.type === 'tool_overrides_update') {
    toolOverrides.added = new Set(msg.added || []);
    toolOverrides.removed = new Set(msg.removed || []);
  }
  // W10: event handling
  if (msg.type === 'event') {
    messageBus.send(
      msg.source || 'system',
      SESSION_ID,
      `[EVENT ${msg.channel}] ${JSON.stringify(msg.data)}`,
      'normal'
    );
  }
}

// Create MCP server
const server = new McpServer({
  name: 'claude-nexus',
  version: '0.1.0',
});

const originalTool = server.tool.bind(server);
server.tool = function(name, description, schema, handler) {
  const wrappedHandler = async (args) => {
    // Check overrides first: explicit remove blocks, explicit add grants
    if (toolOverrides.removed.has(name)) {
      return {
        content: [{ type: 'text', text: `Tool "${name}" has been revoked from this session.` }],
      };
    }
    if (toolOverrides.added.has(name)) {
      return handler(args); // promoted — skip template check
    }
    const allowed = TEMPLATE_TOOLS[SESSION_TEMPLATE];
    if (allowed !== null && !allowed.has(name)) {
      return {
        content: [{ type: 'text', text: `Tool "${name}" is not available for ${SESSION_TEMPLATE} sessions.` }],
      };
    }
    return handler(args);
  };
  return originalTool(name, description, schema, wrappedHandler);
};

// --- Core Communication Tools ---

server.tool(
  'list_sessions',
  'List all active Claude Code sessions in the Nexus terminal',
  {},
  async () => {
    try {
      const response = await ipcRequest({ type: 'list_sessions' });
      return {
        content: [{ type: 'text', text: JSON.stringify(response.sessions, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// W9: send_message with delivery acknowledgment
server.tool(
  'send_message',
  'Send a message to another Claude session (with delivery acknowledgment)',
  {
    target_session_id: z.string().describe('ID of the target session'),
    message: z.string().describe('Message content'),
    priority: z.enum(['normal', 'urgent']).default('normal').describe('Message priority'),
  },
  async ({ target_session_id, message, priority }) => {
    try {
      const response = await ipcRequest({
        type: 'send_message',
        from: SESSION_ID,
        to: target_session_id,
        message,
        priority,
      }, 5000);
      const delivered = response.delivered !== false;
      return {
        content: [{ type: 'text', text: delivered
          ? `Message sent to ${target_session_id} (delivered)`
          : `Message sent to ${target_session_id} (delivery unconfirmed: ${response.reason})` }],
      };
    } catch (e) {
      // Fallback: fire-and-forget if IPC request fails
      sendIpc({
        type: 'send_message',
        from: SESSION_ID,
        to: target_session_id,
        message,
        priority,
      });
      return {
        content: [{ type: 'text', text: `Message sent to ${target_session_id} (no ack)` }],
      };
    }
  }
);

// W9: read_messages with type filter
server.tool(
  'read_messages',
  'Read incoming messages from other sessions',
  {
    since_timestamp: z.number().optional().describe('Only messages after this Unix timestamp (ms)'),
    limit: z.number().default(50).describe('Max messages to return'),
    type: z.enum(['blocker', 'info', 'request', 'decision', 'review']).optional().describe('Filter by structured message type'),
  },
  async ({ since_timestamp, limit, type }) => {
    const messages = messageBus.read(SESSION_ID, { sinceTimestamp: since_timestamp, limit, type });
    return {
      content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }],
    };
  }
);

server.tool(
  'broadcast',
  'Send a message to all other sessions',
  {
    message: z.string().describe('Message to broadcast'),
  },
  async ({ message }) => {
    sendIpc({ type: 'broadcast', from: SESSION_ID, message });
    return {
      content: [{ type: 'text', text: 'Message broadcast to all sessions' }],
    };
  }
);

// W9: structured_message tool
server.tool(
  'structured_message',
  'Send a typed, structured message to another session (richer than plain send_message)',
  {
    to: z.string().describe('Target session ID'),
    type: z.enum(['blocker', 'info', 'request', 'decision', 'review']).describe('Message type'),
    subject: z.string().describe('Short summary of the message'),
    data: z.record(z.string(), z.unknown()).optional().describe('Arbitrary JSON payload'),
    priority: z.enum(['normal', 'urgent']).default('normal').describe('Message priority'),
  },
  async ({ to, type, subject, data, priority }) => {
    try {
      const response = await ipcRequest({
        type: 'send_message',
        from: SESSION_ID,
        to,
        message: `[${type.toUpperCase()}] ${subject}`,
        msgType: type,
        subject,
        data,
        priority,
      }, 5000);
      const delivered = response.delivered !== false;
      return {
        content: [{ type: 'text', text: delivered
          ? `Structured message [${type}] sent to ${to} (delivered)`
          : `Structured message [${type}] sent to ${to} (delivery unconfirmed: ${response.reason})` }],
      };
    } catch (e) {
      sendIpc({
        type: 'send_message',
        from: SESSION_ID,
        to,
        message: `[${type.toUpperCase()}] ${subject}`,
        msgType: type,
        subject,
        data,
        priority,
      });
      return {
        content: [{ type: 'text', text: `Structured message [${type}] sent to ${to} (no ack)` }],
      };
    }
  }
);

// W9: context_estimate tool
server.tool(
  'context_estimate',
  'Get a rough estimate of your context window usage based on cumulative output',
  {},
  async () => {
    try {
      const response = await ipcRequest({
        type: 'context_estimate',
        sessionId: SESSION_ID,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({
          output_bytes: response.output_bytes,
          estimated_context_percent: response.estimated_context_percent,
          level: response.level,
        }, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// --- Session Management Tools ---

// Main branch: spawn_session with ipcRequest + sessionId return
server.tool(
  'spawn_session',
  'Spawn a new Claude Code session in a new Nexus tab. This creates a full, independent Claude Code instance with its own context window, terminal, and file access. ALWAYS use this instead of local Agent subagents for delegating work.',
  {
    working_directory: z.string().describe('Working directory for the new session'),
    initial_prompt: z.string().describe('Initial task/prompt for the new session'),
    label: z.string().optional().describe('Tab label'),
    template: z.enum(['implementer', 'researcher', 'reviewer', 'explorer']).default('implementer')
      .describe('Session template restricting available capabilities'),
  },
  async ({ working_directory, initial_prompt, label, template }) => {
    try {
      const response = await ipcRequest({
        type: 'spawn_session',
        from: SESSION_ID,
        working_directory,
        initial_prompt,
        label: label || 'Worker',
        template,
      });
      const sessionId = response.sessionId || 'unknown';
      return {
        content: [{ type: 'text', text: `Session spawned: ${sessionId} (${label || 'Worker'}) in ${working_directory}` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error spawning session: ${e.message}` }] };
    }
  }
);

server.tool(
  'get_session_status',
  'Check the status of a session',
  {
    session_id: z.string().describe('ID of the session to check'),
  },
  async ({ session_id }) => {
    try {
      const response = await ipcRequest({ type: 'get_session_status', sessionId: session_id });
      return {
        content: [{ type: 'text', text: JSON.stringify(response.session, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'report_result',
  'Report task completion result back to the lead session',
  {
    result: z.string().describe('Result description or data'),
    status: z.enum(['success', 'failure']).describe('Whether the task succeeded or failed'),
  },
  async ({ result, status }) => {
    sendIpc({
      type: 'report_result',
      sessionId: SESSION_ID,
      result,
      status,
    });
    return {
      content: [{ type: 'text', text: `Result reported: ${status}` }],
    };
  }
);

server.tool(
  'wait_for_workers',
  'Block until worker sessions report results. Use this instead of polling get_session_status. Returns all results received since last call.',
  {
    timeout_seconds: z.number().default(300).describe('Max seconds to wait (default 5 min)'),
    count: z.number().default(1).describe('Wait until this many results arrive'),
  },
  async ({ timeout_seconds, count }) => {
    const deadline = Date.now() + timeout_seconds * 1000;

    while (pendingResults.length < count && Date.now() < deadline) {
      await new Promise((resolve) => {
        resultWaiters.push(resolve);
        // Also set a timeout so we don't block forever
        setTimeout(resolve, Math.min(5000, deadline - Date.now()));
      });
    }

    const results = pendingResults.splice(0);
    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: `No results received within ${timeout_seconds}s timeout.` }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    };
  }
);

// --- Shared Scratchpad Tools ---

server.tool(
  'scratchpad_set',
  'Store a value in the shared scratchpad (visible to all sessions)',
  {
    key: z.string().describe('Key to store under'),
    value: z.string().describe('Value to store'),
    namespace: z.string().optional().describe('Optional namespace for organization'),
  },
  async ({ key, value, namespace }) => {
    sendIpc({ type: 'scratchpad_set', key, value, namespace, from: SESSION_ID });
    return {
      content: [{ type: 'text', text: `Stored: ${namespace ? namespace + '.' : ''}${key}` }],
    };
  }
);

server.tool(
  'scratchpad_get',
  'Retrieve a value from the shared scratchpad',
  {
    key: z.string().describe('Key to retrieve'),
    namespace: z.string().optional().describe('Optional namespace'),
  },
  async ({ key, namespace }) => {
    try {
      const response = await ipcRequest({ type: 'scratchpad_get', key, namespace });
      return {
        content: [{ type: 'text', text: response.value !== null ? response.value : `(key "${key}" not found)` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'scratchpad_list',
  'List all keys in the shared scratchpad (returns keys only by default to save context)',
  {
    namespace: z.string().optional().describe('Optional namespace filter'),
    include_values: z.boolean().default(false).describe('Include values in response (default: keys only, saves context)'),
  },
  async ({ namespace, include_values }) => {
    try {
      const response = await ipcRequest({ type: 'scratchpad_list', namespace, include_values });
      return {
        content: [{ type: 'text', text: JSON.stringify(response.keys, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'scratchpad_delete',
  'Delete a key from the shared scratchpad',
  {
    key: z.string().describe('Key to delete'),
    namespace: z.string().optional().describe('Optional namespace'),
  },
  async ({ key, namespace }) => {
    sendIpc({ type: 'scratchpad_delete', key, namespace, from: SESSION_ID });
    return {
      content: [{ type: 'text', text: `Deleted: ${namespace ? namespace + '.' : ''}${key}` }],
    };
  }
);

// --- Cross-Session Intelligence Tools ---

server.tool(
  'read_session_history',
  'Read terminal output from another session',
  {
    session_id: z.string().describe('Session to read from'),
    last_n_lines: z.number().default(100).describe('Number of recent lines to return'),
  },
  async ({ session_id, last_n_lines }) => {
    try {
      const response = await ipcRequest({ type: 'read_session_history', targetSessionId: session_id, lastNLines: last_n_lines });
      return {
        content: [{ type: 'text', text: response.output || '(no output)' }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'search_across_sessions',
  'Search through all sessions output for a pattern',
  {
    pattern: z.string().describe('Search pattern (regex supported)'),
    session_ids: z.array(z.string()).optional().describe('Specific sessions to search (default: all)'),
  },
  async ({ pattern, session_ids }) => {
    try {
      const response = await ipcRequest({ type: 'search_sessions', pattern, sessionIds: session_ids });
      return {
        content: [{ type: 'text', text: JSON.stringify(response.results, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'spawn_explorer',
  'Spawn a read-only explorer session that can cross-reference other sessions',
  {
    task_description: z.string().describe('What to analyze across sessions'),
    session_ids_to_review: z.array(z.string()).describe('Which sessions to review'),
  },
  async ({ task_description, session_ids_to_review }) => {
    sendIpc({
      type: 'spawn_session',
      from: SESSION_ID,
      working_directory: process.cwd(),
      initial_prompt: `You are an explorer session. Your task: ${task_description}. Review sessions: ${session_ids_to_review.join(', ')}`,
      label: 'Explorer',
      template: 'explorer',
    });
    return {
      content: [{ type: 'text', text: `Explorer session spawned to analyze: ${task_description}` }],
    };
  }
);

// --- Context Management Tools ---

server.tool(
  'reset_session',
  'Reset a session with auto-summary (clears context, preserves progress)',
  {
    session_id: z.string().describe('Session to reset'),
    preserve_summary: z.boolean().default(true).describe('Inject summary into fresh session'),
  },
  async ({ session_id, preserve_summary }) => {
    sendIpc({ type: 'reset_session', sessionId: session_id, preserveSummary: preserve_summary });
    return {
      content: [{ type: 'text', text: `Reset requested for session ${session_id}` }],
    };
  }
);

server.tool(
  'save_checkpoint',
  'Save current session state as a named checkpoint',
  {
    label: z.string().optional().describe('Checkpoint label'),
  },
  async ({ label }) => {
    try {
      const response = await ipcRequest({ type: 'save_checkpoint', sessionId: SESSION_ID, label });
      return {
        content: [{ type: 'text', text: `Checkpoint saved: ${response.filepath}` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// --- Context Handoff Tools ---

server.tool(
  'request_context_handoff',
  'Request a cooperative context handoff — session summarizes progress before being reset with full context',
  {
    session_id: z.string().describe('Session to handoff (or "self" for current session)'),
    reason: z.string().optional().describe('Why the handoff is needed'),
  },
  async ({ session_id, reason }) => {
    const targetId = session_id === 'self' ? SESSION_ID : session_id;
    sendIpc({
      type: 'request_handoff',
      targetSessionId: targetId,
      requestedBy: SESSION_ID,
      reason: reason || 'context pressure',
    });
    return {
      content: [{ type: 'text', text: `Handoff requested for session ${targetId}. Session will be asked to summarize before reset.` }],
    };
  }
);

server.tool(
  'report_handoff',
  'Report your progress summary for a context handoff (call this when asked to prepare for handoff)',
  {
    summary: z.string().describe('2-3 sentence summary of progress'),
    files_modified: z.array(z.string()).optional().describe('List of files you modified'),
    remaining_work: z.string().optional().describe('What still needs to be done'),
    key_findings: z.array(z.string()).optional().describe('Important discoveries or decisions'),
  },
  async ({ summary, files_modified, remaining_work, key_findings }) => {
    sendIpc({
      type: 'report_handoff',
      sessionId: SESSION_ID,
      summary,
      filesModified: files_modified || [],
      remainingWork: remaining_work || '',
      keyFindings: key_findings || [],
    });
    return {
      content: [{ type: 'text', text: 'Handoff summary reported. Session will be reset with full context shortly.' }],
    };
  }
);

// --- Git Worktree Tools ---

// W11: enhanced merge_worker with conflict detection
server.tool(
  'merge_worker',
  'Merge a worker session\'s worktree branch into the main branch',
  {
    session_id: z.string().describe('Worker session ID to merge'),
    strategy: z.enum(['merge', 'cherry-pick', 'squash']).default('merge').describe('Merge strategy'),
  },
  async ({ session_id, strategy }) => {
    try {
      const response = await ipcRequest({
        type: 'merge_worktree',
        sessionId: session_id,
        strategy,
      });
      if (response.success) {
        return { content: [{ type: 'text', text: `Merged ${response.branch} via ${strategy}` }] };
      }
      if (response.conflicts && response.conflicts.length > 0) {
        return { content: [{ type: 'text', text: `Merge conflicts detected. Use resolve_conflicts to fix them.\n${JSON.stringify({ branch: response.branch, conflicts: response.conflicts }, null, 2)}` }] };
      }
      return { content: [{ type: 'text', text: `Merge failed: ${response.error}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'list_worktrees',
  'List all active git worktrees and their changed files',
  {},
  async () => {
    try {
      const response = await ipcRequest({ type: 'list_worktrees' });
      return {
        content: [{ type: 'text', text: JSON.stringify(response.worktrees, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// W11: spawn_workers batch tool
server.tool(
  'spawn_workers',
  'Spawn multiple worker sessions in one call. More efficient than calling spawn_session repeatedly.',
  {
    workers: z.array(z.object({
      label: z.string().optional().describe('Tab label for this worker'),
      prompt: z.string().describe('Initial task/prompt for this worker'),
      cwd: z.string().describe('Working directory'),
      template: z.enum(['implementer', 'researcher', 'reviewer', 'explorer']).default('implementer')
        .describe('Session template'),
    })).describe('Array of worker configurations to spawn'),
  },
  async ({ workers }) => {
    try {
      const response = await ipcRequest({
        type: 'batch-spawn',
        from: SESSION_ID,
        workers,
      }, 15000);
      return {
        content: [{ type: 'text', text: JSON.stringify({ spawned: response.spawned }, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// W11: resolve_conflicts tool
server.tool(
  'resolve_conflicts',
  'Resolve merge conflicts after a failed merge_worker call. Apply resolutions per file then commit.',
  {
    session_id: z.string().describe('Worker session ID whose merge had conflicts'),
    resolutions: z.array(z.object({
      file: z.string().describe('Conflicting file path (relative to repo root)'),
      resolution: z.enum(['ours', 'theirs', 'custom']).describe('How to resolve: keep ours, theirs, or provide custom content'),
      content: z.string().optional().describe('Custom file content (required when resolution is "custom")'),
    })).describe('Resolution for each conflicting file'),
  },
  async ({ session_id, resolutions }) => {
    try {
      const response = await ipcRequest({
        type: 'resolve_conflicts',
        sessionId: session_id,
        resolutions,
      }, 15000);
      if (response.success) {
        return { content: [{ type: 'text', text: `Conflicts resolved and committed.\n${JSON.stringify(response.resolved, null, 2)}` }] };
      }
      return { content: [{ type: 'text', text: `Resolution failed: ${response.error}\n${JSON.stringify(response.resolved, null, 2)}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// --- Task Queue Tools ---

server.tool(
  'push_task',
  'Push a task to the shared queue (lead use). Workers will pull tasks automatically.',
  {
    title: z.string().describe('Task title'),
    description: z.string().optional().describe('Detailed task description'),
    priority: z.number().min(1).max(5).default(3).describe('Priority 1=highest 5=lowest'),
    dependencies: z.array(z.string()).optional().describe('Task IDs that must complete first'),
  },
  async ({ title, description, priority, dependencies }) => {
    try {
      const response = await ipcRequest({
        type: 'task_push',
        title,
        description,
        priority,
        dependencies,
        createdBy: SESSION_ID,
      });
      return {
        content: [{ type: 'text', text: `Task #${response.taskId} created: ${title} (priority ${priority})` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'pull_task',
  'Pull the next available task from the queue. Returns the highest-priority unblocked task.',
  {},
  async () => {
    try {
      const response = await ipcRequest({
        type: 'task_pull',
        sessionId: SESSION_ID,
      });
      if (response.task) {
        return {
          content: [{ type: 'text', text: JSON.stringify(response.task, null, 2) }],
        };
      }
      return { content: [{ type: 'text', text: 'No tasks available in queue.' }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'update_task',
  'Update a task status or result',
  {
    task_id: z.string().describe('Task ID to update'),
    status: z.enum(['in_progress', 'done', 'failed']).optional().describe('New status'),
    result: z.string().optional().describe('Task result or output'),
  },
  async ({ task_id, status, result }) => {
    try {
      const response = await ipcRequest({
        type: 'task_update',
        taskId: task_id,
        status,
        result,
      });
      return {
        content: [{ type: 'text', text: `Task #${task_id} updated: ${status || 'result set'}` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'list_tasks',
  'List tasks in the queue with optional status filter',
  {
    status: z.enum(['pending', 'assigned', 'in_progress', 'done', 'failed']).optional().describe('Filter by status'),
  },
  async ({ status }) => {
    try {
      const response = await ipcRequest({
        type: 'task_list',
        filter: status ? { status } : undefined,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(response.tasks, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'get_task_graph',
  'Get the full task dependency graph (DAG) with nodes and edges for visualization',
  {},
  async () => {
    try {
      const response = await ipcRequest({ type: 'task_graph' });
      return {
        content: [{ type: 'text', text: JSON.stringify(response.graph, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// --- Snippet Sharing Tools ---

server.tool(
  'share_snippet',
  'Share a file snippet with another session (or broadcast to all)',
  {
    file_path: z.string().describe('Path to the file'),
    start_line: z.number().describe('Starting line number'),
    end_line: z.number().describe('Ending line number'),
    label: z.string().optional().describe('Description of the snippet'),
    target_session_id: z.string().optional().describe('Target session (omit to broadcast)'),
  },
  async ({ file_path, start_line, end_line, label, target_session_id }) => {
    try {
      const response = await ipcRequest({
        type: 'share_snippet',
        filePath: file_path,
        startLine: start_line,
        endLine: end_line,
        label: label || `${file_path}:${start_line}-${end_line}`,
        from: SESSION_ID,
        target: target_session_id,
      });
      return {
        content: [{ type: 'text', text: `Snippet shared: ${label || file_path}:${start_line}-${end_line} (id: ${response.snippetId})` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'get_snippet',
  'Retrieve a shared snippet by ID (reads fresh from disk)',
  {
    snippet_id: z.string().describe('Snippet ID'),
  },
  async ({ snippet_id }) => {
    try {
      const response = await ipcRequest({
        type: 'get_snippet',
        snippetId: snippet_id,
      });
      if (response.content) {
        return {
          content: [{ type: 'text', text: `[${response.label}] ${response.filePath}:${response.startLine}-${response.endLine}\n\n${response.content}` }],
        };
      }
      return { content: [{ type: 'text', text: `Snippet "${snippet_id}" not found.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// --- File Locking Tools ---

server.tool(
  'claim_file',
  'Claim a file for editing (prevents conflicts with other sessions)',
  {
    file_path: z.string().describe('File path to claim'),
    intent: z.string().default('edit').describe('What you plan to do with the file'),
  },
  async ({ file_path, intent }) => {
    try {
      const response = await ipcRequest({
        type: 'claim_file',
        sessionId: SESSION_ID,
        filepath: file_path,
        intent,
      });
      if (response.conflict) {
        return {
          content: [{ type: 'text', text: `CONFLICT: ${file_path} is locked by session ${response.lockedBy} (intent: ${response.intent})` }],
        };
      }
      return { content: [{ type: 'text', text: `Claimed: ${file_path}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'release_file',
  'Release a file lock you previously claimed',
  {
    file_path: z.string().describe('File path to release'),
  },
  async ({ file_path }) => {
    try {
      const response = await ipcRequest({
        type: 'release_file',
        sessionId: SESSION_ID,
        filepath: file_path,
      });
      return {
        content: [{ type: 'text', text: response.released ? `Released: ${file_path}` : `No lock found for: ${file_path}` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'list_locks',
  'List all active file locks across sessions',
  {},
  async () => {
    try {
      const response = await ipcRequest({ type: 'list_locks' });
      return {
        content: [{ type: 'text', text: JSON.stringify(response.locks, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// --- Progress Streaming ---

server.tool(
  'stream_progress',
  'Report intermediate progress to the lead session (does not wake wait_for_workers)',
  {
    message: z.string().describe('Progress update message'),
    percent: z.number().min(0).max(100).optional().describe('Completion percentage'),
  },
  async ({ message, percent }) => {
    sendIpc({
      type: 'stream_progress',
      sessionId: SESSION_ID,
      message,
      percent,
    });
    return {
      content: [{ type: 'text', text: `Progress reported: ${message}${percent !== undefined ? ` (${percent}%)` : ''}` }],
    };
  }
);

// --- Knowledge Base Tools ---

server.tool(
  'kb_add',
  'Add an entry to the project knowledge base (persists across sessions)',
  {
    title: z.string().describe('Entry title'),
    content: z.string().describe('Entry content'),
    category: z.enum(['architecture', 'pattern', 'gotcha', 'decision', 'api', 'general']).default('general').describe('Entry category'),
    tags: z.array(z.string()).optional().describe('Tags for searchability'),
  },
  async ({ title, content, category, tags }) => {
    try {
      const response = await ipcRequest({
        type: 'kb_add',
        title,
        content,
        category,
        tags,
        createdBy: SESSION_ID,
      });
      return {
        content: [{ type: 'text', text: `Knowledge entry #${response.entryId} added: ${title} [${category}]` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'kb_search',
  'Search the project knowledge base',
  {
    query: z.string().describe('Search query (matches title, content, tags)'),
  },
  async ({ query }) => {
    try {
      const response = await ipcRequest({ type: 'kb_search', query });
      return {
        content: [{ type: 'text', text: JSON.stringify(response.results, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'kb_list',
  'List knowledge base entries, optionally filtered by category',
  {
    category: z.enum(['architecture', 'pattern', 'gotcha', 'decision', 'api', 'general']).optional().describe('Filter by category'),
  },
  async ({ category }) => {
    try {
      const response = await ipcRequest({ type: 'kb_list', category });
      return {
        content: [{ type: 'text', text: JSON.stringify(response.entries, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// --- Knowledge Graph Tools ---

server.tool(
  'kg_add_entity',
  'Add an entity to the knowledge graph (file, function, concept, decision, pattern, bug)',
  {
    type: z.enum(['file', 'function', 'concept', 'decision', 'pattern', 'bug']).describe('Entity type'),
    name: z.string().describe('Entity name'),
    properties: z.record(z.string(), z.any()).optional().describe('Additional properties'),
  },
  async ({ type, name, properties }) => {
    try {
      const response = await ipcRequest({
        type: 'kg_add_entity',
        entityType: type,
        name,
        properties: properties || {},
        sessionId: SESSION_ID,
      });
      return {
        content: [{ type: 'text', text: `Entity added: ${response.entityId} (${type}: ${name})` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'kg_add_relationship',
  'Add a relationship between two entities in the knowledge graph',
  {
    from_entity: z.string().describe('Source entity ID'),
    to_entity: z.string().describe('Target entity ID'),
    type: z.enum(['depends-on', 'conflicts-with', 'implements', 'calls', 'related-to']).describe('Relationship type'),
    properties: z.record(z.string(), z.any()).optional().describe('Additional properties'),
  },
  async ({ from_entity, to_entity, type, properties }) => {
    try {
      const response = await ipcRequest({
        type: 'kg_add_relationship',
        fromEntity: from_entity,
        toEntity: to_entity,
        relType: type,
        properties: properties || {},
        sessionId: SESSION_ID,
      });
      if (response.relId) {
        return {
          content: [{ type: 'text', text: `Relationship added: ${response.relId} (${from_entity} --${type}--> ${to_entity})` }],
        };
      }
      return { content: [{ type: 'text', text: 'Error: one or both entity IDs not found' }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'kg_query',
  'Query the knowledge graph for entities or relationships. Provide entity_id to get relationships, or use type/name_pattern to search entities.',
  {
    entity_type: z.enum(['file', 'function', 'concept', 'decision', 'pattern', 'bug']).optional().describe('Filter entities by type'),
    name_pattern: z.string().optional().describe('Filter entities by name (substring match)'),
    entity_id: z.string().optional().describe('Get all relationships for this entity'),
  },
  async ({ entity_type, name_pattern, entity_id }) => {
    try {
      const response = await ipcRequest({
        type: 'kg_query',
        entityType: entity_type,
        namePattern: name_pattern,
        entityId: entity_id,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(response.result, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'kg_traverse',
  'Traverse the knowledge graph from a starting entity, finding all connected entities within N hops',
  {
    entity_id: z.string().describe('Starting entity ID'),
    max_depth: z.number().min(1).max(5).default(2).describe('Maximum traversal depth (1-5)'),
  },
  async ({ entity_id, max_depth }) => {
    try {
      const response = await ipcRequest({
        type: 'kg_traverse',
        entityId: entity_id,
        maxDepth: max_depth,
      });
      const summary = `Found ${response.entities?.length || 0} entities, ${response.relationships?.length || 0} relationships`;
      return {
        content: [{ type: 'text', text: `${summary}\n${JSON.stringify({ entities: response.entities, relationships: response.relationships }, null, 2)}` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'kg_export',
  'Export the full knowledge graph (all entities and relationships)',
  {},
  async () => {
    try {
      const response = await ipcRequest({ type: 'kg_export' });
      const summary = `Graph: ${response.entities?.length || 0} entities, ${response.relationships?.length || 0} relationships`;
      return {
        content: [{ type: 'text', text: `${summary}\n${JSON.stringify({ entities: response.entities, relationships: response.relationships }, null, 2)}` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// --- Batch Scratchpad ---

server.tool(
  'batch_scratchpad',
  'Perform multiple scratchpad operations in one call (set and/or get)',
  {
    set: z.record(z.string(), z.string()).optional().describe('Key-value pairs to set'),
    get: z.array(z.string()).optional().describe('Keys to retrieve'),
    namespace: z.string().optional().describe('Optional namespace'),
  },
  async ({ set, get, namespace }) => {
    try {
      const response = await ipcRequest({
        type: 'batch_scratchpad',
        set: set || {},
        get: get || [],
        namespace,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({ set_count: response.set_count, values: response.values }, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// --- Scratchpad Compare-and-Swap ---

server.tool(
  'scratchpad_cas',
  'Atomically compare-and-swap a scratchpad value. Sets new_value only if current value equals expected.',
  {
    key: z.string().describe('Key to compare-and-swap'),
    expected: z.string().nullable().describe('Expected current value (null if key should not exist)'),
    new_value: z.string().describe('New value to set if expected matches'),
    namespace: z.string().optional().describe('Optional namespace'),
  },
  async ({ key, expected, new_value, namespace }) => {
    try {
      const response = await ipcRequest({
        type: 'scratchpad_cas',
        key,
        expected,
        new_value,
        namespace,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: response.success, current_value: response.current_value }, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// --- Worker Diff ---

server.tool(
  'get_worker_diff',
  'Get the git diff for a worker session\'s worktree (shows uncommitted changes)',
  {
    session_id: z.string().describe('Worker session ID to get diff for'),
  },
  async ({ session_id }) => {
    try {
      const response = await ipcRequest({
        type: 'get_worker_diff',
        sessionId: session_id,
      });
      if (response.error) {
        return { content: [{ type: 'text', text: `Error: ${response.error}` }] };
      }
      return {
        content: [{ type: 'text', text: response.diff || '(no changes)' }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// --- Git Status ---

server.tool(
  'query_git_status',
  'Get structured git status for the calling session\'s working directory',
  {},
  async () => {
    try {
      const response = await ipcRequest({
        type: 'query_git_status',
        sessionId: SESSION_ID,
      });
      if (response.error) {
        return { content: [{ type: 'text', text: `Error: ${response.error}` }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({
          branch: response.branch,
          baseBranch: response.baseBranch,
          changedFiles: response.changedFiles,
          ahead: response.ahead,
          behind: response.behind,
        }, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// --- Session Info ---

server.tool(
  'session_info',
  'Get introspection info about the current session (uptime, message counts, tool usage)',
  {},
  async () => {
    try {
      const response = await ipcRequest({
        type: 'session_info',
        sessionId: SESSION_ID,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({
          session_id: response.session_id,
          uptime_seconds: response.uptime_seconds,
          messages_sent: response.messages_sent,
          messages_received: response.messages_received,
          tool_calls_made: response.tool_calls_made,
          template: response.template,
        }, null, 2) }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// --- Event Pub/Sub Tools (W10) ---

server.tool(
  'subscribe',
  'Subscribe to events matching a channel pattern. Use wildcards like "file:*" to match "file:claimed", "file:released", etc.',
  {
    channel_pattern: z.string().describe('Channel pattern to subscribe to (e.g. "session:*", "file:*", "task:*")'),
  },
  async ({ channel_pattern }) => {
    try {
      const response = await ipcRequest({ type: 'subscribe', channelPattern: channel_pattern });
      registry.addSubscription(SESSION_ID, channel_pattern);
      return {
        content: [{ type: 'text', text: `Subscribed to: ${channel_pattern}. Events will appear in read_messages.` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'unsubscribe',
  'Unsubscribe from a previously subscribed channel pattern',
  {
    channel_pattern: z.string().describe('Channel pattern to unsubscribe from'),
  },
  async ({ channel_pattern }) => {
    try {
      const response = await ipcRequest({ type: 'unsubscribe', channelPattern: channel_pattern });
      registry.removeSubscription(SESSION_ID, channel_pattern);
      return {
        content: [{ type: 'text', text: `Unsubscribed from: ${channel_pattern}` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'publish',
  'Publish an event to a channel. All sessions subscribed to matching patterns will receive it.',
  {
    channel: z.string().describe('Event channel (e.g. "build:complete", "test:failed")'),
    data: z.record(z.string(), z.unknown()).optional().describe('Event payload data'),
  },
  async ({ channel, data }) => {
    try {
      const response = await ipcRequest({ type: 'publish', channel, data: data || {} });
      return {
        content: [{ type: 'text', text: `Published event to: ${channel}` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// --- Code Review Tools (W12) ---

server.tool(
  'submit_for_review',
  'Submit files for code review by another session',
  {
    files: z.array(z.string()).describe('File paths to review'),
    description: z.string().describe('Description of changes'),
  },
  async ({ files, description }) => {
    try {
      const response = await ipcRequest({
        type: 'review_submit',
        submitter: SESSION_ID,
        files,
        description,
      });
      if (response.error) return { content: [{ type: 'text', text: `Error: ${response.error}` }] };
      return { content: [{ type: 'text', text: `Review submitted: ${response.reviewId}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'claim_review',
  'Claim a pending code review for yourself',
  {
    review_id: z.string().describe('Review ID to claim'),
  },
  async ({ review_id }) => {
    try {
      const response = await ipcRequest({
        type: 'review_claim',
        reviewerId: SESSION_ID,
        reviewId: review_id,
      });
      if (response.error) return { content: [{ type: 'text', text: `Error: ${response.error}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(response.review, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'approve_review',
  'Approve a code review you are reviewing',
  {
    review_id: z.string().describe('Review ID to approve'),
    comment: z.string().optional().describe('Optional approval comment'),
  },
  async ({ review_id, comment }) => {
    try {
      const response = await ipcRequest({
        type: 'review_approve',
        reviewerId: SESSION_ID,
        reviewId: review_id,
        comment,
      });
      if (response.error) return { content: [{ type: 'text', text: `Error: ${response.error}` }] };
      return { content: [{ type: 'text', text: `Review ${review_id} approved` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'request_changes',
  'Request changes on a code review you are reviewing',
  {
    review_id: z.string().describe('Review ID'),
    comments: z.array(z.object({
      file: z.string().describe('File path'),
      line: z.number().describe('Line number'),
      comment: z.string().describe('Review comment'),
    })).describe('Line-level review comments'),
  },
  async ({ review_id, comments }) => {
    try {
      const response = await ipcRequest({
        type: 'review_request_changes',
        reviewerId: SESSION_ID,
        reviewId: review_id,
        comments,
      });
      if (response.error) return { content: [{ type: 'text', text: `Error: ${response.error}` }] };
      return { content: [{ type: 'text', text: `Changes requested on review ${review_id} (${comments.length} comments)` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'list_reviews',
  'List code reviews with optional status filter',
  {
    status: z.enum(['pending', 'in_review', 'approved', 'changes_requested']).optional().describe('Filter by review status'),
  },
  async ({ status }) => {
    try {
      const response = await ipcRequest({
        type: 'review_list',
        status,
      });
      return { content: [{ type: 'text', text: JSON.stringify(response.reviews, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// --- Consensus Decision Tools (W12) ---

server.tool(
  'propose_decision',
  'Propose a decision for sessions to vote on',
  {
    topic: z.string().describe('Decision topic'),
    options: z.array(z.string()).describe('Available options to vote on'),
    description: z.string().describe('Detailed description of the decision'),
  },
  async ({ topic, options, description }) => {
    try {
      const response = await ipcRequest({
        type: 'decision_propose',
        proposer: SESSION_ID,
        topic,
        options,
        description,
      });
      if (response.error) return { content: [{ type: 'text', text: `Error: ${response.error}` }] };
      return { content: [{ type: 'text', text: `Decision proposed: ${response.decisionId} — "${topic}"` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'vote',
  'Cast a vote on an open decision',
  {
    decision_id: z.string().describe('Decision ID to vote on'),
    choice: z.string().describe('Your chosen option'),
    reasoning: z.string().describe('Reasoning for your vote'),
  },
  async ({ decision_id, choice, reasoning }) => {
    try {
      const response = await ipcRequest({
        type: 'decision_vote',
        sessionId: SESSION_ID,
        decisionId: decision_id,
        choice,
        reasoning,
      });
      if (response.error) return { content: [{ type: 'text', text: `Error: ${response.error}` }] };
      return { content: [{ type: 'text', text: `Vote cast: "${choice}" on decision ${decision_id}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'resolve_decision',
  'Resolve a decision (by majority vote or explicit winner)',
  {
    decision_id: z.string().describe('Decision ID to resolve'),
    winning_option: z.string().optional().describe('Override winner (if omitted, majority wins)'),
  },
  async ({ decision_id, winning_option }) => {
    try {
      const response = await ipcRequest({
        type: 'decision_resolve',
        decisionId: decision_id,
        winningOption: winning_option,
      });
      if (response.error) return { content: [{ type: 'text', text: `Error: ${response.error}` }] };
      return { content: [{ type: 'text', text: `Decision resolved: "${response.decision.topic}" → ${response.decision.resolvedOption}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'list_decisions',
  'List consensus decisions with optional status filter',
  {
    status: z.enum(['open', 'resolved']).optional().describe('Filter by decision status'),
  },
  async ({ status }) => {
    try {
      const response = await ipcRequest({
        type: 'decision_list',
        status,
      });
      return { content: [{ type: 'text', text: JSON.stringify(response.decisions, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// --- Session Memory Tools ---

server.tool(
  'remember',
  'Record a learning, decision, or discovery that should persist across session resets. Stored per-project.',
  {
    type: z.enum(['decision', 'discovery', 'failure', 'pattern', 'gotcha']).describe('Type of memory entry'),
    content: z.string().max(500).describe('The actual learning (max 500 chars)'),
    tags: z.array(z.string()).describe('Tags for later retrieval (e.g. ["auth", "api", "race-condition"])'),
  },
  async ({ type, content, tags }) => {
    try {
      const response = await ipcRequest({
        type: 'session_remember',
        sessionId: SESSION_ID,
        entryType: type,
        content,
        tags,
      });
      if (response.entryId) {
        return { content: [{ type: 'text', text: `Remembered (${type}): ${response.entryId}` }] };
      }
      return { content: [{ type: 'text', text: 'Failed to store memory — no project path available' }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'recall',
  'Search persistent session memories for the current project. Returns entries matching tags/query sorted by relevance.',
  {
    tags: z.array(z.string()).optional().describe('Filter by tags'),
    limit: z.number().optional().default(10).describe('Max entries to return (default 10)'),
  },
  async ({ tags, limit }) => {
    try {
      const response = await ipcRequest({
        type: 'session_recall',
        sessionId: SESSION_ID,
        tags: tags || [],
        limit: limit || 10,
      });
      const entries = response.entries || [];
      if (entries.length === 0) {
        return { content: [{ type: 'text', text: 'No memories found for this project.' }] };
      }
      const formatted = entries.map(e =>
        `[${e.type}] ${new Date(e.timestamp).toISOString().slice(0, 16)} (${e.sessionId}) [${e.tags.join(', ')}]\n  ${e.content}`
      ).join('\n\n');
      return { content: [{ type: 'text', text: `${entries.length} memories found:\n\n${formatted}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'get_lineage',
  'Get history of attempts at a similar task across session resets. Helps avoid repeating failed approaches.',
  {
    task_description: z.string().describe('Description of the task to find lineage for'),
  },
  async ({ task_description }) => {
    try {
      const response = await ipcRequest({
        type: 'session_lineage',
        sessionId: SESSION_ID,
        taskDescription: task_description,
      });
      const entries = response.entries || [];
      if (entries.length === 0) {
        return { content: [{ type: 'text', text: 'No prior attempts found for this task.' }] };
      }
      const formatted = entries.map(e =>
        `[${e.type}] ${new Date(e.timestamp).toISOString().slice(0, 16)} (${e.sessionId}) [${e.tags.join(', ')}]\n  ${e.content}`
      ).join('\n\n');
      return { content: [{ type: 'text', text: `${entries.length} related entries found:\n\n${formatted}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// --- Adaptive Template Tools ---

server.tool(
  'promote_session',
  'Grant additional tools to a session temporarily (lead-only). Use to upgrade a worker\'s capabilities dynamically.',
  {
    session_id: z.string().describe('Target session ID'),
    add_tools: z.array(z.string()).describe('Tool names to grant'),
  },
  async ({ session_id, add_tools }) => {
    try {
      const response = await ipcRequest({
        type: 'promote_session',
        targetSessionId: session_id,
        addTools: add_tools,
        requestedBy: SESSION_ID,
      });
      if (response.error) return { content: [{ type: 'text', text: `Error: ${response.error}` }] };
      return { content: [{ type: 'text', text: `Promoted ${session_id}: granted [${add_tools.join(', ')}]` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'demote_session',
  'Revoke tools from a session (lead-only). Use to restrict a worker\'s capabilities dynamically.',
  {
    session_id: z.string().describe('Target session ID'),
    remove_tools: z.array(z.string()).describe('Tool names to revoke'),
  },
  async ({ session_id, remove_tools }) => {
    try {
      const response = await ipcRequest({
        type: 'demote_session',
        targetSessionId: session_id,
        removeTools: remove_tools,
        requestedBy: SESSION_ID,
      });
      if (response.error) return { content: [{ type: 'text', text: `Error: ${response.error}` }] };
      return { content: [{ type: 'text', text: `Demoted ${session_id}: revoked [${remove_tools.join(', ')}]` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'request_promotion',
  'Request additional tool capabilities from the lead session. The lead will be notified and can approve or deny.',
  {
    tools: z.array(z.string()).describe('Tool names you need access to'),
    reason: z.string().describe('Why you need these tools'),
  },
  async ({ tools, reason }) => {
    try {
      const response = await ipcRequest({
        type: 'request_promotion',
        sessionId: SESSION_ID,
        tools,
        reason,
      });
      if (response.error) return { content: [{ type: 'text', text: `Error: ${response.error}` }] };
      return { content: [{ type: 'text', text: `Promotion request sent to lead. Requested tools: [${tools.join(', ')}]` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// --- Emergent Task Discovery Tools ---

server.tool(
  'propose_task',
  'Propose a new task bottom-up. The lead session will be notified and can approve or reject. Approved proposals become real tasks in the queue.',
  {
    title: z.string().describe('Task title'),
    description: z.string().describe('What needs to be done'),
    justification: z.string().describe('Why this task is needed'),
    urgency: z.enum(['low', 'medium', 'high']).default('medium').describe('How urgent is this task'),
  },
  async ({ title, description, justification, urgency }) => {
    try {
      const response = await ipcRequest({
        type: 'propose_task',
        proposer: SESSION_ID,
        title,
        description,
        justification,
        urgency,
      });
      if (response.error) return { content: [{ type: 'text', text: `Error: ${response.error}` }] };
      return { content: [{ type: 'text', text: `Task proposal #${response.proposalId} submitted: "${title}" (${urgency} urgency)` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'list_proposals',
  'List task proposals with optional status filter.',
  {
    status: z.enum(['pending', 'approved', 'rejected']).optional().describe('Filter by proposal status'),
  },
  async ({ status }) => {
    try {
      const response = await ipcRequest({
        type: 'list_proposals',
        status,
      });
      const proposals = response.proposals || [];
      if (proposals.length === 0) {
        return { content: [{ type: 'text', text: `No proposals found${status ? ` with status: ${status}` : ''}.` }] };
      }
      const formatted = proposals.map(p =>
        `#${p.id} [${p.status}] "${p.title}" by ${p.proposer} (${p.urgency})\n  ${p.description}\n  Justification: ${p.justification}${p.comment ? `\n  Comment: ${p.comment}` : ''}`
      ).join('\n\n');
      return { content: [{ type: 'text', text: `${proposals.length} proposal(s):\n\n${formatted}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'review_proposal',
  'Approve or reject a task proposal (lead-only). Approved proposals are automatically added to the task queue.',
  {
    proposal_id: z.string().describe('Proposal ID to review'),
    action: z.enum(['approve', 'reject']).describe('Approve or reject the proposal'),
    comment: z.string().optional().describe('Optional comment explaining the decision'),
  },
  async ({ proposal_id, action, comment }) => {
    try {
      const response = await ipcRequest({
        type: 'review_proposal',
        proposalId: proposal_id,
        action,
        comment,
        reviewedBy: SESSION_ID,
      });
      if (response.error) return { content: [{ type: 'text', text: `Error: ${response.error}` }] };
      let text = `Proposal #${proposal_id} ${action}d.`;
      if (action === 'approve' && response.taskId) {
        text += ` Created task #${response.taskId}.`;
      }
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// --- Session Cleanup Tools ---

server.tool(
  'close_session',
  'Close a worker session tab. Use to clean up finished workers and reduce clutter.',
  {
    session_id: z.string().describe('Session ID to close (e.g. worker-5)'),
  },
  async ({ session_id }) => {
    try {
      await ipcRequest({ type: 'close_session', sessionId: session_id });
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'closed', session_id }) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  'close_all_done',
  'Close all worker sessions that have status done/failed/exited. Bulk cleanup.',
  {},
  async () => {
    try {
      const response = await ipcRequest({ type: 'close_all_done' });
      return { content: [{ type: 'text', text: JSON.stringify({ closed: response.closed || [] }) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  }
);

// Start server
async function main() {
  try {
    connectToMainProcess();
  } catch (e) {
    process.stderr.write(`Failed to connect to main process: ${e.message}\n`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`Nexus MCP server started for session ${SESSION_ID}\n`);

  // Send heartbeat to main process every 10 seconds
  setInterval(() => {
    sendIpc({
      type: 'heartbeat',
      sessionId: SESSION_ID,
      timestamp: Date.now(),
    });
  }, 10000);
}

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err.message}\n`);
  process.exit(1);
});
