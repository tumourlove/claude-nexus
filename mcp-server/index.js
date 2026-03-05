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
const IPC_PATH = process.env.NEXUS_IPC_PATH || '\\\\.\\pipe\\claude-nexus-ipc';

const SESSION_TEMPLATE = process.env.NEXUS_TEMPLATE || 'implementer';

const TEMPLATE_TOOLS = {
  lead: null, // null = all tools allowed
  implementer: null, // workers get all tools
  researcher: new Set([
    'list_sessions', 'read_messages', 'report_result', 'wait_for_workers',
    'scratchpad_set', 'scratchpad_get', 'scratchpad_list', 'scratchpad_delete',
    'read_session_history', 'search_across_sessions', 'save_checkpoint',
  ]),
  reviewer: new Set([
    'list_sessions', 'send_message', 'read_messages', 'report_result',
    'scratchpad_set', 'scratchpad_get', 'scratchpad_list', 'scratchpad_delete',
    'read_session_history', 'search_across_sessions', 'save_checkpoint',
  ]),
  explorer: new Set([
    'list_sessions', 'read_messages', 'report_result',
    'read_session_history', 'search_across_sessions',
    'scratchpad_get', 'scratchpad_list',
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
  if (msg.type === 'message') {
    messageBus.send(msg.from, SESSION_ID, msg.message, msg.priority);
    // If it's a result message, collect it and wake any waiters
    if (msg.message && msg.message.startsWith('[RESULT ')) {
      pendingResults.push({ from: msg.from, message: msg.message, timestamp: Date.now() });
      for (const resolve of resultWaiters) resolve();
      resultWaiters = [];
    }
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

server.tool(
  'send_message',
  'Send a message to another Claude session',
  {
    target_session_id: z.string().describe('ID of the target session'),
    message: z.string().describe('Message content'),
    priority: z.enum(['normal', 'urgent']).default('normal').describe('Message priority'),
  },
  async ({ target_session_id, message, priority }) => {
    sendIpc({
      type: 'send_message',
      from: SESSION_ID,
      to: target_session_id,
      message,
      priority,
    });
    return {
      content: [{ type: 'text', text: `Message sent to ${target_session_id}` }],
    };
  }
);

server.tool(
  'read_messages',
  'Read incoming messages from other sessions',
  {
    since_timestamp: z.number().optional().describe('Only messages after this Unix timestamp (ms)'),
    limit: z.number().default(50).describe('Max messages to return'),
  },
  async ({ since_timestamp, limit }) => {
    const messages = messageBus.read(SESSION_ID, { sinceTimestamp: since_timestamp, limit });
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

// --- Session Management Tools ---

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
    sendIpc({
      type: 'spawn_session',
      from: SESSION_ID,
      working_directory,
      initial_prompt,
      label: label || 'Worker',
      template,
    });
    return {
      content: [{ type: 'text', text: `Session spawned: ${label || 'Worker'} in ${working_directory}` }],
    };
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
